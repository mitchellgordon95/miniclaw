import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
  const route = meta.lastRoute || { channel: 'web' };

  switch (channel) {
    case 'web':
    case 'sms':
      // Reply to lastRoute (where the user last messaged from)
      if (route.channel === 'sms') {
        await sendSMS(route.from || loadConfig().twilio.allowFrom[0], content);
      }
      // Web is already handled via WebSocket broadcast
      break;
    case 'heartbeat':
      // Heartbeat just logs + broadcasts to web UI. Agent uses send-sms.sh if it wants to notify.
      break;
    case 'cron': {
      // Cron jobs use config-driven delivery
      const delivery = meta.delivery || 'none';
      const to = loadConfig().twilio.allowFrom[0];
      if (delivery === 'sms') {
        await sendSMS(to, content);
      } else if (delivery === 'sms-if-needed') {
        const skip = ['HEARTBEAT_OK', 'NOTHING_TO_REPORT'];
        if (!skip.includes(content.trim())) {
          await sendSMS(to, content);
        }
      }
      break;
    }
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

  // Extract MMS media attachments
  const numMedia = parseInt(req.body?.NumMedia || '0', 10);
  const media = [];
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = req.body?.[`MediaUrl${i}`];
    const contentType = req.body?.[`MediaContentType${i}`];
    if (mediaUrl) media.push({ url: mediaUrl, contentType });
  }

  return { valid: true, from, body: req.body?.Body || '', media };
}

/**
 * Download media from Twilio and transcribe audio using OpenAI Whisper.
 * Returns the transcript text or null.
 */
export async function transcribeTwilioAudio(mediaUrl, contentType) {
  const config = loadConfig();
  const openaiKey = config.env?.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error('[sms] No OPENAI_API_KEY configured for transcription');
    return null;
  }

  try {
    // Download audio from Twilio (requires Basic Auth)
    const authHeader = 'Basic ' + Buffer.from(
      `${config.twilio.accountSid}:${config.twilio.authToken}`
    ).toString('base64');

    const mediaRes = await fetch(mediaUrl, {
      headers: { Authorization: authHeader },
      redirect: 'follow',
    });
    if (!mediaRes.ok) {
      console.error(`[sms] Failed to download media: ${mediaRes.status}`);
      return null;
    }

    const audioBuffer = Buffer.from(await mediaRes.arrayBuffer());
    console.log(`[sms] Downloaded ${audioBuffer.length} bytes, content-type: ${contentType}`);
    const ext = contentType?.includes('mpeg') ? 'mp3'
      : contentType?.includes('ogg') ? 'ogg'
      : contentType?.includes('amr') ? 'amr'
      : contentType?.includes('mp3') ? 'mp3'
      : contentType?.includes('mp4') ? 'mp4'
      : contentType?.includes('wav') ? 'wav'
      : contentType?.includes('webm') ? 'webm'
      : 'mp3';

    // Write to temp file then read back as File for reliable FormData upload
    const tmpPath = join(tmpdir(), `voice-${Date.now()}.${ext}`);
    writeFileSync(tmpPath, audioBuffer);
    const fileBuffer = readFileSync(tmpPath);

    // Send to OpenAI
    const form = new FormData();
    const file = new File([fileBuffer], `voice.${ext}`, { type: contentType || 'audio/mpeg' });
    form.append('file', file);
    form.append('model', 'gpt-4o-transcribe');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: form,
    });

    if (!whisperRes.ok) {
      const errText = await whisperRes.text();
      console.error(`[sms] Whisper API error (${whisperRes.status}): ${errText}`);
      return null;
    }

    const result = await whisperRes.json();
    const transcript = result.text?.trim();
    console.log(`[sms] Transcribed audio: "${transcript}"`);
    return transcript || null;
  } catch (err) {
    console.error(`[sms] Transcription failed: ${err.message}`);
    return null;
  }
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
