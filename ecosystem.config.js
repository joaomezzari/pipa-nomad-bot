const path = require('path');

// pm2 config. Paths are relative to this file, so the repo can live anywhere.
module.exports = {
  apps: [
    {
      name: 'pipa-dn-bot',
      script: 'pipa-dn-bot.js',
      cwd: __dirname,
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
