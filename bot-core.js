const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const moment = require('moment-timezone');
const qrcode = require('qrcode-terminal'); // Add this import
require('dotenv').config();

const {
    loadKeywordResponses,
    generateWelcomeMessage
} = require('./utils/keyword-manager');
const { setupSchedulers } = require('./schedulers');
const { createFileLogger } = require('./utils/file-logger');
const { initCityTransfer, processCityTransferMessage, isCityTransferMessage } = require('./utils/city-transfer-db');
const { initTaxiRide, processTaxiMessage } = require('./taxi-feature');
const { initDriverRegistration, processDriverRegistrationMessage } = require('./utils/taxi-drivers-register');
const { AUTH_DIR } = require('./utils/paths');
const { isFeatureEnabled, describeFeatureFlags } = require('./utils/feature-flags');

// Initialize our custom logger (will use LOG_DIRECTORY from .env if available)
const logger = createFileLogger();
logger.info(`Logger initialized. Writing logs to: ${logger.getLogDirectory()}`);

// Load keyword responses from the JSON file
let keywordResponseMap = loadKeywordResponses();

// Store recent responses with timestamps
const recentResponses = new Map();

// Throttle period in milliseconds (6 hours)
const THROTTLE_PERIOD = 6 * 60 * 60 * 1000;

// Group that receives the daily tide/astronomy/wave messages
const MAIN_GROUP_NAME = (process.env.MAIN_GROUP_NAME || 'Pipa Digital Nomads').trim();

// Messages we sent recently, so Baileys can re-encrypt and resend them when a
// recipient device fails to decrypt (otherwise they see "Waiting for this message")
const sentMessages = new Map();
const SENT_MESSAGES_MAX = 1000;
const SENT_MESSAGES_TTL = 24 * 60 * 60 * 1000;

// When a message can't be decrypted, Baileys waits 5 s and asks our own phone to resend
// it. If the session with the phone is out of sync, the phone's answer can't be decrypted
// either, which triggers another request, every 5 s for as long as the phone is online.
// Reporting every message as "already requested" turns that request off. A message we
// can't decrypt is then just missed, as it would be without the phone's copy anyway.
const noPhoneResendCache = {
    get: () => true,
    set: () => true,
    del: () => 0,
    flushAll: () => {}
};

