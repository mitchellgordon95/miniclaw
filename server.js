import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';

import { getSessionMessages, deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, ensureRuntimeDirs } from './lib/config.js';
import { sendMessage, abortCurrent, answerQuestion, events, getInitInfo, getSessionId, saveSessionId } from './lib/claude.js';
import { createHmac, timingSafeEqual } from 'crypto';
import { sendReply, sendSMS, validateTwilioWebhook, transcribeTwilioAudio, transcribeAudioBuffer, downloadTwilioImage, loadResendCreds, synthesizeSpeech } from './lib/channels.js';
import { startScheduler, stopScheduler, readCronRuns } from './lib/cron.js';
import { geminiQuery } from './lib/gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Init ---

const config = loadConfig();
ensureRuntimeDirs();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const startTime = Date.now();

// --- Last Route (where to auto-reply) ---

let lastRoute = { channel: 'web' };

// --- Channel metadata (persisted for history rendering) ---

const channelMetaPath = join(__dirname, 'data', 'channel-meta.json');
let channelMeta = {}; // { "ts:contentPrefix" -> channel }
try {
  if (existsSync(channelMetaPath)) {
    channelMeta = JSON.parse(readFileSync(channelMetaPath, 'utf8'));
  }
} catch { /* ignore */ }

function saveChannelMeta() {
  try { writeFileSync(channelMetaPath, JSON.stringify(channelMeta)); } catch { /* ignore */ }
}

function recordChannel(channel, content) {
  const key = content?.slice(0, 100) || '';
  channelMeta[key] = channel;
  // Prune old entries (keep last 500)
  const keys = Object.keys(channelMeta);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 500)) delete channelMeta[k];
  }
  saveChannelMeta();
}

// --- SMS PIN Auth ---

const smsAuth = new Map(); // phoneNumber -> { authenticatedAt }
const smsPending = new Map(); // phoneNumber -> { body, from, receivedAt }
const SMS_AUTH_TTL = 24 * 60 * 60 * 1000; // 24 hours

function isSmsAuthenticated(phoneNumber) {
  const entry = smsAuth.get(phoneNumber);
  if (!entry) return false;
  if (Date.now() - entry.authenticatedAt > SMS_AUTH_TTL) {
    smsAuth.delete(phoneNumber);
    return false;
  }
  return true;
}

// --- Auth ---

function checkAuth(req) {
  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.query.token;
  return token === config.auth.token;
}

// --- WebSocket ---

const clients = new Set();

wss.on('connection', (ws, req) => {
  // Tag the client's channel from the connect URL (?channel=phone). The web UI omits it and
  // defaults to 'web'. This both routes the model's responses back to the right client and tells
  // Wright which surface the message came from.
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    ws.channel = u.searchParams.get('channel') === 'phone' ? 'phone' : 'web';
  } catch { ws.channel = 'web'; }
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message' && msg.content) {
        await handleMessage(ws.channel, msg.content, { planMode: msg.planMode || false, effort: msg.effort });
      } else if (msg.type === 'stop') {
        const stopped = abortCurrent();
        if (stopped) console.log(`[${ws.channel}] Generation stopped by user`);
      } else if (msg.type === 'answer') {
        answerQuestion(msg.answers);
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (token !== config.auth.token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    const ch = ws.channel || 'web';
    // The web UI is the dashboard and sees every turn; a non-web client (the phone) only
    // receives streams for turns it originated, so chatting on the web never makes the phone
    // speak, and vice-versa.
    if (ch === 'web' || ch === currentTurnChannel) ws.send(msg);
  }
}

// --- Wire up Claude events to WebSocket broadcasts ---

let currentTurnContent = '';
let currentTurnChannel = 'web';

// --- Latency profiling ---
let turnStartMs = 0;      // set when a user message is handed to the SDK
let turnFirstDeltaMs = 0; // set on the first delta of the turn

events.on('delta', (text) => {
  if (turnStartMs && !turnFirstDeltaMs) {
    turnFirstDeltaMs = Date.now();
    console.log(`[timing] TTFT ${turnFirstDeltaMs - turnStartMs}ms`);
  }
  currentTurnContent += text;
  broadcast({ type: 'delta', text });
});

