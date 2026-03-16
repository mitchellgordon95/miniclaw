import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
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

export function getQueueLength() {
  return queue.length;
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

// --- Claude CLI invocation ---

/**
 * Run a message through Claude Code CLI with streaming.
 * Returns { content, sessionId }.
 * Calls onDelta(text) for each streamed text chunk.
 */
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
      if (err.staleSession) {
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

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--model', model,
    '--add-dir', config.workspacePath,
  ];

  if (sessionId && !isolated) {
    args.push('--resume', sessionId);
  }

  if (isolated) {
    args.push('--no-session-persistence');
  }

  // Build system prompt with channel context
  const sysParts = [];
  if (systemPrompt) sysParts.push(systemPrompt);

  const now = new Date();
  sysParts.push(`Current time: ${now.toISOString()} (${now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} ET)`);
  sysParts.push(`Channel: ${channel}`);

  if (sysParts.length > 0) {
    args.push('--append-system-prompt', sysParts.join('\n'));
  }

  // Use -- to separate flags from the positional prompt
  // (--add-dir is variadic and would consume the prompt otherwise)
  args.push('--', prompt);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      env: { ...process.env, ...(config.env || {}) },
      cwd: config.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let fullContent = '';
    let resultSessionId = null;
    let stderr = '';
    let buffer = '';
    let rawStdout = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
      reject(new Error(`Claude CLI timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on('data', (chunk) => {
      rawStdout += chunk.toString();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event);
        } catch {
          // Skip unparseable lines
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    function handleStreamEvent(event) {
      if (event.type === 'stream_event' &&
          event.event?.type === 'content_block_delta' &&
          event.event?.delta?.type === 'text_delta') {
        const text = event.event.delta.text || '';
        if (text && onDelta) {
          onDelta(text);
        }
      } else if (event.type === 'assistant') {
        // Detect tool calls
        const blocks = event.message?.content || [];
        for (const block of blocks) {
          if (block.type === 'tool_use' && onToolStart) {
            const inputStr = formatToolInput(block.name, block.input);
            onToolStart(block.name, inputStr);
          }
        }
      } else if (event.type === 'user') {
        // Detect tool results
        const blocks = event.message?.content || [];
        for (const block of blocks) {
          if (block.type === 'tool_result' && onToolResult) {
            const output = typeof block.content === 'string'
              ? block.content.slice(0, 500)
              : JSON.stringify(block.content).slice(0, 500);
            onToolResult(output);
          }
        }
      } else if (event.type === 'result') {
        fullContent = event.result || '';
        resultSessionId = event.session_id || null;
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
      return JSON.stringify(input).slice(0, 200);
    }

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          handleStreamEvent(JSON.parse(buffer));
        } catch { /* ignore */ }
      }

      if (code !== 0 && !fullContent) {
        const errorText = stderr || rawStdout.slice(0, 500);
        const err = new Error(`Claude CLI exited with code ${code}: ${errorText}`);
        // Detect stale session so the outer function can retry
        if (sessionId && !isolated && errorText.includes('No conversation found')) {
          err.staleSession = true;
        }
        reject(err);
        return;
      }

      // Save session ID for non-isolated runs
      if (resultSessionId && !isolated) {
        saveSessionId(resultSessionId);
      }

      resolve({ content: fullContent, sessionId: resultSessionId });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });
  });
}
