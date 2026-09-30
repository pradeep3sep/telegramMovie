import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function integer(env, key, fallback, min = 0, max = 100000) {
  const raw = env[key];
  const value = raw == null || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(key + ' must be an integer from ' + min + ' to ' + max);
  }
  return value;
}

export async function loadConfig(env = process.env) {
  const override = env.SOURCE_URLS?.trim();
  const sources = override
    ? JSON.parse(override).map(url => ({ name: new URL(url).hostname, url, adapter: 'wordpress' }))
    : JSON.parse(await readFile(new URL('../sources.json', import.meta.url), 'utf8'));
  if (!Array.isArray(sources) || !sources.length) throw new Error('Configure at least one source.');
  for (const source of sources) {
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Sources must use public HTTP(S) URLs without credentials.');
    }
    source.url = url.href;
    if (source.adapter !== 'wordpress') throw new Error('Unsupported source adapter.');
  }
  return {
    sources,
    statePath: resolve(env.STATE_PATH || 'data/state.json'),
    token: env.TELEGRAM_BOT_TOKEN?.trim(),
    chatId: env.TELEGRAM_CHAT_ID?.trim(),
    threadId: env.TELEGRAM_THREAD_ID?.trim() || undefined,
    omdbKey: env.OMDB_API_KEY?.trim(),
    catalogPages: integer(env, 'MAX_CATALOG_PAGES_PER_RUN', 40, 1, 10000),
    recentPages: integer(env, 'MAX_RECENT_PAGES_PER_RUN', 50, 1, 10000),
    maxMessages: integer(env, 'MAX_MESSAGES_PER_RUN', 500, 1, 10000),
    omdbBudget: integer(env, 'MAX_OMDB_REQUESTS_PER_RUN', 200, 0, 10000),
    runtimeMs: integer(env, 'MAX_RUNTIME_MINUTES', 150, 1, 150) * 60000,
    requestDelay: integer(env, 'REQUEST_DELAY_MS', 1500, 250, 60000),
    telegramDelay: integer(env, 'TELEGRAM_DELAY_MS', 3200, 3200, 60000)
  };
}
