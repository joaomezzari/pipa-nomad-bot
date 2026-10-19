const { PrismaClient } = require('@prisma/client');
const { createFileLogger } = require('./file-logger');
const logger = createFileLogger();

const prisma = new PrismaClient();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite';

const CITY_CONFIGS = {
  natal: {
    cityKey: 'natal',
    cityName: 'Natal',
    keywords: ['natal'],
    command: '!natal',
    promptContext: 'People share rides to/from Natal (the nearest city with an airport, ~90km away).',
    toLabel: 'From Pipa to Natal',
    fromLabel: 'From Natal to Pipa',
    boardTitle: '🚕 Upcoming Natal Rides',
  },
  recife: {
    cityKey: 'recife',
    cityName: 'Recife',
    keywords: ['recife'],
    command: '!recife',
    promptContext: 'People share rides to/from Recife (~300km away).',
    toLabel: 'From Pipa to Recife',
    fromLabel: 'From Recife to Pipa',
    boardTitle: '🚕 Upcoming Recife Rides',
  },
  joao_pessoa: {
    cityKey: 'joao_pessoa',
    cityName: 'João Pessoa',
    keywords: ['joão pessoa', 'joao pessoa', 'jp'],
    command: '!jp',
    promptContext: 'People share rides to/from João Pessoa (~120km away).',
    toLabel: 'From Pipa to João Pessoa',
    fromLabel: 'From João Pessoa to Pipa',
    boardTitle: '🚕 Upcoming João Pessoa Rides',
  },
};

// Returns the city config if message matches any keyword, else null
function detectCity(message) {
  const lowerMsg = message.toLowerCase();
  for (const config of Object.values(CITY_CONFIGS)) {
    if (config.keywords.some(kw => lowerMsg.includes(kw.toLowerCase()))) {
      return config;
    }
  }
  return null;
}

function isCityTransferMessage(message) {
  return detectCity(message) !== null;
}

async function processCityTransferMessage(sock, message, sender, groupId, incomingPushName) {
  try {
    // Check for board commands
    for (const config of Object.values(CITY_CONFIGS)) {
      if (message.toLowerCase().trim() === config.command) {
        await handleCityCommand(sock, groupId, config);
        return true;
      }
    }

    const config = detectCity(message);
    if (!config) return false;

    logger.info(`Detected potential ${config.cityName} transfer message from ${sender}: ${message}`);

    const now = new Date();
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDateContext = `Today is ${weekdays[now.getDay()]}, ${now.toISOString().slice(0, 10)} (YYYY-MM-DD). Current time: ${now.toTimeString().slice(0, 5)} (local).`;

    const parsedRide = await askOpenRouter(currentDateContext, message, config);

    logger.info(`OpenRouter parsed response: ${parsedRide}`);

    if (parsedRide.includes('question intention')) {
      logger.info(`Detected question intention from ${sender}, not registering ride`);
      return false;
    }

    const jsonMatch = parsedRide.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`Failed to parse JSON from OpenRouter response: ${parsedRide}`);
      return false;
    }

    const rideInfo = JSON.parse(jsonMatch[0]);

    // Normalize direction
    const dirLower = rideInfo.direction.toLowerCase();
    if (dirLower.includes('to ') || dirLower.startsWith('to')) {
      rideInfo.direction = 'toCity';
    } else if (dirLower.includes('from ') || dirLower.startsWith('from')) {
      rideInfo.direction = 'fromCity';
    }

    if (rideInfo.direction !== 'toCity' && rideInfo.direction !== 'fromCity') {
      logger.warn(`Unknown direction parsed: ${rideInfo.direction}. Skipping.`);
      return false;
    }

    const actualUserName = (incomingPushName && incomingPushName.length > 0) ? incomingPushName : 'Unknown User';
    if (!rideInfo.user || rideInfo.user === 'User Name') {
      rideInfo.user = actualUserName;
    }

    const user = await prisma.user.upsert({
      where: { jid: sender },
      update: { name: rideInfo.user },
      create: { jid: sender, name: rideInfo.user }
    });

    await prisma.transferRide.create({
      data: {
        city: config.cityKey,
        direction: rideInfo.direction,
        datetime: new Date(rideInfo.datetime),
        originalMsg: rideInfo.original_msg || message,
        userId: user.id
      }
    });

    const displayDirection = rideInfo.direction === 'toCity'
      ? `To ${config.cityName}`
      : `From ${config.cityName}`;

    await sock.sendMessage(groupId, {
      text: `✅ @${sender.split('@')[0]}'s ride has been registered!\n\n*Direction:* ${displayDirection}\n*Date/Time:* ${formatDateTime(rideInfo.datetime)}\n\nPeople looking for similar rides will be able to find you. Type ${config.command} to check all rides`,
      mentions: [sender]
    });

    logger.info(`Registered new ride from ${rideInfo.user}: ${displayDirection} on ${rideInfo.datetime}`);
    return true;
  } catch (error) {
    logger.error(`Error processing city transfer message: ${error}`);
    return false;
  }
}

