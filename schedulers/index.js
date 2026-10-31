const moment = require('moment-timezone');
const { sendTideDataFromDbOnce, fetchAndSaveTideData } = require('../commands/tide');
const { sendAstronomyDataOnce } = require('../commands/astro');
const { sendWaveDataOnce } = require('../commands/wave');
const { sendGroupSummary } = require('../group-history');

let summaryIntervalId = null;

/**
 * Schedule the daily Stormglass fetch + DB save for tide extremes. Runs ahead of
 * scheduleTideData so the 04:00 group message can read from the DB instead of
 * calling the Stormglass API directly.
 * @param {String} time - Time to run the fetch+save (HH:MM format)
 */
function scheduleTideSave(time = '00:00') {
    setInterval(async () => {
        const now = moment().tz('America/Sao_Paulo');
        const currentTime = now.format('HH:mm');
        if (currentTime === time) {
            console.log("💾 Fetching and saving today's tide data...");
            try {
                await fetchAndSaveTideData();
            } catch (error) {
                console.error('❌ Error fetching/saving tide data:', error);
            }
        }
    }, 60 * 1000); // Check every minute
    console.log(`🕒 Tide save scheduler set for ${time} daily`);
}

/**
 * Schedule tide data message daily at specified time. Reads today's extremes from the
 * DB (populated by scheduleTideSave at midnight) instead of calling the Stormglass API.
 * @param {Object} sock - WhatsApp socket connection
 * @param {String} chatId - Chat ID to send the message to
 * @param {String} time - Time to send the message (HH:MM format)
 */
function scheduleTideData(sock, chatId, time = '04:00') {
    setInterval(async () => {
        const now = moment().tz('America/Sao_Paulo');
        const currentTime = now.format('HH:mm');
        if (currentTime === time) {
            console.log("📅 Sending scheduled tide data...");
            await sendTideDataFromDbOnce(sock, chatId);
        }
    }, 60 * 1000); // Check every minute
    console.log(`🕒 Tide data scheduler set for ${time} daily`);
}

/**
 * Schedule astronomy data message daily at specified time
 * @param {Object} sock - WhatsApp socket connection
 * @param {String} chatId - Chat ID to send the message to
 * @param {String} time - Time to send the message (HH:MM format)
 */
function scheduleAstronomyData(sock, chatId, time = '04:01') {
    setInterval(async () => {
        const now = moment().tz('America/Sao_Paulo');
        const currentTime = now.format('HH:mm');
        if (currentTime === time) {
            console.log("📅 Sending scheduled astronomy data...");
            await sendAstronomyDataOnce(sock, chatId);
        }
    }, 60 * 1000); // Check every minute
    
    console.log(`🕒 Astronomy data scheduler set for ${time} daily`);
}

/**
 * Schedule wave data message daily at specified time
 * @param {Object} sock - WhatsApp socket connection
 * @param {String} chatId - Chat ID to send the message to
 * @param {String} time - Time to send the message (HH:MM format)
 */
function scheduleWaveData(sock, chatId, time = '19:30') {
    setInterval(async () => {
        const now = moment().tz('America/Sao_Paulo');
        const currentTime = now.format('HH:mm');
        if (currentTime === time) {
            console.log("📅 Sending scheduled wave data...");
            await sendWaveDataOnce(sock, chatId);
        }
    }, 60 * 1000); // Check every minute
    
    console.log(`🕒 Wave data scheduler set for ${time} daily`);
}

/**
 * Schedule the daily summary of every monitored group. Safe to call again on every
 * reconnect: the previous timer is replaced.
 * @param {Object} sock - WhatsApp socket connection
 * @param {Object} groupMap - Group name -> group ID (null if not found)
 * @param {String} time - Time to post the summary (HH:MM format)
 */
function scheduleGroupSummary(sock, groupMap, time = '05:00') {
    if (summaryIntervalId) clearInterval(summaryIntervalId);
    summaryIntervalId = setInterval(async () => {
        const currentTime = moment().tz('America/Sao_Paulo').format('HH:mm');
        if (currentTime !== time) return;
        console.log('📅 Posting scheduled group summaries...');
        for (const [groupName, groupId] of Object.entries(groupMap)) {
            if (!groupId) continue;
            try {
                await sendGroupSummary(sock, groupName, groupId);
            } catch (error) {
                console.error(`❌ Error posting daily summary in group "${groupName}":`, error);
            }
        }
    }, 60 * 1000); // Check every minute
    console.log(`🕒 Group summary scheduler set for ${time} daily`);
}

/**
 * Set up all scheduled tasks
 * @param {Object} sock - WhatsApp socket connection 
 * @param {String} chatId - Chat ID to send messages to
 */
function setupSchedulers(sock, chatId) {
    // Setting all schedulers
    scheduleTideSave();
    scheduleTideData(sock, chatId);
    scheduleAstronomyData(sock, chatId);
    // scheduleWaveData(sock, chatId, '19:30');

    console.log('📆 All schedulers initialized successfully');
}

module.exports = {
    scheduleTideSave,
    scheduleTideData,
    scheduleAstronomyData,
    scheduleWaveData,
    scheduleGroupSummary,
    setupSchedulers
};
