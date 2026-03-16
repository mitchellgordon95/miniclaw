import twilio from 'twilio';
import { loadConfig } from './config.js';

let _client = null;

function getTwilioClient() {
  if (_client) return _client;
  const config = loadConfig();
  _client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _client;
}

/**
 * Send a reply back to the originating channel.
 */
export async function sendReply(channel, content, meta = {}) {
  switch (channel) {
    case 'web':
      // Already handled via WebSocket broadcast in server.js
      break;
    case 'sms':
      await sendSMS(meta.from || loadConfig().twilio.allowFrom[0], content);
      break;
    case 'heartbeat':
    case 'cron':
      // Only send SMS if the response indicates something actionable
      if (content.trim() !== 'HEARTBEAT_OK') {
        await sendSMS(loadConfig().twilio.allowFrom[0], content);
      }
      break;
  }
}

/**
 * Send an SMS, splitting long messages at sentence boundaries.
 */
export async function sendSMS(to, content) {
  const config = loadConfig();
  const client = getTwilioClient();
  const chunks = splitMessage(content, 1600);

  for (const chunk of chunks) {
    await client.messages.create({
      body: chunk,
      from: config.twilio.phoneNumber,
      to,
    });
  }
}

/**
 * Validate incoming Twilio webhook request.
 * Returns { valid, from, body } or { valid: false }.
 */
export function validateTwilioWebhook(req) {
  const config = loadConfig();

  // Validate Twilio signature
  const signature = req.headers['x-twilio-signature'] || '';
  const url = config.twilio.webhookUrl;
  const valid = twilio.validateRequest(
    config.twilio.authToken,
    signature,
    url,
    req.body || {}
  );

  if (!valid) return { valid: false, reason: 'invalid signature' };

  const from = req.body?.From;
  if (!config.twilio.allowFrom.includes(from)) {
    return { valid: false, reason: 'unauthorized number' };
  }

  return { valid: true, from, body: req.body?.Body || '' };
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt === -1) {
      splitAt = maxLen;
    } else {
      splitAt += 1; // Include the space/period
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
