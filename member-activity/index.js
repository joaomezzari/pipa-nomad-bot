const { PrismaClient } = require('@prisma/client');
const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const { createFileLogger } = require('../utils/file-logger');

const prisma = new PrismaClient();
const logger = createFileLogger();

// The report groups members by inactivity, most inactive first; each member appears once
const TIERS = [90, 60, 30];
// Unit of the tiers: days (default) or seconds (for testing)
const UNIT = (process.env.INACTIVE_PERIOD_UNIT || 'days').trim().toLowerCase() === 'seconds'
  ? { name: 'seconds', ms: 1000 }
  : { name: 'days', ms: 24 * 60 * 60 * 1000 };

const INACTIVE_COMMAND = /^[!/]inactive$/i;

// Long reports are split to stay well below WhatsApp's message size limit
const MAX_MESSAGE_CHARS = 3500;

/**
 * Feature flag: tracking and the admin commands are off unless FF_INACTIVE_MEMBERS=true.
 */
function isInactiveMembersEnabled() {
  return (process.env.FF_INACTIVE_MEMBERS || '').trim().toLowerCase() === 'true';
}

/**
 * Admin IDs from ADMIN_IDS (comma-separated): a phone number with country code
 * (digits only, e.g. 5584999990000) or a full JID (e.g. 1234567890@lid).
 */
function getAdminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => id.includes('@') ? jidNormalizedUser(id) : `${id.replace(/\D/g, '')}@s.whatsapp.net`);
}

/**
 * All IDs WhatsApp attached to the sender of a message (phone JID and/or LID).
 */
function getSenderIds(message) {
  const key = message.key;
  return [key.participant || key.remoteJid, key.senderPn, key.senderLid, key.participantPn, key.participantLid]
    .filter(Boolean)
    .map(jidNormalizedUser);
}

async function addMembers(groupJid, userJids) {
  const { count } = await prisma.memberActivity.createMany({
    data: userJids.map(userJid => ({ groupJid, userJid: jidNormalizedUser(userJid) })),
    skipDuplicates: true
  });
  return count;
}

/**
 * Register the current members of every group, so members who never post are tracked
 * from the moment the bot first saw them. Safe to call on every reconnect.
 */
async function syncGroupMembers(sock, groupMap) {
  for (const [groupName, groupJid] of Object.entries(groupMap)) {
    if (!groupJid) continue;
    try {
      const { participants } = await sock.groupMetadata(groupJid);
      const count = await addMembers(groupJid, participants.map(participant => participant.id));
      logger.info(`👥 Group "${groupName}": ${participants.length} members, ${count} new`);
    } catch (error) {
      logger.error(`❌ Failed to sync members of group "${groupName}":`, error);
    }
  }
}

/**
 * Start tracking members who just joined a group.
 */
async function addGroupMembers(groupJid, participants) {
  try {
    await addMembers(groupJid, participants);
  } catch (error) {
    logger.error(`❌ Failed to add members of group ${groupJid}:`, error);
  }
}

/**
 * Remember that the sender of `message` has just posted in the group.
 */
async function recordMemberMessage(groupJid, message) {
  const userJid = jidNormalizedUser(message.key.participant || message.key.remoteJid);
  const timestamp = Number(message.messageTimestamp) || Math.floor(Date.now() / 1000);
  const sentAt = new Date(timestamp * 1000);
  const name = message.pushName || undefined;
  try {
    await prisma.memberActivity.upsert({
      where: { groupJid_userJid: { groupJid, userJid } },
      update: { lastMessageAt: sentAt, name },
      create: { groupJid, userJid, name, lastMessageAt: sentAt }
    });
  } catch (error) {
    logger.error(`❌ Failed to record activity of ${userJid} in ${groupJid}:`, error);
  }
}

/**
 * Report of the current members of a group grouped by inactivity (TIERS), most inactive first.
 * A member who never posted counts from the moment the bot first saw them.
 * The bot itself and the admins are left out.
 * @returns {Promise<Array<{text: String, mentions: Array<String>}>>} messages to send
 */
