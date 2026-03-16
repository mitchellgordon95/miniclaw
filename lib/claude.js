import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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
}) {
  return withMutex(() => _runClaude({
    prompt, channel, systemPrompt, sessionId, model, timeout, isolated, onDelta,
  }));
}

async function _runClaude({
  prompt, channel, systemPrompt, sessionId, model, timeout, isolated, onDelta,
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
    '--mcp-config', join(homedir(), '.claude/plugins/marketplaces/claude-plugins-official/external_plugins/playwright/.mcp.json'),
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

  // The prompt is the final positional argument
  args.push(prompt);

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

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
      reject(new Error(`Claude CLI timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on('data', (chunk) => {
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
      } else if (event.type === 'result') {
        fullContent = event.result || '';
        resultSessionId = event.session_id || null;
      }
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
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
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