async function askOpenRouter(currentDateContext, userMessage, config) {
  const systemPrompt = `You parse WhatsApp messages from a community group in Pipa, Brazil. ${config.promptContext}

${currentDateContext}

Your job: determine if the message is an OFFER (someone offering a ride) or a QUESTION (someone looking for a ride).

If it's an OFFER, reply ONLY with valid JSON (no markdown, no extra text):
{"user":"User Name","direction":"To ${config.cityName} or From ${config.cityName}","datetime":"YYYY-MM-DDTHH:MM:SS","original_msg":"original message"}

Rules for resolving dates:
- Use the current date above to resolve relative expressions like "today", "tomorrow", "next Monday", etc.
- If no year is mentioned, use the current year. If the resulting date has already passed, use next year.
- If no time is mentioned, use 00:00:00.
- "direction" must be either "To ${config.cityName}" (Pipa → ${config.cityName}) or "From ${config.cityName}" (${config.cityName} → Pipa).

If it's a QUESTION (someone asking for a ride), reply with exactly: question intention`;

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://github.com/dn-pipa-whatsapp-bot',
      'X-Title': 'DN Pipa WhatsApp Bot'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errText}`);
  }

  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content?.trim() || '';
  logger.info(`OpenRouter raw answer: ${answer}`);
  return answer;
}

async function handleCityCommand(sock, groupId, config) {
  try {
    const now = new Date();

    const rides = await prisma.transferRide.findMany({
      where: {
        city: config.cityKey,
        datetime: { gt: now }
      },
      include: { user: true },
      orderBy: { datetime: 'asc' }
    });

    const toRides = rides.filter(r => r.direction === 'toCity');
    const fromRides = rides.filter(r => r.direction === 'fromCity');
    const mentions = [];

    let message = `*${config.boardTitle}*\n\n`;

    message += `*🏝 ${config.toLabel}:*\n`;
    if (toRides.length > 0) {
      toRides.forEach(ride => {
        if (ride.user?.jid) {
          message += `• ${formatDateTime(ride.datetime)} - @${ride.user.jid.split('@')[0]}\n`;
          mentions.push(ride.user.jid);
        } else {
          message += `• ${formatDateTime(ride.datetime)} - ${displayUserName(ride)}\n`;
        }
      });
    } else {
      message += `No upcoming rides\n`;
    }

    message += `\n*🌆 ${config.fromLabel}:*\n`;
    if (fromRides.length > 0) {
      fromRides.forEach(ride => {
        if (ride.user?.jid) {
          message += `• ${formatDateTime(ride.datetime)} - @${ride.user.jid.split('@')[0]}\n`;
          mentions.push(ride.user.jid);
        } else {
          message += `• ${formatDateTime(ride.datetime)} - ${displayUserName(ride)}\n`;
        }
      });
    } else {
      message += `No upcoming rides`;
    }

    message += `\n\nTo offer a ride, simply share your travel plans in the group.`;
    message += `\nTo search for rides, use the ${config.command} command`;

    await sock.sendMessage(groupId, { text: message, mentions });
    logger.info(`Sent ${config.cityName} board to group: ${groupId}`);
    return true;
  } catch (error) {
    logger.error(`Error handling ${config.command} command: ${error}`);
    return false;
  }
}

function formatDateTime(dateStr) {
  try {
    const date = new Date(dateStr);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${days[date.getDay()]}, ${date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })}`;
  } catch (error) {
    return dateStr;
  }
}

function displayUserName(ride) {
  if (ride.user?.name && ride.user.name !== 'User Name' && ride.user.name.length > 0) {
    return ride.user.name;
  }
  return 'Unknown User';
}

async function cleanupOldRides() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await prisma.transferRide.deleteMany({
    where: { datetime: { lt: oneDayAgo } }
  });
  if (deleted.count > 0) {
    logger.info(`🧹 Cleaned up ${deleted.count} old transfer rides`);
  }
}

async function initCityTransfer() {
  logger.info('City transfer module initialized');
}

module.exports = {
  initCityTransfer,
  processCityTransferMessage,
  isCityTransferMessage,
  cleanupOldRides,
  CITY_CONFIGS,
};
