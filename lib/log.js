import { appendFileSync, readFileSync, existsSync } from 'fs';
import { v4 as uuid } from 'uuid';
import { getHomePath } from './config.js';

const LOG_PATH = getHomePath('messages.jsonl');

export function appendMessage(role, channel, content, meta = {}) {
  const msg = {
    id: uuid(),
    ts: new Date().toISOString(),
    role,
    channel,
    content,
    meta,
  };
  appendFileSync(LOG_PATH, JSON.stringify(msg) + '\n');
  return msg.id;
}

export function readMessages({ limit = 100, after = null } = {}) {
  if (!existsSync(LOG_PATH)) return [];

  const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  let messages = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip corrupted lines
    }
  }

  if (after) {
    messages = messages.filter(m => m.ts > after);
  }

  return messages.slice(-limit);
}
