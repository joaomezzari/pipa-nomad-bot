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

// Whole-word match so "jp" doesn't hit "jpg" and "natal" doesn't hit "Natália" or "prenatal"
function keywordRegex(keyword) {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u');
}

for (const config of Object.values(CITY_CONFIGS)) {
  config.keywordRegexes = config.keywords.map(keywordRegex);
}

// Returns the city config if message matches any keyword, else null
function detectCity(message) {
  const lowerMsg = message.toLowerCase();
  for (const config of Object.values(CITY_CONFIGS)) {
    if (config.keywordRegexes.some(re => re.test(lowerMsg))) {
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

    const jsonMatch = parsedRide.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`Failed to parse JSON from OpenRouter response: ${parsedRide}`);
      return false;
    }

    const rideInfo = JSON.parse(jsonMatch[0]);

    if (rideInfo.intent !== 'offer') {
      logger.info(`Message from ${sender} classified as "${rideInfo.intent}", not registering ride`);
      return false;
    }

    // Normalize direction
    const dirLower = (rideInfo.direction || '').toLowerCase();
    if (dirLower.startsWith('to')) {
      rideInfo.direction = 'toCity';
    } else if (dirLower.startsWith('from')) {
      rideInfo.direction = 'fromCity';
    }

    if (rideInfo.direction !== 'toCity' && rideInfo.direction !== 'fromCity') {
      logger.warn(`Unknown direction parsed: ${rideInfo.direction}. Skipping.`);
      return false;
    }

    // An offer without a resolvable, non-past date can't be shown on the board
    const rideDate = rideInfo.datetime ? new Date(rideInfo.datetime) : null;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!rideDate || isNaN(rideDate) || rideDate < startOfToday) {
      logger.info(`Offer from ${sender} has no usable date (${rideInfo.datetime}), not registering ride`);
      return false;
    }

    // The LLM can't know who sent the message, so always use the WhatsApp push name
    rideInfo.user = (incomingPushName && incomingPushName.length > 0) ? incomingPushName : 'Unknown User';

    const user = await prisma.user.upsert({
      where: { jid: sender },
      update: { name: rideInfo.user },
      create: { jid: sender, name: rideInfo.user }
    });

    await prisma.transferRide.create({
      data: {
        city: config.cityKey,
        direction: rideInfo.direction,
        datetime: rideDate,
        originalMsg: message,
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
  const city = config.cityName;
  const systemPrompt = `You classify WhatsApp messages from a community group in Pipa, Brazil. ${config.promptContext}
Messages may be in English or Portuguese. Every message you receive mentions ${city}, but most messages that mention ${city} are NOT about sharing a ride - people mention the city when talking about shopping, restaurants, doctors, events, banks, where to buy things, etc.

${currentDateContext}

Classify the message into exactly one intent:
- "offer": the SENDER is personally making an upcoming trip between Pipa and ${city} on a specific day ("I'm going", "I'm driving", "I'll take a taxi", "vou para ${city}"). They don't need to explicitly invite anyone: in this group, posting your trip is how you offer seats, often as a short reply to someone who asked (starting with an @mention), e.g. "going to ${city} tomorrow 4:30".
- "request": the sender is looking for a ride or asking if anyone is going ("anyone going to ${city}?", "alguém vai pra ${city}?", "I need a ride", "how do I get to the airport?").
- "other": anything else. This includes recommendations or info about places in ${city}, saying where something can be bought ("you can get it in ${city}"), news, events, taxi/transfer driver contacts, past trips, trips without a day, and any message where it's unclear that the sender themselves is making the trip.
When in doubt, choose "other".

Reply ONLY with valid JSON (no markdown, no extra text):
{"intent":"offer|request|other","direction":"To ${city}|From ${city}|null","datetime":"YYYY-MM-DDTHH:MM:SS or null"}

"direction" and "datetime" only matter for "offer"; use null otherwise.
- "direction": "To ${city}" (Pipa → ${city}) or "From ${city}" (${city} → Pipa).
- "datetime": use the current date above to resolve relative expressions like "today", "tomorrow", "next Monday", "amanhã", "sexta". If no year is mentioned, use the current year; if that date has already passed, use next year. If no time is mentioned, use 00:00:00. If no day can be determined at all, use null.

Examples:
"You can get it from ${city} at Gourmetum" → {"intent":"other","direction":null,"datetime":null}
"Is there a good dentist in ${city}?" → {"intent":"other","direction":null,"datetime":null}
"Anyone going to ${city} tomorrow?" → {"intent":"request","direction":null,"datetime":null}
"I went to ${city} yesterday, the traffic was awful" → {"intent":"other","direction":null,"datetime":null}
"going to ${city} tomorrow 4:30" → {"intent":"offer","direction":"To ${city}","datetime":"<tomorrow's date>T16:30:00"}
"@5584999999999 going from ${city} airport to Pipa Friday at 4:30 PM" → {"intent":"offer","direction":"From ${city}","datetime":"<Friday's date>T16:30:00"}
"Driving to ${city} on Friday at 9am, 2 free seats if anyone wants to join" → {"intent":"offer","direction":"To ${city}","datetime":"<Friday's date>T09:00:00"}
"Vou pegar um táxi de ${city} pra Pipa amanhã às 15h, alguém quer dividir?" → {"intent":"offer","direction":"From ${city}","datetime":"<tomorrow's date>T15:00:00"}`;

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
      temperature: 0,
      response_format: { type: 'json_object' }
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
