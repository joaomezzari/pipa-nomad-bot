# Pipa DN Bot 🤖💬⚡
# 🌊🏡🚗🚨🚕🚌💻📶🛂💪🏖️😋📜📂👋
<center> <img width="495" alt="image" src="https://i.imgur.com/khO0FIq.png" /> </center>
Pipa DN Bot (`pipa-dn-bot.js`) is a WhatsApp bot built using the Baileys library. It provides automatic responses to keyword-based messages and sends daily updates with relevant information for the environment of Praia de Pipa to a designated WhatsApp group.

## WhatsApp Account Requirement

The bot requires a dedicated WhatsApp account to operate, as it emulates WhatsApp Web in the background. For our setup, we used a **Vivo Pre-Paid SIM card** with the local **DDD for Rio Grande do Norte (84)** to ensure a local Brazilian number. The account must remain active and connected for the bot to function properly.

## Features

- **Automatic Keyword Responses**: The bot monitors messages in a specified group and responds based on predefined keywords.
- **Daily Tide Data Updates**: Fetches and sends tide extremes data for Praia de Pipa at a scheduled time every day.
- **Daily Astronomical Data Updates**: Fetches and sends sun/moon rising and seting times
- **City Ride Share Scan**: Scans for ride-sharing messages mentioning **Natal**, **Recife**, or **João Pessoa**, parses them with LLM, and organizes them in a local agenda. Members can view upcoming rides with `!natal`, `!recife`, or `!jp`
- **Natal/Pipa Transfer On-Demand**: Members can request a scheduled Natal↔Pipa transfer directly via WhatsApp DM. Supports both directions (Natal→Pipa and Pipa→Natal), collects pickup date/time and address, and broadcasts the request to registered transfer drivers only. (Recife and João Pessoa on-demand transfers are planned)
- **Taxi & Mototaxi On-Demand**: Members can request a taxi or mototaxi directly via WhatsApp DM. The bot broadcasts the request to registered drivers, who can accept via DM. Fully independent module.
- **Driver Self-Registration**: Drivers (taxi or mototaxi) register themselves through a WhatsApp DM conversation with the bot. They provide name, phone, CPF, and vehicle type, and are stored in the database to receive ride broadcasts.
- **Throttling**: It throtlles messages in a timespam to prevent spammimg
- **Automatic Reconnection**: If the bot disconnects, it attempts to reconnect automatically.

## Screenshots
<img width="510" alt="2025-04-15 13_32_55-WhatsApp" src="https://github.com/user-attachments/assets/384da3c1-9770-4209-a9f0-82994892369c" />
<img width="495" alt="image" src="https://github.com/user-attachments/assets/ec771624-e533-4276-81bb-2c11a86b90dd" />

## Infrastructure Environment

The bot is running on a Google Cloud VM with the following specifications:

- **Instance Type**: e2-micro (2 vCPUs, 1 GB Memory)
- **Operating System**: Ubuntu Server 24.04  
- *Running environment:*
- **Node.js Version**: v20+
- **Process Manager**: PM2, running as the dedicated `pipabot` system user
- **Project Directory**: `/opt/pipa-dn-bot` (the code works from any directory)
- **Database**: PostgreSQL (managed via Prisma ORM)
- **Dependencies**:
  - `@whiskeysockets/baileys`
  - `moment-timezone`
  - `qrcode-terminal`
  - `@prisma/client` + `prisma`

## Installation

### Prerequisites

