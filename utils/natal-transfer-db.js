const { PrismaClient } = require('@prisma/client');
const { createFileLogger } = require('./file-logger');
const logger = createFileLogger();

const prisma = new PrismaClient();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite';

const NATAL_KEYWORDS = ['Natal'];

function isNatalTransferMessage(message) {
  const lowerMsg = message.toLowerCase();
  return NATAL_KEYWORDS.some(keyword => lowerMsg.includes(keyword.toLowerCase()));
}

async function processNatalTransferMessage(sock, message, sender, groupId, incomingPushName) {
  try {
    // Handle the !natal command directly
    if (message.toLowerCase().trim() === '!natal') {
      await handleNatalCommand(sock, groupId);
      return true;
    }

    if (!isNatalTransferMessage(message)) {
      return false;
    }

    logger.info(`Detected potential Natal transfer message from ${sender}: ${message}`);

    const now = new Date();
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDateContext = `Today is ${weekdays[now.getDay()]}, ${now.toISOString().slice(0, 10)} (YYYY-MM-DD). Current time: ${now.toTimeString().slice(0, 5)} (local).`;

    const parsedRide = await askOpenRouter(currentDateContext, message);

    logger.info(`OpenRouter parsed response: ${parsedRide}`);

    if (parsedRide.includes('question intention')) {
      logger.info(`Detected question intention from ${sender}, not showing board`);
      return false;
    } else {
      try {
        const jsonMatch = parsedRide.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const rideInfo = JSON.parse(jsonMatch[0]);

          // Normalize direction
          if (rideInfo.direction.toLowerCase().includes('to airport') || rideInfo.direction.toLowerCase().includes('to natal')) {
              rideInfo.direction = 'toAirport';
          } else if (rideInfo.direction.toLowerCase().includes('from airport') || rideInfo.direction.toLowerCase().includes('from natal')) {
              rideInfo.direction = 'fromAirport';
          }

          let actualUserName = incomingPushName && incomingPushName.length > 0
            ? incomingPushName
            : 'Unknown User';

          if (!rideInfo.user || rideInfo.user === "User Name") {
            rideInfo.user = actualUserName;
          }

          delete rideInfo.phoneNumber;

          if (rideInfo.direction === 'toAirport' || rideInfo.direction === 'fromAirport') {
            // Get or create user
            const user = await prisma.user.upsert({
              where: { jid: sender },
              update: { name: rideInfo.user },
              create: {
                jid: sender,
                name: rideInfo.user
              }
            });

            // Create natal ride
            await prisma.natalRide.create({
              data: {
                direction: rideInfo.direction,
                datetime: new Date(rideInfo.datetime),
                originalMsg: rideInfo.original_msg || message,
                userId: user.id
              }
            });

            // Format direction for display
            const displayDirection = rideInfo.direction === 'toAirport' ? 'To Natal' : 'From Natal';

            // Confirm ride registration
            await sock.sendMessage(groupId, {
              text: `✅ @${sender.split('@')[0]}'s ride has been registered!\n\n*Direction:* ${displayDirection}\n*Date/Time:* ${formatDateTime(rideInfo.datetime)}\n\nPeople looking for similar rides will be able to find you. Type !natal to check all rides`,
              mentions: [sender]
            });

            logger.info(`Registered new ride from ${rideInfo.user}: ${displayDirection} on ${rideInfo.datetime}`);
            return true;
          } else {
              logger.warn(`Unknown ride direction parsed: ${rideInfo.direction}. Not saving ride.`);
              return false;
          }
        } else {
          logger.warn(`Failed to parse JSON from Tavily response: ${parsedRide}`);
          return false;
        }
      } catch (parseError) {
        logger.error(`Error parsing ride info from Tavily response: ${parseError}`);
        return false;
      }
    }
  } catch (error) {
    logger.error(`Error processing Natal transfer message: ${error}`);
    return false;
  }
}