events.on('tool_start', (name, input) => {
  broadcast({ type: 'tool_start', name, input });
});

events.on('tool_result', (output) => {
  broadcast({ type: 'tool_result', output });
});

events.on('plan', (content) => {
  broadcast({ type: 'plan', content });
});

events.on('status', (status) => {
  broadcast({ type: 'status', status });
});

events.on('agent_start', (id, description) => {
  broadcast({ type: 'agent_start', id, description });
});

events.on('agent_done', (id, description) => {
  broadcast({ type: 'agent_done', id, description });
});

events.on('ask_user', (questions) => {
  broadcast({ type: 'ask_user', questions });
});

events.on('turn_end', async (content) => {
  const fullResponse = content || currentTurnContent;
  const channel = currentTurnChannel;

  if (turnStartMs) {
    const total = Date.now() - turnStartMs;
    const ttft = turnFirstDeltaMs ? turnFirstDeltaMs - turnStartMs : null;
    console.log(`[timing] turn total ${total}ms (TTFT ${ttft === null ? 'n/a' : ttft + 'ms'}, channel ${channel}, ${fullResponse.length} chars)`);
    turnStartMs = 0;
    turnFirstDeltaMs = 0;
  }

  broadcast({ type: 'typing', active: false });
  broadcast({ type: 'stream_end', channel, content: fullResponse });

  // Route response to originating channel
  try {
    await sendReply(channel, fullResponse, { lastRoute });
  } catch (err) {
    console.error('[claude] sendReply error:', err.message);
  }

  currentTurnContent = '';
});

events.on('abort', () => {
  broadcast({ type: 'typing', active: false });
  broadcast({ type: 'stream_end', channel: currentTurnChannel, content: currentTurnContent });
  currentTurnContent = '';
});

events.on('error', (message) => {
  broadcast({ type: 'typing', active: false });
  broadcast({ type: 'stream_end', channel: 'web', content: `Error: ${message}` });
  currentTurnContent = '';
});

// --- HTTP Routes ---

