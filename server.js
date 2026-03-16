import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig, ensureRuntimeDirs } from './lib/config.js';
import { runClaude, getQueueLength, getInitInfo, getSessionId, abortCurrent } from './lib/claude.js';
import { sendReply, sendSMS, validateTwilioWebhook } from './lib/channels.js';
import { startScheduler, stopScheduler, readCronRuns } from './lib/cron.js';

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


// --- SMS PIN Auth ---

const smsAuth = new Map(); // phoneNumber -> { authenticatedAt }
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

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message' && msg.content) {
        await handleMessage('web', msg.content, { planMode: msg.planMode || false });
      } else if (msg.type === 'stop') {
        const stopped = abortCurrent();
        if (stopped) console.log('[web] Generation stopped by user');
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
    if (ws.readyState === 1) ws.send(msg);
  }
}

// --- HTTP Routes ---

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/messages', async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const sessionId = getSessionId();
  if (!sessionId) return res.json({ messages: [], total: 0, offset: 0 });

  try {
    const all = await getSessionMessages(sessionId, { dir: config.workspacePath });
    const total = all.length;
    const limit = parseInt(req.query.limit) || 50;

    if (req.query.offset !== undefined) {
      // "Load more" — return messages ending at this offset
      const end = Math.max(0, parseInt(req.query.offset));
      const start = Math.max(0, end - limit);
      res.json({ messages: all.slice(start, end), total, offset: start });
    } else {
      // Initial load — return last N
      const offset = Math.max(0, total - limit);
      res.json({ messages: all.slice(offset), total, offset });
    }
  } catch (err) {
    console.error('[api] Failed to read session:', err.message);
    res.json({ messages: [], total: 0, offset: 0 });
  }
});

app.post('/twilio-sms/webhook', async (req, res) => {
  const result = validateTwilioWebhook(req);
  if (!result.valid) {
    console.log(`[sms] Rejected: ${result.reason}`);
    return res.status(403).send('');
  }

  // Respond immediately with empty TwiML (we reply async via API)
  res.type('text/xml').send('<Response/>');

  // PIN gate
  if (config.twilio.pin && !isSmsAuthenticated(result.from)) {
    if (result.body.trim() === config.twilio.pin) {
      smsAuth.set(result.from, { authenticatedAt: Date.now() });
      await sendSMS(result.from, 'Authenticated.');
      console.log(`[sms] PIN accepted from ${result.from}`);
    } else {
      await sendSMS(result.from, 'PIN required.');
      console.log(`[sms] PIN rejected from ${result.from}`);
    }
    return;
  }

  try {
    await handleMessage('sms', result.body, { from: result.from });
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
    queueLength: getQueueLength(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    queueLength: getQueueLength(),
  });
});

// --- Core Orchestration ---

async function handleMessage(channel, content, meta = {}) {
  const isUserFacing = channel === 'web' || channel === 'sms';

  // Track last route for user-initiated channels
  if (channel === 'sms') {
    lastRoute = { channel: 'sms', from: meta.from };
  } else if (channel === 'web') {
    lastRoute = { channel: 'web' };
  }

  // 1. Broadcast user message to web UI
  if (isUserFacing) {
    broadcast({
      type: 'message',
      role: 'user',
      channel,
      content,
      ts: new Date().toISOString(),
    });
  }

  // 2. Run Claude with streaming
  let fullResponse = '';
  const queueLen = getQueueLength();
  if (isUserFacing && queueLen > 0) {
    broadcast({ type: 'queued', position: queueLen });
  }
  if (isUserFacing) broadcast({ type: 'typing', active: true });

  let resultSessionId = null;
  try {
    const result = await runClaude({
      prompt: content,
      channel,
      model: meta.model || null,
      timeout: meta.timeout || 300000,
      isolated: meta.isolated || false,
      planMode: meta.planMode || false,
      onDelta: isUserFacing ? (text) => {
        fullResponse += text;
        broadcast({ type: 'delta', text });
      } : (text) => { fullResponse += text; },
      onToolStart: isUserFacing ? (name, input) => {
        broadcast({ type: 'tool_start', name, input });
      } : null,
      onToolResult: isUserFacing ? (output) => {
        broadcast({ type: 'tool_result', output });
      } : null,
    });

    if (!fullResponse) fullResponse = result.content || '';
    resultSessionId = result.sessionId;
  } catch (err) {
    fullResponse = `Error: ${err.message}`;
    console.error(`[claude] Error:`, err.message);
  }

  if (isUserFacing) {
    broadcast({ type: 'typing', active: false });
    broadcast({ type: 'stream_end', channel, content: fullResponse });
  }

  // Route response to originating channel
  await sendReply(channel, fullResponse, { ...meta, lastRoute });

  return { response: fullResponse, sessionId: resultSessionId };
}

// --- Start ---

startScheduler(handleMessage);

server.listen(config.port, () => {
  console.log(`[miniclaw] Listening on port ${config.port}`);
  console.log(`[miniclaw] Workspace: ${config.workspacePath}`);
});

// --- Graceful Shutdown ---

function shutdown(signal) {
  console.log(`[miniclaw] ${signal} received, shutting down...`);
  stopScheduler();
  server.close(() => {
    console.log('[miniclaw] Server closed');
    process.exit(0);
  });
  // Force exit after 30s
  setTimeout(() => process.exit(1), 30000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
