import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { EventEmitter } from 'events';
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

// Last known init info (updated on each query)
let lastInitInfo = { model: null, apiKeySource: null };

export function getInitInfo() {
  return lastInitInfo;
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

// --- Async message channel ---
// Creates a push-based AsyncIterable for feeding messages to query()

function createMessageChannel() {
  const pending = [];
  let resolve = null;
  let done = false;

  const push = (msg) => {
    if (done) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r({ value: msg, done: false });
    } else {
      pending.push(msg);
    }
  };

  const close = () => {
    done = true;
    if (resolve) {
      resolve({ value: undefined, done: true });
    }
  };

  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((r) => { resolve = r; });
        },
        return() {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { push, close, iterable };
}

// --- Persistent Session ---

const events = new EventEmitter();
events.setMaxListeners(50);

let activeQuery = null;
let activeChannel = null; // the message channel
let querySessionId = null;
let pendingQuestion = null; // { resolve } for AskUserQuestion
const activeAgents = new Map(); // tool_use_id -> { description, background }

export { events, pendingQuestion };

export function setPendingQuestion(pq) {
  pendingQuestion = pq;
}

function buildSystemAppend(channel, systemPrompt) {
  const now = new Date();
  const timeStr = `Current time: ${now.toISOString()} (${now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} ET)`;
  const gatewayNote = `You are running inside MiniClaw, a personal assistant gateway. Source code: /home/node/miniclaw/`;
  return [timeStr, `Channel: ${channel}`, gatewayNote, systemPrompt].filter(Boolean).join('\n');
}

function startQuery(firstMessage, { channel, model, planMode, systemPrompt }) {
  const config = loadConfig();
  model = model || config.model || 'opus';
  const sessionId = getSessionId();

  const effectivePrompt = planMode
    ? `[PLAN MODE] Before making any changes, create a detailed step-by-step plan and present it for approval. You may read files and explore the codebase, but do NOT edit files, run commands with side effects, or make any changes until the plan is explicitly approved.\n\n${firstMessage}`
    : firstMessage;

  const msgChannel = createMessageChannel();
  activeChannel = msgChannel;

  // Push the first message
  msgChannel.push({
    type: 'user',
    message: { role: 'user', content: effectivePrompt },
    parent_tool_use_id: null,
    session_id: sessionId || '',
  });

  const q = query({
    prompt: msgChannel.iterable,
    options: {
      cwd: config.workspacePath,
      model,
      resume: sessionId || undefined,
      env: { ...process.env, ...(config.env || {}) },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      additionalDirectories: [config.workspacePath],
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(channel, systemPrompt) },
      includePartialMessages: true,
      mcpServers: {
        sms: smsServer,
      },
      toolConfig: {
        askUserQuestion: { previewFormat: 'html' },
      },
      canUseTool: async (toolName, input) => {
        if (toolName === 'AskUserQuestion') {
          const answers = await new Promise((resolve) => {
            pendingQuestion = { resolve };
            events.emit('ask_user', input.questions);
          });
          pendingQuestion = null;
          return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  activeQuery = q;

  // Start the output processing loop (runs in background)
  processOutput(q).catch((err) => {
    console.error('[claude] Output loop error:', err.message);
    events.emit('error', err.message);
  });

  return q;
}

async function processOutput(q) {
  let fullContent = '';
  let turnContent = '';

  try {
    for await (const message of q) {
      // Init
      if (message.type === 'system' && message.subtype === 'init') {
        lastInitInfo = {
          model: message.model || null,
          apiKeySource: message.apiKeySource || 'none',
        };
      }

      // Status (compacting, etc.)
      if (message.type === 'system' && message.subtype === 'status') {
        console.log(`[claude] Status: ${JSON.stringify(message.status)}`);
        events.emit('status', message.status);
      }

      // Task notification (background agent completion)
      if (message.type === 'system' && message.subtype === 'task_notification') {
        const toolUseId = message.tool_use_id;
        if (toolUseId && activeAgents.has(toolUseId)) {
          const agent = activeAgents.get(toolUseId);
          activeAgents.delete(toolUseId);
          console.log(`[claude] Background agent done: ${agent.description}`);
          events.emit('agent_done', toolUseId, agent.description);
        }
      }

      // Streaming text deltas
      if (message.type === 'stream_event' &&
          message.event?.type === 'content_block_delta' &&
          message.event?.delta?.type === 'text_delta') {
        const text = message.event.delta.text || '';
        if (text) {
          turnContent += text;
          events.emit('delta', text);
        }
      }

      // Assistant message (tool calls, text blocks)
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            if (block.name === 'ExitPlanMode' && block.input?.plan) {
              events.emit('plan', block.input.plan);
            } else {
              events.emit('tool_start', block.name, formatToolInput(block.name, block.input));
              // Track Agent subagent launches
              if (block.name === 'Agent') {
                const desc = block.input?.description || 'Subagent';
                const toolId = block.id || `agent-${Date.now()}`;
                const isBackground = block.input?.run_in_background === true;
                console.log(`[claude] Agent tool_use: id=${toolId}, desc=${desc}, background=${isBackground}`);
                activeAgents.set(toolId, { description: desc, background: isBackground });
                events.emit('agent_start', toolId, desc);
              }
            }
          }
        }
      }

      // Tool results
      if (message.type === 'user' && message.message?.content) {
        const blocks = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const output = typeof block.content === 'string'
              ? block.content.slice(0, 500)
              : JSON.stringify(block.content).slice(0, 500);
            events.emit('tool_result', output);

            // Check if this completes a foreground agent
            if (block.tool_use_id && activeAgents.has(block.tool_use_id)) {
              const agent = activeAgents.get(block.tool_use_id);
              if (agent.background) {
                console.log(`[claude] Background agent ${agent.description} launched, keeping chip active`);
              } else {
                activeAgents.delete(block.tool_use_id);
                events.emit('agent_done', block.tool_use_id, agent.description);
              }
            }
          }
        }
      }

      // Result (turn complete)
      if (message.type === 'result') {
        fullContent = message.result || turnContent || '';
        querySessionId = message.session_id || null;
        if (querySessionId) saveSessionId(querySessionId);

        events.emit('turn_end', fullContent);
        turnContent = '';
      }
    }
  } finally {
    // Query ended (closed, errored, or input stream ended)
    console.log('[claude] Query output loop ended');
    activeQuery = null;
    activeChannel = null;
    // Clear any remaining agents
    for (const [id, agent] of activeAgents) {
      events.emit('agent_done', id, agent.description);
    }
    activeAgents.clear();
  }
}