app.use(express.urlencoded({ extended: false }));
app.use(express.json({
  limit: '25mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.static(join(__dirname, 'public')));

// --- File Uploads ---

const uploadsDir = join(config.workspacePath, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

function sanitizeFilename(name) {
  // Keep base + extension, strip path separators and weird chars
  const base = (name || 'upload').split(/[\\/]/).pop();
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'upload';
}

app.post('/api/upload', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { filename, contentBase64 } = req.body || {};
  if (!filename || !contentBase64) {
    return res.status(400).json({ error: 'filename and contentBase64 required' });
  }
  try {
    const buf = Buffer.from(contentBase64, 'base64');
    if (buf.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'file too large (>25mb)' });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = sanitizeFilename(filename);
    const saved = `${ts}-${safe}`;
    const fullPath = join(uploadsDir, saved);
    await writeFile(fullPath, buf);
    res.json({
      ok: true,
      path: fullPath,
      relativePath: `uploads/${saved}`,
      size: buf.length,
      originalName: filename,
    });
  } catch (err) {
    console.error('[upload] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/transcribe', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { audioBase64, mimeType } = req.body || {};
  if (!audioBase64) {
    return res.status(400).json({ error: 'audioBase64 required' });
  }
  try {
    const buf = Buffer.from(audioBase64, 'base64');
    if (buf.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'audio too large (>25mb)' });
    }
    const ct = mimeType || 'audio/webm';
    const ext = ct.includes('ogg') ? 'ogg'
      : ct.includes('mp4') ? 'mp4'
      : ct.includes('mpeg') || ct.includes('mp3') ? 'mp3'
      : ct.includes('wav') ? 'wav'
      : 'webm';
    const transcript = await transcribeAudioBuffer(buf, ext, ct);
    if (transcript === null) {
      return res.status(502).json({ error: 'transcription failed (check OPENAI_API_KEY / logs)' });
    }
    res.json({ ok: true, text: transcript });
  } catch (err) {
    console.error('[transcribe] endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tts', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { text, voice } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text required' });
  }
  if (text.length > 4000) {
    return res.status(413).json({ error: 'text too long (>4000 chars)' });
  }
  try {
    const audio = await synthesizeSpeech(text, voice || 'alloy');
    if (audio === null) {
      return res.status(502).json({ error: 'tts failed (check OPENAI_API_KEY / logs)' });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.send(audio);
  } catch (err) {
    console.error('[tts] endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify a Resend (svix) webhook signature against the raw body.
function verifyResendWebhook(secret, headers, rawBody) {
  const id = headers['svix-id'];
  const ts = headers['svix-timestamp'];
  const sigHeader = headers['svix-signature'];
  if (!id || !ts || !sigHeader) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const expBuf = Buffer.from(expected);
  // Header may carry multiple space-separated "v1,<sig>" values
  return sigHeader.split(' ').some((part) => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    const sigBuf = Buffer.from(sig);
    return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  });
}

// Inbound email from Resend: a reply from Mitchell becomes a task for Wright.
app.post('/api/email/inbound', async (req, res) => {
  const creds = loadResendCreds();
  if (!creds?.api_key) return res.status(500).send('resend not configured');

  // Signature check (skip only if no secret configured yet)
  if (creds.webhook_secret &&
      !verifyResendWebhook(creds.webhook_secret, req.headers, req.rawBody || '')) {
    console.log('[email] inbound rejected: bad signature');
    return res.status(401).send('bad signature');
  }

  const evt = req.body;
  if (evt?.type !== 'email.received') return res.json({ ok: true, ignored: 'type' });

  const data = evt.data || {};
  const from = (Array.isArray(data.from) ? data.from[0] : data.from) || '';
  // Allowlist: only act on mail from Mitchell himself
  const allow = creds.allow_from || [];
  if (!allow.some((a) => from.toLowerCase().includes(a.toLowerCase()))) {
    console.log(`[email] ignoring inbound from ${from}`);
    return res.json({ ok: true, ignored: 'sender' });
  }

  res.json({ ok: true }); // ack fast; process async

  try {
    const r = await fetch(`https://api.resend.com/emails/receiving/${data.email_id}`, {
      headers: { Authorization: `Bearer ${creds.api_key}`, 'User-Agent': 'miniclaw/1.0' },
    });
    if (!r.ok) {
      console.error(`[email] retrieve failed (${r.status}): ${await r.text()}`);
      return;
    }
    const full = await r.json();
    let text = (full.text || '').trim();
    if (!text && full.html) text = full.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) { console.log('[email] inbound had no body'); return; }
    // Strip quoted reply history (everything from the first quote marker on)
    text = text.split(/\n\s*On .+ wrote:/)[0].split(/\n>/)[0].trim();

    console.log(`[email] inbound task from ${from}: "${text.slice(0, 80)}"`);
    await handleMessage('email', text, { from, subject: data.subject });
  } catch (err) {
    console.error('[email] inbound processing error:', err.message);
  }
});

app.get('/api/messages', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const sessionId = req.query.sessionId || getSessionId();
  if (!sessionId) return res.json({ messages: [], total: 0, offset: 0 });

  try {
    const all = await getSessionMessages(sessionId, { dir: config.workspacePath });
    const total = all.length;
    const limit = parseInt(req.query.limit) || 50;

    let slice, offset;
    if (req.query.offset !== undefined) {
      const end = Math.max(0, parseInt(req.query.offset));
      const start = Math.max(0, end - limit);
      slice = all.slice(start, end);
      offset = start;
    } else {
      offset = Math.max(0, total - limit);
      slice = all.slice(offset);
    }

    // Attach channel metadata to user messages
    for (const msg of slice) {
      if (msg.type === 'user') {
        const content = typeof msg.message?.content === 'string'
          ? msg.message.content
          : Array.isArray(msg.message?.content)
            ? msg.message.content.find(b => b.type === 'text')?.text || ''
            : '';
        const key = content.slice(0, 100);
        if (channelMeta[key]) {
          msg._channel = channelMeta[key];
        }
      }
    }

    res.json({ messages: slice, total, offset });
  } catch (err) {
    console.error('[api] Failed to read session:', err.message);
    res.json({ messages: [], total: 0, offset: 0 });
  }
});

app.post('/api/clear', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  abortCurrent();
  const sessionId = getSessionId();
  if (sessionId) {
    try {
      await deleteSession(sessionId, { dir: config.workspacePath });
    } catch (err) {
      console.error('[api] deleteSession error:', err.message);
    }
    saveSessionId('');
  }
  res.json({ ok: true });
});

app.post('/twilio-sms/webhook', async (req, res) => {
  const result = validateTwilioWebhook(req);
  if (!result.valid) {
    console.log(`[sms] Rejected: ${result.reason}`);
    return res.status(403).send('');
  }

  // Respond immediately with empty TwiML (we reply async via API)
  res.type('text/xml').send('<Response/>');

  // Process media attachments
  let messageBody = result.body;
  let imageBlocks = []; // Anthropic image content blocks

  if (result.media && result.media.length > 0) {
    const audioMedia = result.media.find(m =>
      m.contentType?.startsWith('audio/') || m.contentType?.includes('ogg')
    );
    const imageMedia = result.media.filter(m =>
      m.contentType?.startsWith('image/')
    );

    // Transcribe audio if body is empty
    if (!messageBody.trim() && audioMedia) {
      console.log(`[sms] Voice message detected (${audioMedia.contentType}), transcribing...`);
      const transcript = await transcribeTwilioAudio(audioMedia.url, audioMedia.contentType);
      if (transcript) {
        messageBody = transcript;
        await sendSMS(result.from, `Heard: "${transcript}"`);
      } else {
        await sendSMS(result.from, 'Could not transcribe voice message. Try again or send text.');
        return;
      }
    }

    // Download images
    for (const img of imageMedia) {
      console.log(`[sms] Image attachment detected (${img.contentType}), downloading...`);
      const downloaded = await downloadTwilioImage(img.url, img.contentType);
      if (downloaded) {
        imageBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: downloaded.mediaType,
            data: downloaded.base64,
          },
        });
      }
    }
  }

  // Build content (string or content block array)
  let content;
  if (imageBlocks.length > 0) {
    content = [
      ...imageBlocks,
      { type: 'text', text: messageBody || 'What is this?' },
    ];
  } else {
    content = messageBody;
  }

  // PIN gate
  if (config.twilio.pin && !isSmsAuthenticated(result.from)) {
    if (messageBody.trim() === config.twilio.pin) {
      smsAuth.set(result.from, { authenticatedAt: Date.now() });
      const pending = smsPending.get(result.from);
      smsPending.delete(result.from);
      if (pending) {
        await sendSMS(result.from, 'Authenticated. Processing your message.');
        console.log(`[sms] PIN accepted from ${result.from}, replaying queued message`);
        try {
          await handleMessage('sms', pending.content, { from: result.from });
        } catch (err) {
          console.error('[sms] Error handling queued message:', err.message);
        }
      } else {
        await sendSMS(result.from, 'Authenticated.');
        console.log(`[sms] PIN accepted from ${result.from}`);
      }
    } else {
      smsPending.set(result.from, { body: messageBody, content, from: result.from, receivedAt: Date.now() });
      await sendSMS(result.from, 'PIN required. Your message has been saved and will be sent after auth.');
      console.log(`[sms] PIN required for ${result.from}, message queued`);
    }
    return;
  }

  try {
    await handleMessage('sms', content, { from: result.from });
  } catch (err) {
    console.error('[sms] Error handling message:', err.message);
  }
});

app.get('/api/cron/runs', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const limit = parseInt(req.query.limit) || 50;
  res.json(readCronRuns(limit));
});