function rememberSentMessage(id, message) {
    const now = Date.now();
    sentMessages.set(id, { message, ts: now });
    // Map keeps insertion order, so the oldest entries come first
    for (const [key, entry] of sentMessages) {
        if (sentMessages.size <= SENT_MESSAGES_MAX && now - entry.ts < SENT_MESSAGES_TTL) break;
        sentMessages.delete(key);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const pinoLogger = pino({ level: 'info' });

    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`Using WhatsApp Web version v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        auth: state,
        logger: pinoLogger,
        version,
        // Lets Baileys answer retry receipts by resending the original message
        getMessage: async (key) => {
            const message = sentMessages.get(key.id)?.message;
            logger.info(`🔁 Retry requested for message ${key.id}: ${message ? 'resending' : 'not in cache'}`);
            return message;
        },
        placeholderResendCache: noPhoneResendCache,
        // Remove this deprecated option
        // printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    // Our own sends come back as 'append' upserts
    sock.ev.on('messages.upsert', ({ messages }) => {
        for (const m of messages) {
            if (m.key.fromMe && m.key.id && m.message) {
                rememberSentMessage(m.key.id, m.message);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Handle QR code display
        if (qr) {
            console.log('📱 QR Code received. Please scan with your WhatsApp mobile app:');
            qrcode.generate(qr, { small: true });
            logger.info('QR Code displayed in terminal');
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            logger.error('Connection closed due to', lastDisconnect.error, ', reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            logger.info('✅ Connected successfully');
            logger.info(`🚩 Features: ${describeFeatureFlags()}`);

            // Initialize the city transfer module (Natal, Recife, João Pessoa)
            if (isFeatureEnabled('cityTransfer')) {
                await initCityTransfer();
                logger.info('✅ City transfer module initialized');
            }

            // Initialize the Taxi ride module
            if (isFeatureEnabled('taxi')) {
                await initTaxiRide(sock);
                logger.info('✅ Taxi ride module initialized');
            }

            // Initialize the Driver registration module
            if (isFeatureEnabled('driverRegistration')) {
                await initDriverRegistration();
                logger.info('✅ Driver registration module initialized');
            }

            // Get group names from environment variable
            const groupNames = getGroupNamesFromEnv();
            
            if (groupNames.length === 0) {
                logger.warn('⚠️ No group names found in GROUP_NAMES environment variable');
                return;
            }
            
            logger.info(`📋 Target groups: ${groupNames.join(', ')}`);
            
            // Map of group names to their IDs
            const groupMap = await getGroupIds(sock, groupNames);
            
            // Setup all scheduled tasks for each group
            for (const [groupName, groupId] of Object.entries(groupMap)) {
                if (groupId) {
                    logger.info(`✅ Group "${groupName}" found with ID: ${groupId}`);
                    
                    // Daily messages go to the main group only
                    if (groupName === MAIN_GROUP_NAME) {
                        setupSchedulers(sock, groupId);
                    }
                    
                    // Set up group participant handler for all groups
                    if (isFeatureEnabled('welcomeMessage')) {
                        setupGroupParticipantHandler(sock, groupId);
                    }
                } else {
                    logger.warn(`🚫 Group "${groupName}" not found`);
                }
            }

            // Set up message handler for all groups
            setupMessageHandler(sock, groupMap);
        } else if (connection === 'connecting') {
            logger.info('🔄 Connecting to WhatsApp...');
        }
    });

    return sock; // Return the socket instance
}

function getGroupNamesFromEnv() {
    // Get group names from environment variable and trim whitespace
    const groupNamesStr = process.env.GROUP_NAMES || '';
    
    if (!groupNamesStr) {
        return [];
    }
    
    return groupNamesStr.split(',').map(name => name.trim()).filter(name => name !== '');
}

async function getGroupIds(sock, groupNames) {
    const groupMap = {};
    
    try {
        const groupList = await sock.groupFetchAllParticipating();
        
        for (const groupName of groupNames) {
            let found = false;
            
            for (const groupId in groupList) {
                if (groupList[groupId].subject === groupName) {
                    groupMap[groupName] = groupId;
                    found = true;
                    break;
                }
            }
            
            if (!found) {
                groupMap[groupName] = null;
            }
        }
        
        return groupMap;
    } catch (err) {
        logger.error('❌ Error fetching group IDs:', err);
        return groupNames.reduce((acc, name) => {
            acc[name] = null;
            return acc;
        }, {});
    }
}

function setupGroupParticipantHandler(sock, groupId) {
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;

        // Check if the event is for one of our monitored groups
        if (id === groupId && (action === 'add')) {
            for (const participant of participants) {
                try {
                    // Generate welcome message
                    const welcomeMessage = generateWelcomeMessage(participant.split('@')[0]);

                    // Send welcome message mentioning the new participant
                    await sock.sendMessage(groupId, { 
                        text: welcomeMessage,
                        mentions: [participant]
                    });

                    logger.info(`✅ Sent welcome message to new participant: ${participant} in group: ${id}`);
                } catch (err) {
                    logger.error(`❌ Error sending welcome message to ${participant} in group ${id}:`, err);
                }
            }
        }
    });
}

function setupMessageHandler(sock, groupMap) {
    // Create a Set of group IDs for faster lookups
    const groupIds = new Set(Object.values(groupMap).filter(id => id !== null));

    // Store bot start time to ignore old messages on reconnection
    const botStartTime = Date.now();

    sock.ev.on('messages.upsert', async (msg) => {
        if (msg.type === 'notify') {
            for (const message of msg.messages) {
                const remoteJid = message.key.remoteJid;
                const sender = message.key.participant || message.key.remoteJid;

                // Skip messages from ourselves in groups (to prevent loops)
                // But allow self-messages in DMs for mototaxi testing
                const isPrivateMessage = !groupIds.has(remoteJid);
                if (message.key.fromMe && !isPrivateMessage) {
                    continue; // Skip self-messages only in groups
                }
                if (!message.message) continue;

                // Get message timestamp (in seconds, convert to milliseconds)
                const messageTimestamp = message.messageTimestamp
                    ? (typeof message.messageTimestamp === 'number'
                        ? message.messageTimestamp * 1000
                        : parseInt(message.messageTimestamp) * 1000)
                    : Date.now();

                // Skip messages that are older than when the bot started (replayed messages)
                // Allow a 10 second buffer for clock skew
                if (messageTimestamp < (botStartTime - 10000)) {
                    logger.info(`⏭️ Skipping old message from ${sender} (sent ${Math.round((botStartTime - messageTimestamp) / 1000)}s before bot start)`);
                    continue;
                }

                const messageContent = message.message.conversation ||
                                     message.message.extendedTextMessage?.text;

                // Check if this is a message from one of our monitored groups
                if (groupIds.has(remoteJid)) {
                    if (messageContent) {
                        // Find which group this is
                        const groupName = Object.keys(groupMap).find(name => groupMap[name] === remoteJid);
                        logger.info(`📩 Received message in group "${groupName}": ${messageContent}`);

                        // Check if this is a city transfer message (Natal, Recife, João Pessoa)
                        const pushName = message.pushName || '';
                        const isCityTransfer = isFeatureEnabled('cityTransfer') &&
                            await processCityTransferMessage(sock, messageContent, sender, remoteJid, pushName);

                        // If not a city transfer message, check for other keyword matches
                        if (!isCityTransfer && isFeatureEnabled('keywordResponses')) {
                            // Check for keyword matches
                            for (const { keywords, response } of keywordResponseMap) {
                                let matched = false;

                                // Check if any keyword matches
                                for (const keyword of keywords) {
                                    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
                                    if (regex.test(messageContent)) {
                                        matched = true;
                                        break;
                                    }
                                }

                                if (matched) {
                                    const now = Date.now();
                                    // Create a unique key for the response in this specific group
                                    const responseKey = `${remoteJid}:${response}`;

                                    // Check if this response was sent in the last 6 hours in this group
                                    if (recentResponses.has(responseKey)) {
                                        const lastSent = recentResponses.get(responseKey);
                                        const timeSince = now - lastSent;

                                        if (timeSince < THROTTLE_PERIOD) {
                                            // Skip if sent within the throttle period
                                            logger.info(`Not sending "${response}" to group "${groupName}" - last sent ${Math.round(timeSince / (60 * 1000))} minutes ago`);
                                            break;
                                        }
                                    }

                                    // Send response and record the current time
                                    await sock.sendMessage(remoteJid, { text: response });
                                    recentResponses.set(responseKey, now);
                                    logger.info(`🔍 Keyword matched in group "${groupName}"! Sent response: ${response}`);
                                    break;
                                }
                            }
                        }
                    }
                } else {
                    // This is a private message (not from a group)
                    logger.info(`📩 Received private message from ${sender}`);

                    // First, check if this is a driver registration message
                    const isRegistrationHandled = isFeatureEnabled('driverRegistration') &&
                        await processDriverRegistrationMessage(sock, message, sender);

                    // If not handled by registration, process as taxi conversation
                    if (!isRegistrationHandled && isFeatureEnabled('taxi')) {
                        await processTaxiMessage(sock, message, sender, null);
                    }
                }
            }
        }
    });
}

module.exports = { startBot };
