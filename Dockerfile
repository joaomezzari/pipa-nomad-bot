# ---- Build stage: install dependencies and generate the Prisma client ----
FROM node:22-slim AS build

# git: Baileys pulls libsignal from GitHub; openssl: Prisma engines
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# package-lock.json references libsignal via git+ssh; fetch it over HTTPS instead (no SSH keys in the build)
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app

# The schema must be present before `npm ci`: the postinstall hook runs `prisma generate`.
# prisma.config.ts requires DATABASE_URL; generate does not connect, so a placeholder is enough
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npm ci --omit=dev

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LOG_TO_FILE=false \
    AUTH_DIR=/data/auth_info

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY . .

# /data holds the WhatsApp session and must be a persistent volume;
# /app/data holds the editable keywords.json copied from keywords.default.json on first start
RUN mkdir -p /data /app/data && chown node:node /data /app/data

# Run as the unprivileged user shipped with the official Node image
USER node

VOLUME ["/data"]

# Apply pending migrations, then start the bot
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node pipa-dn-bot.js"]