app.get('/api/status', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const init = getInitInfo();
  res.json({
    model: init.model,
    apiKeySource: init.apiKeySource,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    sessionId: getSessionId(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// --- Core Orchestration ---

async function handleMessage(channel, content, meta = {}) {
  const isUserFacing = channel === 'web' || channel === 'sms' || channel === 'phone';

  // Extract text for display/recording (content may be string or content block array)
  const displayText = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '(image)'
      : String(content);
  const hasImages = Array.isArray(content) && content.some(b => b.type === 'image');

  // Track last route for user-initiated channels
  if (channel === 'sms') {
    lastRoute = { channel: 'sms', from: meta.from };
  } else if (channel === 'web') {
    lastRoute = { channel: 'web' };
  } else if (channel === 'phone') {
    lastRoute = { channel: 'phone' };
  } else if (channel === 'email') {
    lastRoute = { channel: 'email', from: meta.from, subject: meta.subject };
  }

  // /gemini intercept: forward verbatim to Gemini, never touches Anthropic SDK or session history.
  const trimmed = displayText.trim();
  if (trimmed === '/gemini' || trimmed.startsWith('/gemini ')) {
    const prompt = trimmed.slice('/gemini'.length).trim();
    if (!prompt) {
      const help = 'Usage: /gemini <your prompt>\nForwards verbatim to Gemini. No Anthropic context, no history.';
      if (isUserFacing) {
        broadcast({ type: 'typing', active: false });
        broadcast({ type: 'stream_end', channel, content: help });
      }
      await sendReply(channel, help, { lastRoute });
      return;
    }

    if (isUserFacing) {
      broadcast({
        type: 'message',
        role: 'user',
        channel,
        content: displayText,
        hasImages: false,
        ts: new Date().toISOString(),
      });
      broadcast({ type: 'typing', active: true });
    }

    try {
      const response = await geminiQuery(prompt);
      if (isUserFacing) {
        broadcast({ type: 'typing', active: false });
        broadcast({ type: 'stream_end', channel, content: response });
      }
      await sendReply(channel, response, { lastRoute });
    } catch (err) {
      console.error('[gemini] error:', err.message);
      const msg = `Gemini error: ${err.message}`;
      if (isUserFacing) {
        broadcast({ type: 'typing', active: false });
        broadcast({ type: 'stream_end', channel, content: msg });
      }
      await sendReply(channel, msg, { lastRoute });
    }
    return;
  }

  // Track current turn channel for routing responses
  currentTurnChannel = channel;
  currentTurnContent = '';

  // Record channel for history rendering
  if (channel === 'sms' || channel === 'web' || channel === 'phone') {
    recordChannel(channel, displayText);
  }

  // Show typing indicator immediately for responsiveness
  if (isUserFacing) {
    broadcast({ type: 'typing', active: true });
  }

  // Reasoning effort: caller-provided (the LP3 voice app sends 'low' for speed), overridden
  // to 'high' when the user explicitly asks the model to think harder.
  let effort = meta.effort || null;
  if (/\b(think hard|think harder|think carefully|think deeply|deep think|take your time|ultrathink|reason carefully)\b/i.test(displayText)) {
    effort = 'high';
  }

  // Push message into the persistent session, then broadcast to UI
  turnStartMs = Date.now();
  turnFirstDeltaMs = 0;
  try {
    await sendMessage(content, {
      channel,
      planMode: meta.planMode || false,
      model: meta.model || null,
      effort,
    });
    // Broadcast user message only after SDK has persisted it
    if (isUserFacing) {
      broadcast({
        type: 'message',
        role: 'user',
        channel,
        content: displayText,
        hasImages,
        ts: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error(`[claude] Error:`, err.message);
    if (isUserFacing) {
      broadcast({ type: 'typing', active: false });
      broadcast({ type: 'stream_end', channel, content: `Error: ${err.message}` });
    }
  }
}

// --- Start ---

startScheduler();

server.listen(config.port, () => {
  console.log(`[miniclaw] Listening on port ${config.port}`);
  console.log(`[miniclaw] Workspace: ${config.workspacePath}`);
});

// --- Graceful Shutdown ---

function shutdown(signal) {
  console.log(`[miniclaw] ${signal} received, shutting down...`);
  stopScheduler();
  abortCurrent();
  server.close(() => {
    console.log('[miniclaw] Server closed');
    process.exit(0);
  });
  // Force exit after 30s
  setTimeout(() => process.exit(1), 30000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