async function buildInactiveReport(sock, groupJid, groupName) {
  const { participants } = await sock.groupMetadata(groupJid);
  const excluded = new Set([sock.user?.id, sock.user?.lid, ...getAdminIds()].filter(Boolean).map(jidNormalizedUser));
  const memberIds = participants
    .filter(participant => ![participant.id, participant.jid, participant.lid]
      .filter(Boolean)
      .some(id => excluded.has(jidNormalizedUser(id))))
    .map(participant => jidNormalizedUser(participant.id));

  const rows = await prisma.memberActivity.findMany({ where: { groupJid, userJid: { in: memberIds } } });
  const rowByJid = new Map(rows.map(row => [row.userJid, row]));
  const now = Date.now();

  const members = memberIds
    .map(userJid => {
      const row = rowByJid.get(userJid);
      const lastActiveAt = row ? (row.lastMessageAt || row.firstSeenAt) : new Date();
      return { userJid, row, inactive: Math.floor((now - lastActiveAt.getTime()) / UNIT.ms) };
    })
    .filter(member => member.inactive >= TIERS[TIERS.length - 1])
    .sort((a, b) => b.inactive - a.inactive);

  const header = `👻 *${groupName}* · inactive members · ${members.length}`;
  if (members.length === 0) return [{ text: `${header}\n\nEveryone has posted in the last ${TIERS[TIERS.length - 1]} ${UNIT.name}. 🌴`, mentions: [] }];

  // Each member is a mention: WhatsApp shows the contact name and a tap opens the profile
  const lines = [];
  for (const tier of TIERS) {
    const inTier = members.filter(member => member.inactive >= tier && !member.listed);
    if (inTier.length === 0) continue;
    lines.push({ text: `\n*${tier}+ ${UNIT.name}* (${inTier.length})` });
    for (const member of inTier) {
      member.listed = true;
      const when = member.row?.lastMessageAt ? `${member.inactive} ${UNIT.name}` : 'never posted';
      lines.push({ text: `${lines.filter(line => line.mention).length + 1}. @${member.userJid.split('@')[0]} · ${when}`, mention: member.userJid });
    }
  }
  return splitMessage(header, lines);
}

/**
 * Split the report into messages that stay well below WhatsApp's size limit.
 * @returns {Array<{text: String, mentions: Array<String>}>}
 */
function splitMessage(header, lines) {
  const chunks = [];
  let current = { text: header + '\n', mentions: [] };
  for (const line of lines) {
    if (current.text.length + line.text.length + 1 > MAX_MESSAGE_CHARS) {
      chunks.push(current);
      current = { text: '', mentions: [] };
    }
    current.text += `\n${line.text}`;
    if (line.mention) current.mentions.push(line.mention);
  }
  chunks.push(current);
  return chunks;
}

/**
 * Handle "!inactive" sent in a private chat with the bot. Commands from anyone who is
 * not in ADMIN_IDS are ignored silently (logged).
 * @returns {Promise<boolean>} true if the message was an admin command (handled or ignored)
 */
async function handleAdminCommand(sock, message, text, groupMap) {
  if (!INACTIVE_COMMAND.test((text || '').trim()) || message.key.fromMe) return false;

  const chatJid = message.key.remoteJid;
  const adminIds = new Set(getAdminIds());
  if (!getSenderIds(message).some(id => adminIds.has(id))) {
    logger.warn(`⛔ Ignored admin command "${text.trim()}" from non-admin ${getSenderIds(message).join(', ')}`);
    return true;
  }

  for (const [groupName, groupJid] of Object.entries(groupMap)) {
    if (!groupJid) continue;
    let chunks;
    try {
      chunks = await buildInactiveReport(sock, groupJid, groupName);
    } catch (error) {
      logger.error(`❌ Failed to build inactive report for group "${groupName}":`, error);
      chunks = [{ text: `❌ ${groupName}: could not build the report (${error.message}).`, mentions: [] }];
    }
    for (const { text: chunkText, mentions } of chunks) {
      await sock.sendMessage(chatJid, { text: chunkText, mentions });
    }
  }
  logger.info(`👻 Sent inactive members report to admin ${chatJid}`);
  return true;
}

module.exports = {
  isInactiveMembersEnabled,
  syncGroupMembers,
  addGroupMembers,
  recordMemberMessage,
  handleAdminCommand
};
