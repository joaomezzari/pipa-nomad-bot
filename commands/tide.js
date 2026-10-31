const axios = require('axios');
const moment = require('moment-timezone');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

const PIPA_LAT = -6.228056;
const PIPA_LNG = -35.045833;

/**
 * Fetch today's tide extremes for Pipa directly from the Stormglass API, with retry logic.
 * @param {Number} maxRetries - Maximum number of retry attempts
 * @param {Number} delayMs - Delay between retries in milliseconds
 * @param {Number} longRetryDelayMs - Longer delay for special retry case in milliseconds
 * @returns {Promise<Array<{type: string, time: string, height: number}>>}
 */
async function fetchTideExtremesFromApi(maxRetries = 3, delayMs = 20000, longRetryDelayMs = 1800000) {
    let retryCount = 0;
    while (retryCount <= maxRetries) {
        try {
            const now = moment().tz('America/Sao_Paulo');
            const startDate = now.clone().startOf('day').utc().format('YYYY-MM-DDTHH:mm:ssZ');
            const endDate = now.clone().add(1, 'days').startOf('day').utc().format('YYYY-MM-DDTHH:mm:ssZ');

            const url = `https://api.stormglass.io/v2/tide/extremes/point?lat=${PIPA_LAT}&lng=${PIPA_LNG}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': process.env.STORMGLASS_API_KEY,
                },
            });
            return response.data.data;
        } catch (error) {
            retryCount++;

            console.error(`❌ Error fetching tide data (Attempt ${retryCount}/${maxRetries}):`, error.message);

            if (error.response) {
                console.log('Response error data:', error.response.data);
            }

            if (retryCount > maxRetries) {
                console.log(`All regular retries failed. Attempting one final retry in 30 minutes...`);
                await new Promise(resolve => setTimeout(resolve, longRetryDelayMs));
                return fetchTideExtremesFromApi(0, 0, longRetryDelayMs);
            }

            console.log(`Waiting ${delayMs / 1000} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    throw new Error('All retry attempts failed for tide data');
}

/**
 * UTC-midnight Date encoding a São Paulo calendar day, matching the DB's @db.Date column
 * (which drops the time component) regardless of the server process's local timezone.
 */
function dbDateFor(momentInSaoPaulo) {
    return new Date(`${momentInSaoPaulo.format('YYYY-MM-DD')}T00:00:00.000Z`);
}

/**
 * Replace the stored tide extremes for a given day.
 * @param {moment.Moment} momentInSaoPaulo - the calendar day (America/Sao_Paulo) the extremes belong to
 * @param {Array<{type: string, time: string, height: number}>} extremes
 */
async function saveTideExtremes(momentInSaoPaulo, extremes) {
    const date = dbDateFor(momentInSaoPaulo);

    await prisma.$transaction([
        prisma.tideExtreme.deleteMany({ where: { date } }),
        prisma.tideExtreme.createMany({
            data: extremes.map((tide) => ({
                date,
                type: tide.type,
                time: new Date(tide.time),
                height: tide.height,
            })),
        }),
    ]);
}

/**
 * Fetch today's tide extremes from Stormglass and persist them. Meant to run once daily
 * at midnight, ahead of the 04:00 group message.
 */
async function fetchAndSaveTideData() {
    const now = moment().tz('America/Sao_Paulo');
    const extremes = await fetchTideExtremesFromApi();
    await saveTideExtremes(now, extremes);
    console.log(`✅ Saved ${extremes.length} tide extremes for ${now.format('DD/MM/YYYY')}`);
    return extremes;
}

/**
 * Read today's tide extremes back out of the DB.
 * @param {moment.Moment} momentInSaoPaulo
 * @returns {Promise<Array<{type: string, time: Date, height: number}>>}
 */
async function getStoredTideExtremes(momentInSaoPaulo) {
    const date = dbDateFor(momentInSaoPaulo);
    return prisma.tideExtreme.findMany({ where: { date }, orderBy: { time: 'asc' } });
}

function formatTideMessage(dateFormatted, extremes) {
    let message = `*🌊🏄‍♂️🏖️🐬 Tide Extremes for Praia de Pipa - ${dateFormatted} ☀️*\n\n`;
    message += `_This is approximate data, gathered using https://stormglass.io/ API._\n\n`;
    extremes.forEach((tide) => {
        const timeUTC = moment.utc(tide.time);
        const timeSaoPaulo = timeUTC.tz('America/Sao_Paulo').format('HH:mm');
        message += `\n*${tide.type}*: ${timeSaoPaulo}, Height: ${Number(tide.height).toFixed(2)}m`;
    });
    return message;
}

/**
 * Build today's tide message from the DB (the 04:00 send path). Falls back to a live
 * Stormglass call if, for whatever reason, the midnight save job hasn't populated today's row yet.
 */
async function getTideMessageFromDb() {
    const now = moment().tz('America/Sao_Paulo');
    const dateFormatted = now.format('DD/MM/YYYY');

    let extremes = await getStoredTideExtremes(now);

    if (extremes.length === 0) {
        console.warn('⚠️ No tide extremes found in DB for today — falling back to a live Stormglass call');
        extremes = await fetchTideExtremesFromApi();
    }

    return formatTideMessage(dateFormatted, extremes);
}

/**
 * Send today's tide message (read from the DB) to a chat.
 */
async function sendTideDataFromDbOnce(sock, chatId) {
    try {
        const tideMessage = await getTideMessageFromDb();
        // The stormglass.io credit link would otherwise get a link preview card
        await sock.sendMessage(chatId, { text: tideMessage, linkPreview: null });
        console.log('✅ Tide data (from DB) sent successfully');
    } catch (error) {
        console.error('❌ Error sending tide data from DB:', error);
    }
}

module.exports = {
    fetchTideExtremesFromApi,
    saveTideExtremes,
    fetchAndSaveTideData,
    getStoredTideExtremes,
    formatTideMessage,
    getTideMessageFromDb,
    sendTideDataFromDbOnce,
};
