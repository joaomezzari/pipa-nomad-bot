const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
require('dotenv').config();
const { LOG_DIR, FALLBACK_LOG_DIR } = require('./paths');

/**
 * Creates a logger that writes to both console and a log file
 * @param {string} [logDir] - Optional override for log directory, defaults to env variable or fallback path
 * @returns {Object} Logger object with log, info, error, and warn methods
 */
function createFileLogger(logDir) {
    // Get log directory from .env file or use default
    let logDirectory = logDir || LOG_DIR;
    
    // Ensure the log directory exists
    if (!fs.existsSync(logDirectory)) {
        try {
            fs.mkdirSync(logDirectory, { recursive: true });
        } catch (err) {
            console.error(`Failed to create log directory at ${logDirectory}:`, err);
            // Fall back to a directory that should be writable
            const fallbackDir = FALLBACK_LOG_DIR;
            console.warn(`Falling back to ${fallbackDir}`);
            if (!fs.existsSync(fallbackDir)) {
                fs.mkdirSync(fallbackDir, { recursive: true });
            }
            logDirectory = fallbackDir;
        }
    }
    
    // Cache for file handles to avoid constantly reopening files
    const fileHandles = {};
    
    // Generate filename based on current date
    const getLogFilePath = () => {
        const date = moment().format('YYYY-MM-DD');
        return path.join(logDirectory, `log-${date}.txt`);
    };
    
    /**
     * Write a message to both console and log file
     * @param {string} level - Log level (log, info, error, warn)
     * @param {...any} args - Arguments to log
     */
    const writeLog = (level, ...args) => {
        // Generate timestamp
        const timestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS');
        
        // Format the log message
        const logPrefix = `[${timestamp}] [${level.toUpperCase()}]`;
        const logMessage = args.map(arg => 
            typeof arg === 'object' && arg !== null ? JSON.stringify(arg, null, 2) : String(arg)
        ).join(' ');
        
        // Write to console
        if (level === 'error') {
            console.error(logPrefix, ...args);
        } else if (level === 'warn') {
            console.warn(logPrefix, ...args);
        } else if (level === 'info') {
            console.info(logPrefix, ...args);
        } else {
            console.log(logPrefix, ...args);
        }
        
        // Write to file with error handling
        const logFilePath = getLogFilePath();
        const fullMessage = `${logPrefix} ${logMessage}\n`;
        
        try {
            // Use fs.appendFile instead of appendFileSync for better performance
            fs.appendFileSync(logFilePath, fullMessage, { flag: 'a' });
        } catch (err) {
            console.error(`Failed to write to log file ${logFilePath}: ${err.message}`);
            
            // Try one more time with explicit file creation if needed
            try {
                // Ensure the directory exists (in case it was deleted)
                if (!fs.existsSync(logDirectory)) {
                    fs.mkdirSync(logDirectory, { recursive: true });
                }
                
                // Try with writeFileSync if append failed
                fs.writeFileSync(logFilePath, fullMessage, { flag: 'a' });
            } catch (retryErr) {
                console.error(`Second attempt to write to log file failed: ${retryErr.message}`);
            }
        }
    };
    
    // Clean up function to close any open file handles
    const cleanup = () => {
        Object.values(fileHandles).forEach(handle => {
            try {
                fs.closeSync(handle);
            } catch (err) {
                // Ignore close errors
            }
        });
    };
    
    // Register cleanup handlers
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
    });
    
    return {
        log: (...args) => writeLog('log', ...args),
        info: (...args) => writeLog('info', ...args),
        warn: (...args) => writeLog('warn', ...args),
        error: (...args) => writeLog('error', ...args),
        // Return the active log directory for reference
        getLogDirectory: () => logDirectory,
        // Expose cleanup for manual calling if needed
        cleanup
    };
}

module.exports = { createFileLogger };
