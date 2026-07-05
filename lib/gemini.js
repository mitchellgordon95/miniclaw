import { loadConfig } from './config.js';

const DEFAULT_MODEL = 'gemini-3-pro-preview';

/**
 * Forward a verbatim prompt to Google Gemini.
 * No system prompt, no conversation context, no history persistence.
 */
export async function geminiQuery(prompt, { model } = {}) {
  const config = loadConfig();
  const apiKey = config.env?.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured in miniclaw.json env');
  }

  const useModel = model || config.gemini?.model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Gemini returned no text (finishReason: ${reason})`);
  }
  return text;
}
