const { jidNormalizedUser } = require('@whiskeysockets/baileys');

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

/**
 * True if the sender of `message` is one of ADMIN_IDS.
 */
function isAdminMessage(message) {
    const adminIds = new Set(getAdminIds());
    return getSenderIds(message).some(id => adminIds.has(id));
}

module.exports = { getAdminIds, getSenderIds, isAdminMessage };
