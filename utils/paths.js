const path = require('path');

// Every runtime path is anchored to the repo root, so the bot behaves the same
// no matter which directory it is started from.
const ROOT = path.resolve(__dirname, '..');

module.exports = {
    ROOT,
    AUTH_DIR: process.env.AUTH_DIR || path.join(ROOT, 'auth_info'),
    DATA_DIR: path.join(ROOT, 'data'),
    LOG_DIR: process.env.LOG_DIRECTORY || path.join(ROOT, 'logs', 'console-logs'),
    FALLBACK_LOG_DIR: path.join(ROOT, 'logs'),
};
