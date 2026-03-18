import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
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

// --- Mutex queue (serializes web/SMS messages) ---

let running = false;
const queue = [];
let currentAbort = null;

// Last known init info (updated on each query)
let lastInitInfo = { model: null, apiKeySource: null };

export function getQueueLength() {
  return queue.length;
}

export function getInitInfo() {
  return lastInitInfo;
}

export function abortCurrent() {
  if (currentAbort) {
    currentAbort.abort();
    return true;
  }
  return false;
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

// --- send_sms MCP tool ---

function createSmsServer() {
  const config = loadConfig();
  const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  const defaultTo = config.twilio.allowFrom[0];

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

// --- Claude Agent SDK invocation (web/SMS only, crons use CLI) ---

export async function runClaude({
  prompt,
  channel = 'web',
  systemPrompt = null,
  sessionId = undefined,
  model = null,
  timeout = 300000,
  planMode = false,
  onDelta = null,
  onToolStart = null,
  onToolResult = null,
  onPlan = null,
  onStatus = null,
}) {
  const args = { prompt, channel, systemPrompt, sessionId, model, timeout, planMode, onDelta, onToolStart, onToolResult, onPlan, onStatus };

  return withMutex(async () => {
    try {
      return await _runClaude(args);
    } catch (err) {
      if (err.message?.includes('No conversation found')) {
        console.log('[claude] Stale session, retrying without resume...');
        saveSessionId('');
        return await _runClaude({ ...args, sessionId: null });
      }
      throw err;
    }
  });
}

async function _runClaude({
  prompt, channel, systemPrompt, sessionId, model, timeout, planMode, onDelta, onToolStart, onToolResult, onPlan, onStatus,
}) {
  const config = loadConfig();
  model = model || config.model || 'opus';

  if (sessionId === undefined) {
    sessionId = getSessionId();
  }

  // Build system prompt appendix
  const now = new Date();
  const timeStr = `Current time: ${now.toISOString()} (${now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} ET)`;
  const gatewayNote = `You are running inside MiniClaw, a personal assistant gateway. Source code: /home/node/miniclaw/`;
  const appendPrompt = [timeStr, `Channel: ${channel}`, gatewayNote, systemPrompt].filter(Boolean).join('\n');

  const abortController = new AbortController();
  currentAbort = abortController;
  const timer = setTimeout(() => abortController.abort(), timeout);

  const MAX_RETRIES = 2;
  let lastError;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.log(`[claude] Retry attempt ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      let hasStreamedContent = false;
      const effectivePrompt = planMode
        ? `[PLAN MODE] Before making any changes, create a detailed step-by-step plan and present it for approval. You may read files and explore the codebase, but do NOT edit files, run commands with side effects, or make any changes until the plan is explicitly approved.\n\n${prompt}`
        : prompt;

      try {
        const q = query({
          prompt: effectivePrompt,
          options: {
            abortController,
            cwd: config.workspacePath,
            model,
            resume: sessionId || undefined,
            env: { ...process.env, ...(config.env || {}) },
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            additionalDirectories: [config.workspacePath],
            settingSources: ['project'],
            systemPrompt: { type: 'preset', preset: 'claude_code', append: appendPrompt },
            includePartialMessages: true,
            mcpServers: {
              sms: smsServer,
            },
          },
        });

        let fullContent = '';
        let resultSessionId = null;

        for await (const message of q) {
          if (message.type === 'system' && message.subtype === 'init') {
            lastInitInfo = {
              model: message.model || null,
              apiKeySource: message.apiKeySource || 'none',
            };
          }

          if (message.type === 'system' && message.subtype === 'status') {
            console.log(`[claude] Status: ${JSON.stringify(message.status)}`);
            if (onStatus) onStatus(message.status);
          }

          if (message.type === 'stream_event' &&
              message.event?.type === 'content_block_delta' &&
              message.event?.delta?.type === 'text_delta') {
            const text = message.event.delta.text || '';
            if (text) {
              hasStreamedContent = true;
              if (onDelta) onDelta(text);
            }
          }

          if (message.type === 'assistant' && message.message?.content) {
            hasStreamedContent = true;
            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                if (block.name === 'ExitPlanMode' && block.input?.plan && onPlan) {
                  onPlan(block.input.plan);
                } else if (onToolStart) {
                  onToolStart(block.name, formatToolInput(block.name, block.input));
                }
              }
            }
          }

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

          if (message.type === 'result') {
            fullContent = message.result || '';
            resultSessionId = message.session_id || null;
          }
        }

        if (resultSessionId) {
          saveSessionId(resultSessionId);
        }

        return { content: fullContent, sessionId: resultSessionId };

      } catch (err) {
        lastError = err;
        const msg = err.message || '';
        const isRetryable = msg.includes('500') || msg.includes('502') || msg.includes('503')
          || msg.includes('529') || msg.includes('Internal server error')
          || msg.includes('overloaded') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');

        if (!isRetryable || hasStreamedContent || attempt === MAX_RETRIES) {
          throw err;
        }
        console.log(`[claude] Retryable error: ${msg.slice(0, 200)}`);
      }
    }
    throw lastError;
  } finally {
    currentAbort = null;
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
