#!/usr/bin/env bash
# Install deps, migrate the DB and reload the bot. Run as the deploy user after
# `git pull` (the GitHub Action does both over SSH). Pulling happens outside this
# script so bash never executes a file that git is rewriting.
set -euo pipefail

cd "$(dirname "$0")/.."
umask 002

npm ci
npm run db:migrate
sudo -u pipabot -H pm2 startOrReload ecosystem.config.js
sudo -u pipabot -H pm2 save