Ensure you have the following installed:
- [Node.js](https://nodejs.org/) 20+ and npm
- [pm2](https://pm2.keymetrics.io/) (`sudo npm install -g pm2`)
- [PostgreSQL](https://www.postgresql.org/) 14+

### PostgreSQL Setup

1. Install PostgreSQL (Ubuntu/Debian):
   ```sh
   sudo apt update
   sudo apt install postgresql postgresql-contrib
   sudo systemctl enable --now postgresql
   ```

2. Create the database and user:
   ```sh
   sudo -u postgres psql
   ```
   ```sql
   CREATE DATABASE "DNBot-DB";
   CREATE USER botuser WITH ENCRYPTED PASSWORD 'your_password';
   GRANT ALL PRIVILEGES ON DATABASE "DNBot-DB" TO botuser;
   \q
   ```

### Setup

1. Clone the repository (any location works, `/opt/pipa-dn-bot` is used in production):
   ```sh
   sudo mkdir /opt/pipa-dn-bot && sudo chown $USER /opt/pipa-dn-bot
   git clone git@github.com:nomads-pipa/bot.git /opt/pipa-dn-bot
   cd /opt/pipa-dn-bot
   ```

2. Create `.env` from `.env.example` and fill it in:
   - `DATABASE_URL`: PostgreSQL connection string, e.g. `postgresql://botuser:your_password@localhost:5432/DNBot-DB?schema=public`
   - `OPENROUTER_API_KEY`: for Natal/city transfer LLM parsing
   - `STORMGLASS_API_KEY`: for tide data
   - `APIVERVE_API_KEY`: for astronomical data
   - `GROUP_NAMES`: comma-separated WhatsApp group names to monitor

3. Run the setup script:
   ```sh
   sudo ./scripts/server-setup.sh
   ```
   It creates the `pipabot` user, sets permissions, installs dependencies, runs the
   database migrations, configures log rotation and starts the bot under pm2 with a
   boot service. It is safe to re-run.

4. On a brand-new WhatsApp session, scan the QR code printed in `logs/pm2-out.log`
   (WhatsApp > Linked devices). To move an existing session, stop the old bot and
   copy its `auth_info/` into the new directory **before** running the setup script.
   Never run two instances with the same session.

### Runtime files

| Path | Contents |
|------|----------|
| `auth_info/` | WhatsApp session (keep it secret, back it up) |
| `data/keywords.json` | Live keyword responses, seeded from `keywords.default.json` on first start |
| `logs/` | pm2 output and daily log files (`LOG_DIRECTORY` overrides the latter) |

### Deploying

Pushing to `main` triggers the GitHub Action, which SSHes into the server, runs
`git pull` and then `scripts/deploy.sh` (`npm ci`, migrations, pm2 reload). The
`APP_DIR` secret must point at the clone.

## Configuration

### Keywords

The bot responds to keywords stored in `data/keywords.json`. On first start it is
created from the tracked `keywords.default.json`; after that, edits made from the
WhatsApp group are saved there and are never touched by `git pull`. The format is:

```json
[
    {
        "keywords": ["surf", "onda"],
        "response": "🏄‍♂️ As ondas estão ótimas para surfar hoje!"
    },
    {
        "keywords": ["praia", "sol"],
        "response": "☀️ Aproveite o sol na Praia de Pipa!"
    }
]
```

## Taxi & Mototaxi Module

This is an independent module that handles on-demand ride requests directly via WhatsApp DM.

### Requesting a Ride (Passengers)

Members send a DM to the bot and go through a short conversation:
1. Select language (EN/PT)
2. Select vehicle type: **Taxi** or **Mototaxi**
3. Provide name, phone, pickup location, destination, and wait time
4. The bot broadcasts the request to all registered drivers of that type

### Driver Self-Registration

Drivers register by sending any of these messages to the bot DM:
- `sou motorista` / `cadastrar motorista` / `quero ser motorista`

The bot then collects:
1. Full name
2. Phone number with country code (e.g. `+55 84 9 1234-5678`)
3. CPF (validated with check digits)
4. Vehicle type: **Mototaxi** or **Taxi**

After confirmation, the driver is saved in the database and starts receiving ride broadcasts automatically. See `DRIVER_REGISTRATION.md` for the full flow.

## How It Works

1. The bot authenticates using multi-file authentication.
2. It connects to WhatsApp via Baileys.
3. It retrieves the group ID for `Pipa Digital Nomads`.
4. It listens for new messages in the group and checks for keyword matches.
5. If a keyword is detected, it sends the corresponding response.
6. It schedules and alerts (check features)..
7. If disconnected, it attempts to reconnect automatically.

## Logging & Debugging

- The bot logs events and errors in the console.
- If the bot does not reconnect, restart it manually.

## Contributing

Pull requests are welcome! Feel free to submit improvements or bug fixes.

---

### Contact
For inquiries, reach out to the maintainers at [Pipa Digital Nomads](https://github.com/nomads-pipa).

