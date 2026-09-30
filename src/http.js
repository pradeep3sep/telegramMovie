import { setTimeout as sleep } from 'node:timers/promises';

export class HttpError extends Error {
  constructor(status, host) {
    super('HTTP ' + status + ' from ' + host);
    this.status = status;
  }
}

export async function getText(url, { fetchImpl = fetch, sleepImpl = sleep, attempts = 3 } = {}) {
  const host = new URL(url).hostname;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'MovieNotifier/1.0 (scheduled catalog reader)', Accept: 'text/html,application/json' },
        signal: AbortSignal.timeout(30000),
        redirect: 'follow'
      });
      if (!response.ok) {
        const error = new HttpError(response.status, host);
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) throw error;
        const retry = Number(response.headers.get('retry-after'));
        await sleepImpl(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 60000) : 1500 * 2 ** attempt);
        continue;
      }
      return await response.text();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (attempt === attempts - 1) throw new Error('Could not fetch ' + host + ' after retries.');
      await sleepImpl(1500 * 2 ** attempt);
    }
  }
}
