const axios = require('axios');
const moment = require('moment-timezone');
require('dotenv').config();

/**
 * Fetch astronomy data for Pipa with retry functionality
 * @param {Number} maxRetries - Maximum number of retry attempts
 * @param {Number} delayMs - Delay between retries in milliseconds
 * @param {Number} longRetryDelayMs - Longer delay for special retry case in milliseconds
 * @returns {Promise<string>} Formatted astronomy data message
 */
async function getAstronomyData(maxRetries = 3, delayMs = 20000, longRetryDelayMs = 1800000) {
    let retryCount = 0;
    let lastError = null;

    // Retry logic
    while (retryCount <= maxRetries) {
        try {
            const now = moment().tz('America/Sao_Paulo');
            const dateFormatted = now.format('DD/MM/YYYY');

            const lat = -6.228056;
            const lon = -35.045833;
            const headers = { 'x-api-key': process.env.APIVERVE_API_KEY };

            const [sunResponse, moonRiseResponse, moonPhaseResponse] = await Promise.all([
                axios.get(`https://api.apiverve.com/v1/sunrisesunset?lat=${lat}&lon=${lon}`, { headers }),
                axios.get(`https://api.apiverve.com/v1/moonrisemoonset?lat=${lat}&lon=${lon}`, { headers }),
                axios.get('https://api.apiverve.com/v1/moonphases', { headers }),
            ]);

            const sunData = sunResponse.data.data;
            const moonRiseData = moonRiseResponse.data.data;
            const moonPhaseData = moonPhaseResponse.data.data;

            let message = `*☀️🌙✨ Astronomy Data for Praia de Pipa - ${dateFormatted} ✨*\n\n`;
            message += `_This is approximate data, gathered using APIVerve._\n\n`;

            // Sunrise and sunset
            if (sunData.sunrise && sunData.sunset) {
                const sunriseTime = moment.utc(sunData.sunrise).tz('America/Sao_Paulo').format('HH:mm');
                const sunsetTime = moment.utc(sunData.sunset).tz('America/Sao_Paulo').format('HH:mm');

                message += `*Sun:*\n`;
                message += `🌅 Sunrise: ${sunriseTime}\n`;
                message += `🌇 Sunset: ${sunsetTime}\n\n`;
            }

            // Variables to track special full moon message conditions
            let isFullMoon = false;
            let moonriseInSpecialTimeRange = false;
            let moonriseTime = '';

            // Moonrise and moonset
            if (moonRiseData.moonrise) {
                moonriseTime = moment.utc(moonRiseData.moonrise).tz('America/Sao_Paulo').format('HH:mm');
                const moonriseHour = parseInt(moonriseTime.split(':')[0]);

                let moonsetInfo = "";
                if (moonRiseData.moonset) {
                    const moonsetTime = moment.utc(moonRiseData.moonset).tz('America/Sao_Paulo').format('HH:mm');
                    moonsetInfo = `🌃 Moonset: ${moonsetTime}\n`;
                }

                const phaseName = moonPhaseData.phase || 'Unknown';
                const phaseEmoji = moonPhaseData.phaseEmoji || '🌙';

                // Check if it's a full moon
                isFullMoon = phaseName === 'Full Moon';
                // Check if moonrise is between 17:00-19:00
                moonriseInSpecialTimeRange = (moonriseHour >= 17 && moonriseHour < 19);

                message += `*Moon:*\n`;
                message += `🌜 Moonrise: ${moonriseTime}\n`;
                message += moonsetInfo;
                message += `🌙 Moon Phase: ${phaseName} ${phaseEmoji}\n`;

                if (moonPhaseData.illumination != null) {
                    message += `✨ Illumination: ${moonPhaseData.illumination.toFixed(0)}%\n`;
                }
            }

            // Check if we should add a special message for full moon at Chapadão
            if (isFullMoon && moonriseInSpecialTimeRange) {
                message += `\n\n*🌕 Special Event: Full Moon Rising! 🌕*\n`;
                message += `Good conditions for a nice Moonrise at Chapadão! Moon will be rising ${moonriseTime}. Grab a nice drink and a joint and head there!\n`;
            }

            return {
                message,
                isSpecialFullMoon: isFullMoon && moonriseInSpecialTimeRange
            };
        } catch (error) {
            lastError = error;
            retryCount++;
            
            console.error(`❌ Error fetching astronomy data (Attempt ${retryCount}/${maxRetries}):`, error.message);
            
            if (error.response) {
                console.log('Response error data:', error.response.data);
            }
            
            // If we've reached max retries, try one more time with a longer delay
            if (retryCount > maxRetries) {
                console.log(`All regular retries failed. Attempting one final retry in 30 minutes...`);
                await new Promise(resolve => setTimeout(resolve, longRetryDelayMs));
                try {
                    // One last attempt after long delay
                    const result = await getAstronomyData(0, 0); // No retries on this final attempt
                    return result;
                } catch (finalError) {
                    console.error('❌ Final retry attempt failed:', finalError.message);
                    break;
                }
            }
            
            // Wait before trying again
            console.log(`Waiting ${delayMs/1000} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    
    // If we got here, all retries failed
    console.error('❌ All retry attempts failed for astronomy data');
    return {
        message: "Could not retrieve astronomy data. Please try again later.",
        isSpecialFullMoon: false
    };
}

/**
 * Send astronomy data to a specific chat with retry logic
 * @param {Object} sock - WhatsApp socket connection
 * @param {String} chatId - Chat ID to send the message to
 * @param {Number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {Number} delayMs - Delay between retries in milliseconds (default: 20 seconds)
 * @param {Number} longRetryDelayMs - Longer delay for special retry case in milliseconds (default: 30 minutes)
 */
async function sendAstronomyDataOnce(sock, chatId, maxRetries = 3, delayMs = 20000, longRetryDelayMs = 1800000) {
    try {
        const result = await getAstronomyData(maxRetries, delayMs, longRetryDelayMs);
        // Keep the daily post free of link preview cards, same as the tide message
        await sock.sendMessage(chatId, { text: result.message, linkPreview: null });
        console.log('✅ Astronomy data sent successfully');
        
        // Log if it's a special full moon event
        if (result.isSpecialFullMoon) {
            console.log('✨ Special full moon event detected!');
        }
    } catch (error) {
        console.error('❌ Error sending astronomy data:', error);
    }
}

module.exports = {
    getAstronomyData,
    sendAstronomyDataOnce
};
