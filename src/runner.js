import { setTimeout as sleep } from 'node:timers/promises';
import { parseListing, parseMovie, exclusion, movieKeys } from './parser.js';
import { getText } from './http.js';
import { confirmDelivery } from './state.js';

export async function runCycle(config, state, {
  dryRun = false, save = async () => {}, get = getText,
  telegram, approval, metadata, sleepImpl = sleep, log = console.log,
  now = () => Date.now(), previewLimit = 3
} = {}) {
  if (state.pendingDelivery) throw new Error('An earlier Telegram delivery needs confirmation. Check the group, then use the workflow recovery option or npm run resolve-delivery.');
  if (!dryRun && config.approvalChatId && !approval) throw new Error('Approval client is required before group delivery.');
  if (!dryRun && approval?.cleanupDecided) await approval.cleanupDecided(state, { save, log });
  const started = now();
  const deadline = started + config.runtimeMs;
  const withinBudget = () => now() < deadline - 60000;
  const summary = { discovered: 0, filtered: 0, sent: 0, duplicates: 0, failed: 0, previewed: 0, pages: 0, awaitingApproval: 0, rejected: 0 };
  const preview = [];
  let scrapeErrors = 0;

  async function updateGroupTitle() {
    if (dryRun || !state.pendingGroupTitle) return;
    try {
      await telegram.renameGroup(state.pendingGroupTitle);
    } catch (error) {
      log('Group title update failed' + (error.code ? ' (Telegram code ' + error.code + ')' : '') +
        '; it will be retried. Give the bot admin permission to change group information.');
      return;
    }
    delete state.pendingGroupTitle;
    await save(state);
  }
  await updateGroupTitle();

  async function scan(source, initialUrl, limit, stopAtKnown) {
    let url = initialUrl, knownStreak = 0;
    const visited = new Set();
    for (let count = 0; url && count < limit && withinBudget(); count++) {
      if (visited.has(url)) throw new Error('Pagination loop detected.');
      visited.add(url);
      const parsed = parseListing(await get(url), url);
      const allKnown = parsed.entries.every(entry => state.items[entry.id]);
      for (const entry of parsed.entries) {
        if (state.items[entry.id]) continue;
        const reason = exclusion(entry.title);
        state.items[entry.id] = {
          ...entry, source: source.url, firstSeen: new Date(now()).toISOString(),
          status: reason ? 'filtered' : 'queued', ...(reason ? { reason } : {})
        };
        summary.discovered++;
        if (reason) summary.filtered++;
      }
      summary.pages++;
      knownStreak = allKnown ? knownStreak + 1 : 0;
      url = parsed.nextUrl;
      await save(state);
      await sleepImpl(config.requestDelay);
      if (stopAtKnown && knownStreak >= 2) return { next: null, reachedEnd: !url };
      if (dryRun && Object.values(state.items).filter(item => item.status === 'queued').length >= previewLimit) break;
    }
    return { next: url, reachedEnd: !url };
  }

  for (const source of config.sources) {
    if (!withinBudget()) break;
    const existing = state.sources[source.url];
    const progress = state.sources[source.url] ||= {
      backfillUrl: source.url, backfillDone: false, recentResumeUrl: null, auditUrl: source.url
    };
    try {
      if (existing) {
        const head = await scan(source, source.url, dryRun ? 1 : config.recentPages, true);
        if (head.next && !progress.recentResumeUrl) progress.recentResumeUrl = head.next;
        // A cap is visible and does not silently discard the rest of the recent scan.
        if (head.next) log('Recent scan reached its page/time limit; continuation saved.');
        if (progress.recentResumeUrl && !dryRun && withinBudget()) {
          const continuation = await scan(source, progress.recentResumeUrl, config.recentPages, true);
          progress.recentResumeUrl = continuation.next;
        }
      }
      // Pause discovery when delivery backlog grows; resume with the stored cursor.
      const queued = Object.values(state.items).filter(item => item.status === 'queued').length;
      if (!progress.backfillDone && queued < config.maxMessages * 2 && withinBudget()) {
        const result = await scan(source, progress.backfillUrl, dryRun ? 1 : config.catalogPages, false);
        progress.backfillUrl = result.next;
        progress.backfillDone = result.reachedEnd;
      } else if (progress.backfillDone && !dryRun && withinBudget()) {
        // Continual rotating audit catches backdated additions outside the recent pages.
        const audit = await scan(source, progress.auditUrl || source.url, config.catalogPages, false);
        progress.auditUrl = audit.next || source.url;
      }
      progress.lastCheckedAt = new Date(now()).toISOString();
      await save(state);
    } catch (error) {
      scrapeErrors++;
      summary.failed++;
      log('Source scan failed: ' + error.message);
      await save(state);
    }
  }

  const queue = Object.entries(state.items).filter(([, item]) => item.status === 'queued')
    .sort((a, b) => a[1].firstSeen.localeCompare(b[1].firstSeen));
  for (const [id, item] of queue) {
    if (!withinBudget() || summary.sent >= config.maxMessages || (dryRun && preview.length >= previewLimit)) break;
    if (item.retryAfter && item.retryAfter > now()) continue;
    let movie = item.movie;
    try {
      if (!movie) {
        movie = parseMovie(await get(item.url), item.url, item);
        await sleepImpl(config.requestDelay);
        if (movie.excluded) {
          item.status = 'filtered';
          item.reason = movie.excluded;
          summary.filtered++;
          await save(state);
          continue;
        }
        movie = metadata ? await metadata.enrich(movie) : movie;
        item.movie = movie;
      }
    } catch (error) {
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = error.message;
      item.retryAfter = now() + Math.min(24, 2 ** Math.min(item.attempts - 1, 5)) * 3600000;
      summary.failed++;
      log('Movie detail lookup failed; it will be retried.');
      await save(state);
      continue;
    }
    const keys = movieKeys(movie);
    if (keys.some(key => state.movies[key])) {
      item.status = 'duplicate';
      delete item.movie;
      summary.duplicates++;
      await save(state);
      continue;
    }
    if (dryRun) {
      preview.push(movie);
      summary.previewed++;
      continue;
    }
    if (approval) {
      const decision = await approval.decide(movie, item, state, { save, deadline, now, log });
      if (!decision) { summary.awaitingApproval++; break; }
      if (decision !== 'approved') {
        item.status = 'rejected';
        summary.rejected++;
        await save(state);
        continue;
      }
    }
    // Write the intent before sending. If the process dies, do not send this movie twice.
    state.pendingDelivery = { itemId: id, keys, title: movie.title, year: movie.year, startedAt: new Date(now()).toISOString() };
    await save(state);
    let result;
    try { result = await telegram.send(movie); }
    catch (error) {
      if (error.code) {
        state.pendingDelivery = null; // Explicit rejection proves no message was delivered.
        item.lastError = 'Telegram rejected delivery with code ' + error.code;
        await save(state);
      }
      throw error;
    }
    confirmDelivery(state, result.message_id);
    state.pendingGroupTitle = movie.title;
    summary.sent++;
    await save(state);
    await updateGroupTitle();
    log('Posted: ' + movie.title + (movie.year ? ' (' + movie.year + ')' : ''));
    await sleepImpl(config.telegramDelay);
  }
  state.lastRun = { at: new Date(now()).toISOString(), dryRun, ...summary };
  await save(state);
  const pending = Object.values(state.items).filter(item => item.status === 'queued').length;
  log('Cycle summary: ' + JSON.stringify({ ...summary, queued: pending }));
  // Workflow must fail visibly on broken source layouts and failed movie extraction.
  if (summary.failed && !dryRun) throw new Error('Cycle completed with ' + summary.failed + ' failed scan/detail operation(s); progress is saved.');
  if (dryRun && !preview.length) throw new Error('Preview found no eligible movies; check the source or parser.');
  return { summary, preview, scrapeErrors };
}