// --- Public API ---

export async function sendMessage(text, { channel = 'web', planMode = false, model = null, systemPrompt = null } = {}) {
  const effectiveText = planMode
    ? `[PLAN MODE] Before making any changes, create a detailed step-by-step plan and present it for approval. You may read files and explore the codebase, but do NOT edit files, run commands with side effects, or make any changes until the plan is explicitly approved.\n\n${text}`
    : text;

  if (!activeQuery) {
    // First message or query died: start a new persistent query
    console.log('[claude] Starting new persistent query');
    try {
      startQuery(text, { channel, model, planMode, systemPrompt });
    } catch (err) {
      if (err.message?.includes('No conversation found')) {
        console.log('[claude] Stale session, retrying without resume...');
        saveSessionId('');
        startQuery(text, { channel, model, planMode, systemPrompt });
      } else {
        throw err;
      }
    }
  } else {
    // Push into existing query via streamInput
    console.log('[claude] Pushing message into existing query');
    const sessionId = getSessionId();
    async function* messageStream() {
      yield {
        type: 'user',
        message: { role: 'user', content: effectiveText },
        parent_tool_use_id: null,
        session_id: sessionId || '',
      };
    }
    try {
      await activeQuery.streamInput(messageStream());
    } catch (err) {
      console.error('[claude] streamInput failed, starting new query:', err.message);
      // Query might have died. Start fresh.
      activeQuery = null;
      activeChannel = null;
      startQuery(text, { channel, model, planMode, systemPrompt });
    }
  }
}

export function abortCurrent() {
  if (activeQuery) {
    activeQuery.close();
    activeQuery = null;
    if (activeChannel) {
      activeChannel.close();
      activeChannel = null;
    }
    return true;
  }
  return false;
}

export function answerQuestion(answers) {
  if (pendingQuestion) {
    pendingQuestion.resolve(answers);
    pendingQuestion = null;
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
