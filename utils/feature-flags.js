/**
 * Feature flags, configured in .env. A flag is on unless its variable is set to
 * false / 0 / no / off; an unset variable falls back to the default below.
 * FF_ALL=false turns every feature off at once (the bot only stays connected).
 */
const FEATURES = {
    keywordResponses: { env: 'FF_KEYWORD_RESPONSES', default: true },
    welcomeMessage: { env: 'FF_WELCOME_MESSAGE', default: true },
    cityTransfer: { env: 'FF_CITY_TRANSFER', default: true },
    taxi: { env: 'FF_TAXI', default: true },
    driverRegistration: { env: 'FF_DRIVER_REGISTRATION', default: true },
    tideDaily: { env: 'FF_TIDE_DAILY', default: true },
    astronomyDaily: { env: 'FF_ASTRONOMY_DAILY', default: true },
    waveDaily: { env: 'FF_WAVE_DAILY', default: false }
};

const OFF_VALUES = ['false', '0', 'no', 'off'];

function parseFlag(envName, defaultValue) {
    const raw = process.env[envName];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    return !OFF_VALUES.includes(raw.trim().toLowerCase());
}

/**
 * @param {String} name - Key of FEATURES, e.g. 'taxi'
 * @returns {Boolean}
 */
function isFeatureEnabled(name) {
    const feature = FEATURES[name];
    if (!feature) throw new Error(`Unknown feature flag: ${name}`);
    if (!parseFlag('FF_ALL', true)) return false;
    return parseFlag(feature.env, feature.default);
}

/**
 * "keywordResponses: on, taxi: off, ..." for the startup log.
 */
function describeFeatureFlags() {
    return Object.keys(FEATURES)
        .map(name => `${name}: ${isFeatureEnabled(name) ? 'on' : 'off'}`)
        .join(', ');
}

module.exports = {
    FEATURES,
    isFeatureEnabled,
    describeFeatureFlags
};
