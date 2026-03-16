import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import twilio from 'twilio';
import { getHomePath, loadConfig } from './config.js';

const SESSION_PATH = getHomePath('session-id');

// --- Session ID persistence ---

export function getSessionId() {
  if (existsSync(SESSION_PATH)) {
    return readFileSync(SESSION_PATH, 'utf8').trim() || null;
  }
  return null;
}

export function saveSessionId(id) {
  writeFileSync(SESSION_PATH, id);
}

// --- Mutex queue (one Claude process at a time) ---

let running = false;
const queue = [];

// Last known init info (updated on each query)
let lastInitInfo = { model: null, apiKeySource: null };

export function getQueueLength() {
  return queue.length;
}

export function getInitInfo() {
  return lastInitInfo;
}

function withMutex(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      running = true;
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        running = false;
        if (queue.length > 0) queue.shift()();
      }
    };
    if (!running) run();
    else queue.push(run);
  });
}

// --- send_sms tool ---

function createSmsServer() {
  const config = loadConfig();
  const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  const defaultTo = config.twilio.allowFrom[0]; // Mitchell's number

  const sendSmsTool = tool(
    'send_sms',
    `Send an SMS message via Twilio. Default recipient is ${defaultTo} (Mitchell).`,
    {
      to: z.string().describe(`Recipient phone number (default: ${defaultTo})`).optional(),
      message: z.string().describe('Message text to send'),
    },
    async ({ to, message }) => {
      const recipient = to || defaultTo;
      try {
        const msg = await twilioClient.messages.create({
          body: message,
          from: config.twilio.phoneNumber,
          to: recipient,
        });
        return { content: [{ type: 'text', text: `SMS sent to ${recipient} (SID: ${msg.sid})` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to send SMS: ${err.message}` }], isError: true };
      }
    }
  );

  return createSdkMcpServer({ name: 'sms', tools: [sendSmsTool] });
}

const smsServer = createSmsServer();

// --- Claude Agent SDK invocation ---

export async function runClaude({
  prompt,
  channel = 'web',
  systemPrompt = null,
  sessionId = undefined,
  model = null,
  timeout = 300000,
  isolated = false,
  onDelta = null,
  onToolStart = null,
  onToolResult = null,
}) {
  return withMutex(async () => {
    try {
      return await _runClaude({
        prompt, channel, systemPrompt, sessionId, model, timeout, isolated, onDelta, onToolStart, onToolResult,
      });
    } catch (err) {
      // If session was stale, retry without resume
      if (err.message?.includes('No conversation found')) {
        console.log('[claude] Stale session, retrying without resume...');
        saveSessionId('');
        return await _runClaude({
          prompt, channel, systemPrompt, sessionId: null, model, timeout, isolated, onDelta, onToolStart, onToolResult,
        });
      }
      throw err;
    }
  });
}

async function _runClaude({
  prompt, channel, systemPrompt, sessionId, model, timeout, isolated, onDelta, onToolStart, onToolResult,
}) {
  const config = loadConfig();
  model = model || config.model || 'opus';

  // If no explicit sessionId, use the stored one (unless isolated)
  if (sessionId === undefined && !isolated) {
    sessionId = getSessionId();
  }

  // Build system prompt appendix
  const now = new Date();
  const timeStr = `Current time: ${now.toISOString()} (${now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} ET)`;
  const appendPrompt = [timeStr, `Channel: ${channel}`, systemPrompt].filter(Boolean).join('\n');

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const q = query({
      prompt,
      options: {
        abortController,
        cwd: config.workspacePath,
        model,
        resume: (sessionId && !isolated) ? sessionId : undefined,
        sessionId: isolated ? randomUUID() : undefined,
        env: { ...process.env, ...(config.env || {}) },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        additionalDirectories: [config.workspacePath],
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt },
        includePartialMessages: true,
        mcpServers: { sms: smsServer },
      },
    });

    let fullContent = '';
    let resultSessionId = null;

    for await (const message of q) {
      // Capture init info (only from user-facing queries, not cron)
      if (message.type === 'system' && message.subtype === 'init' && !isolated) {
        lastInitInfo = {
          model: message.model || null,
          apiKeySource: message.apiKeySource || 'none',
        };
      }

      // Text deltas (streaming)
      if (message.type === 'stream_event' &&
          message.event?.type === 'content_block_delta' &&
          message.event?.delta?.type === 'text_delta') {
        const text = message.event.delta.text || '';
        if (text && onDelta) onDelta(text);
      }

      // Tool calls (from assistant messages)
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use' && onToolStart) {
            onToolStart(block.name, formatToolInput(block.name, block.input));
          }
        }
      }

      // Tool results (from user messages)
      if (message.type === 'user' && message.message?.content) {
        const blocks = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_result' && onToolResult) {
            const output = typeof block.content === 'string'
              ? block.content.slice(0, 500)
              : JSON.stringify(block.content).slice(0, 500);
            onToolResult(output);
          }
        }
      }

      // Final result
      if (message.type === 'result') {
        fullContent = message.result || '';
        resultSessionId = message.session_id || null;
      }
    }

    // Save session ID for non-isolated runs
    if (resultSessionId && !isolated) {
      saveSessionId(resultSessionId);
    }

    return { content: fullContent, sessionId: resultSessionId };
  } finally {
    clearTimeout(timer);
  }
}

function formatToolInput(name, input) {
  if (!input) return '';
  if (name === 'Bash') return input.command || '';
  if (name === 'Read') return input.file_path || '';
  if (name === 'Edit') return input.file_path || '';
  if (name === 'Write') return input.file_path || '';
  if (name === 'Glob') return input.pattern || '';
  if (name === 'Grep') return input.pattern || '';
  if (name === 'Skill') return input.skill || '';
  if (name === 'Agent') return input.description || '';
  if (name === 'send_sms') return input.message || '';
  return JSON.stringify(input).slice(0, 200);
}
