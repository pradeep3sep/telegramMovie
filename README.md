# Telegram Movie Notifier

A Node.js job that checks movie listings, opens their detail pages, and sends one Telegram post per new Hindi/English movie with a poster, title, year, IMDb rating, and download buttons.

Default source: https://vegamovis.baby/

## Behavior

- Imports the entire eligible movie catalog, continuing over multiple runs. The source has over 1,300 catalog pages.
- Checks recent pages while the initial import continues, then rotates through the catalog to catch backdated additions.
- Reads actual Hindi/English audio metadata; ignores language mentions in boilerplate.
- Includes the available resolutions and hosts. Duplicate button URLs are consolidated.
- Telegram posts omit the source-page link.
- Excludes episodic shows and explicit adult videos because this is a movie notifier.
- Uses source ratings and optionally enriches metadata through OMDb. Missing ratings are displayed as **Not available**, never invented.
- Tracks sent movies by normalized title/year and IMDb ID when available, avoiding reposts for another release quality.
- Reads HTML without executing advertising scripts or opening popups.
- Copies download-button URLs as published. Some are intermediary links; it does not bypass their redirects, CAPTCHAs, logins, or waiting pages.

## Local setup

Use Node.js 20.13+ (GitHub Actions uses Node.js 22).

1. Open a terminal in the project folder and run `npm ci`.
2. Run `npm run setup` to create `.env`, `data`, and `output`. An existing `.env` is preserved.
3. Edit `.env`: fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. `OMDB_API_KEY` is optional.
4. Run `npm run dry-run` to inspect a live sample without sending. Results are printed and saved in `output/preview.json`.
5. Run `npm run local:test` to send **at most one movie** and verify Telegram. It uses normal posting history, so a successful test is not resent by subsequent local runs.
6. Run `npm start` for a full cycle, or `npm run local` to repeat cycles locally every six hours.

Example on Windows:

```powershell
cd D:\movie-telegram-bot
npm run setup
npm run dry-run
# After filling and saving .env:
npm run local:test
# To keep running every six hours:
npm run local
```

`npm run local` runs immediately, then waits until the next six-hour interval. Keep the computer awake and terminal open; press Ctrl+C to stop. Failed cycles retain progress and are tried again at the next interval. Cycles do not overlap.

Use `LOCAL_INTERVAL_HOURS` in `.env` to change the local interval. `MAX_MESSAGES_PER_RUN` and the page limits control full cycles; `local:test` temporarily limits the cycle to one post and one catalog page.

Your `.env`, local posting history, and preview output are excluded from Git. GitHub Actions uses repository secrets, not your local `.env`. Local and GitHub histories are separate: do not run both against the same group unless their history is synchronized.

### Telegram bot and group ID

1. Open https://t.me/BotFather and send `/newbot`.
2. Choose a name and username; save the token privately.
3. Add the bot to your group and allow it to send messages and photos. Admin status is needed only if your group restrictions require it.
4. Put the token in `.env`, then send `/start@YourBotUsername` in the group.
5. Run `npm run telegram:setup`. It prints the chat ID without printing the token.
6. Set `TELEGRAM_CHAT_ID` to that value. Supergroup IDs usually start with `-100`.
7. For a forum topic, send the command in that topic and use its reported `TELEGRAM_THREAD_ID`.

Use a dedicated bot. Another process consuming updates or an existing webhook can prevent the group-ID helper from working.

Official instructions: https://core.telegram.org/bots/tutorial

### Optional rating API

Get and activate an OMDb key at https://www.omdbapi.com/apikey.aspx.

Source ratings are labeled **website (unverified)**. External results must match the title/year or IMDb ID. Default external API budget: 200 requests per cycle; adjust to the quota on your account.

## GitHub setup

1. Push the project to `main`.
2. Under **Settings → Secrets and variables → Actions → Secrets**, add:
   - `TELEGRAM_BOT_TOKEN` — required
   - `TELEGRAM_CHAT_ID` — required
   - `TELEGRAM_THREAD_ID` — optional
   - `OMDB_API_KEY` — optional
3. Under **Actions → Movie notifications → Run workflow**, keep **dry_run** enabled for the first preview.
4. Download the **movie-preview** artifact to inspect the result.
5. Run again with **dry_run** unchecked to begin posting.

Scheduled runs occur every six hours: **00:17, 06:17, 12:17, and 18:17 IST**. GitHub can delay scheduled workflows. Public repository schedules are disabled after 60 days without repository activity; private repositories use the Actions allowance on your plan.

Documentation: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows

No server, webhook endpoint, or always-on computer is required.

### Persistent history

GitHub Actions creates a separate **movie-bot-state** branch containing `state.json`. The workflow token has `contents: write`; no personal access token is needed for scheduled runs.

- Do not delete this branch: deleting history can cause the catalog to be reposted.
- Do not run several copies against the same Telegram group using separate history files.
- Local history is `data/state.json`, ignored by Git.
- Code remains on `main`; history updates do not trigger CI on `main`.
- History contains movie metadata and Telegram message IDs, not bot credentials. Its visibility follows the repository.
- Each delivery is checkpointed before sending and immediately after confirmation. Large imports make many state commits.
- If repository rules deny state-branch writes, posting stops.

### Uncertain delivery recovery

Telegram has no message idempotency key. A lost response may occur after a successful post. The bot pauses with a pending record to avoid blindly retrying and duplicating it.

Check the movie in the group, then run the workflow with **recovery = mark-sent** if it is present, or **recovery = retry** only if it is absent. Keep **dry_run** enabled to reconcile without posting, or uncheck it to resume immediately.

For local runs: `npm run status`, then `npm run resolve-delivery -- mark-sent` or `npm run resolve-delivery -- retry`.

Explicit Telegram rejections preserve the queue. A rejected poster falls back to text with the same buttons.

### Configuration

Edit `sources.json` for other WordPress-compatible sites. Other layouts need their own adapter. GitHub variable `SOURCE_URLS` can override it with a JSON array of URLs.

| Setting | Default | Purpose |
| --- | ---: | --- |
| `MAX_CATALOG_PAGES_PER_RUN` | 40 | Initial import / rotating audit pages |
| `MAX_RECENT_PAGES_PER_RUN` | 50 | Recent scan page limit; continuation is saved |
| `MAX_MESSAGES_PER_RUN` | 500 | Maximum posts per cycle |
| `MAX_OMDB_REQUESTS_PER_RUN` | 200 | External lookup budget |
| `MAX_RUNTIME_MINUTES` | 150 | Application time budget |
| `REQUEST_DELAY_MS` | 1500 | Source request delay |
| `TELEGRAM_DELAY_MS` | 3200 | Group posting delay |

The first four limits can be changed through same-named GitHub Actions variables. Local settings come from `.env`. The job timeout is 180 minutes.

Limits bound each cycle, not the total import. Queue and cursors persist. New movies may wait behind the initial queue. Changing source domains requires planning history migration because domains are part of listing identity.

Source layout changes, broken links, inaccessible hosts, or access challenges may require adapter changes. Failures are visible and history is preserved.

## Validation

- `npm run check` validates JavaScript syntax and workflow YAML.
- `npm test` covers parsing, languages, duplicate prevention across cycles, catalog resumption, Telegram flood limits, photo fallback, uncertain delivery, corrupt history, and durable Git checkpoints.
- `npm run dry-run -- --preview-limit=3` fetches a live sample without requiring Telegram credentials.

Use content and links you are authorized to share.
