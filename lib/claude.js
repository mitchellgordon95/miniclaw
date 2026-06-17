import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
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
let activeQueryEffort = null; // reasoning effort the active query was created with
let querySessionId = null;
let pendingQuestion = null; // { resolve } for AskUserQuestion
const activeAgents = new Map(); // tool_use_id -> { description, background }

export { events, pendingQuestion };

export function setPendingQuestion(pq) {
  pendingQuestion = pq;
}

function loadAgentsMd() {
  const config = loadConfig();
  const agentsPath = join(config.workspacePath, 'AGENTS.md');
  try {
    return readFileSync(agentsPath, 'utf8');
  } catch {
    return null;
  }
}

function buildSystemAppend(channel, systemPrompt) {
  // NOTE: keep this string STABLE across calls. It's part of the cached prompt prefix, so
  // anything that changes every turn (e.g. a millisecond timestamp) busts the prompt cache and
  // forces a full-context reprocess. The model already gets the date from the claude_code preset.
  const gatewayNote = `You are running inside MiniClaw, a personal assistant gateway. Source code: /home/node/miniclaw/`;
  // Stable (channel-independent) guidance so it doesn't vary the cached prefix. The active
  // channel is given by the `Channel:` line above; apply the matching rule.
  const channelGuide = `Channel behavior: "phone" is the Light Phone voice launcher — your reply is spoken aloud via TTS and shown on a tiny screen, so keep it brief, conversational, and plain text (no markdown, code blocks, tables, or long lists). "web" is a full desktop chat UI where normal-length, formatted replies are fine. "sms"/"email" reply in kind.`;
  const agentsMd = loadAgentsMd();
  return [`Channel: ${channel}`, gatewayNote, channelGuide, systemPrompt, agentsMd].filter(Boolean).join('\n');
}

function startQuery(firstMessage, { channel, model, planMode, systemPrompt, effort }) {
  const config = loadConfig();
  model = model || config.model || 'opus';
  const sessionId = getSessionId();

  // firstMessage is already effective content (plan mode prefix applied by sendMessage)
  const msgChannel = createMessageChannel();
  activeChannel = msgChannel;

  // Push the first message (content can be string or content block array)
  msgChannel.push({
    type: 'user',
    message: { role: 'user', content: firstMessage },
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
      autoMemoryEnabled: true,
      autoMemoryDirectory: '/home/node/.miniclaw/workspace/memory/',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(channel, systemPrompt) },
      includePartialMessages: true,
      ...(effort ? { effort } : {}),
      mcpServers: {},
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
  activeQueryEffort = effort || null;

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

export async function sendMessage(content, { channel = 'web', planMode = false, model = null, systemPrompt = null, effort = null } = {}) {
  // content can be a string or an array of Anthropic content blocks (text + image)
  let effectiveContent;
  if (planMode) {
    const prefix = '[PLAN MODE] Before making any changes, create a detailed step-by-step plan and present it for approval. You may read files and explore the codebase, but do NOT edit files, run commands with side effects, or make any changes until the plan is explicitly approved.\n\n';
    if (typeof content === 'string') {
      effectiveContent = prefix + content;
    } else if (Array.isArray(content)) {
      // Prepend plan mode text to the first text block, or add one
      effectiveContent = content.map((block, i) => {
        if (block.type === 'text' && i === content.findIndex(b => b.type === 'text')) {
          return { ...block, text: prefix + block.text };
        }
        return block;
      });
    }
  } else {
    effectiveContent = content;
  }

  // For startQuery, extract text for the first message prompt
  const textForQuery = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') || ''
      : String(content);

  // If reasoning effort changed mid-session, restart the persistent query with the new
  // effort. resume: <sessionId> preserves the full conversation, so no context is lost.
  if (activeQuery && (effort || null) !== activeQueryEffort) {
    console.log(`[claude] Effort ${activeQueryEffort} -> ${effort || null}; restarting persistent query`);
    try { activeQuery.close(); } catch { /* ignore */ }
    activeQuery = null;
    if (activeChannel) {
      try { activeChannel.close(); } catch { /* ignore */ }
      activeChannel = null;
    }
  }

  if (!activeQuery) {
    // First message or query died: start a new persistent query
    console.log('[claude] Starting new persistent query');
    try {
      startQuery(effectiveContent, { channel, model, planMode, systemPrompt, effort });
    } catch (err) {
      if (err.message?.includes('No conversation found')) {
        console.log('[claude] Stale session, retrying without resume...');
        saveSessionId('');
        startQuery(effectiveContent, { channel, model, planMode, systemPrompt, effort });
      } else {
        throw err;
      }
    }
  } else {
    // Push into the SAME long-lived input channel the query is already consuming. The old code
    // called activeQuery.streamInput() with a one-shot generator that yields a single message
    // and then completes — a completed input stream signals end-of-input, so the SDK ended the
    // query after every turn. The next message then had to cold-`resume` and reprocess the full
    // history. Pushing into the persistent msgChannel (which never ends) keeps the query — and
    // its prompt cache — warm across turns.
    console.log('[claude] Pushing message into existing query');
    const sessionId = getSessionId();
    try {
      if (!activeChannel) throw new Error('no active input channel');
      activeChannel.push({
        type: 'user',
        message: { role: 'user', content: effectiveContent },
        parent_tool_use_id: null,
        session_id: sessionId || '',
      });
    } catch (err) {
      console.error('[claude] push failed, starting new query:', err.message);
      // Query/channel is gone. Start fresh.
      activeQuery = null;
      activeChannel = null;
      startQuery(effectiveContent, { channel, model, planMode, systemPrompt, effort });
    }
  }
}

export function abortCurrent() {
  if (activeQuery) {
    events.emit('abort');
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