async function askOpenRouter(currentDateContext, userMessage) {
  const systemPrompt = `You parse WhatsApp messages from a community group in Pipa, Brazil. People share rides to/from Natal (the nearest city with an airport).

${currentDateContext}

Your job: determine if the message is an OFFER (someone offering a ride) or a QUESTION (someone looking for a ride).

If it's an OFFER, reply ONLY with valid JSON (no markdown, no extra text):
{"user":"User Name","direction":"To Airport or From Airport","datetime":"YYYY-MM-DDTHH:MM:SS","original_msg":"original message"}

Rules for resolving dates:
- Use the current date above to resolve relative expressions like "today", "tomorrow", "next Monday", etc.
- If no year is mentioned, use the current year. If the resulting date has already passed, use next year.
- If no time is mentioned, use 00:00:00.
- "direction" must be either "To Airport" (Pipa → Natal) or "From Airport" (Natal → Pipa).

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

function formatDateTime(dateStr) {
  try {
    const date = new Date(dateStr);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[date.getDay()];

    return `${dayName}, ${date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })}`;
  } catch (error) {
    logger.error(`Error formatting date ${dateStr}: ${error}`);
    return dateStr;
  }
}

function displayUserName(ride) {
  if (ride.user && ride.user.name && ride.user.name !== "User Name" && ride.user.name.length > 0) {
    return ride.user.name;
  }
  return "Unknown User";
}

async function handleNatalCommand(sock, groupId) {
  try {
    // Cleanup is now handled by database queries (no old records returned)
    const now = new Date();

    // Get all future natal rides with user info
    const natalRides = await prisma.natalRide.findMany({
      where: {
        datetime: {
          gt: now
        }
      },
      include: {
        user: true
      },
      orderBy: {
        datetime: 'asc'
      }
    });

    // Separate by direction
    const toNatalRides = natalRides.filter(ride => ride.direction === 'toAirport');
    const fromNatalRides = natalRides.filter(ride => ride.direction === 'fromAirport');

    // Collect all user JIDs for mentions
    const mentions = [];

    // Construct the message
    let message = "*🚕 Upcoming Natal Rides*\n\n";

    // Add "From Pipa to Natal" rides
    if (toNatalRides.length > 0) {
      message += "*🏝 From Pipa to Natal:*\n";
      toNatalRides.forEach(ride => {
        if (ride.user && ride.user.jid) {
          message += `• ${formatDateTime(ride.datetime)} - @${ride.user.jid.split('@')[0]}\n`;
          mentions.push(ride.user.jid);
        } else {
          message += `• ${formatDateTime(ride.datetime)} - ${displayUserName(ride)}\n`;
        }
      });
      message += "\n";
    } else {
      message += "*🏝 From Pipa to Natal:* No upcoming rides\n\n";
    }

    // Add "From Natal to Pipa" rides
    if (fromNatalRides.length > 0) {
      message += "*🌆 From Natal to Pipa:*\n";
      fromNatalRides.forEach(ride => {
        if (ride.user && ride.user.jid) {
          message += `• ${formatDateTime(ride.datetime)} - @${ride.user.jid.split('@')[0]}\n`;
          mentions.push(ride.user.jid);
        } else {
          message += `• ${formatDateTime(ride.datetime)} - ${displayUserName(ride)}\n`;
        }
      });
    } else {
      message += "*🌆 From Natal to Pipa:* No upcoming rides";
    }

    message += "\n\nTo offer a ride, simply share your travel plans in the group.";
    message += "\nTo search for rides, use the !natal command";

    // Send the compiled message
    await sock.sendMessage(groupId, {
      text: message,
      mentions: mentions
    });
    logger.info(`Sent all upcoming rides to group: ${groupId}`);

    return true;
  } catch (error) {
    logger.error(`Error handling !natal command: ${error}`);
    return false;
  }
}

async function cleanupOldRides() {
  const oneDayAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));

  const deleted = await prisma.natalRide.deleteMany({
    where: {
      datetime: {
        lt: oneDayAgo
      }
    }
  });

  if (deleted.count > 0) {
    logger.info(`🧹 Cleaned up ${deleted.count} old natal rides`);
  }
}

async function initNatalTransfer() {
  logger.info('Natal transfer module initialized with database');
}

module.exports = {
  initNatalTransfer,
  processNatalTransferMessage,
  isNatalTransferMessage,
  handleNatalCommand,
  cleanupOldRides
};
