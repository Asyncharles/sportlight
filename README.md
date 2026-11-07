# Sportlight

**The moment is now.** A sports viewing prototype that watches many live feeds at once and puts the most intense moments in your sports on screen: one main window, three side windows, and a "Best of Today" reel.

![layout](UI-sketch.png)

## Quick start

```bash
docker compose up --build
```

Open **http://localhost:8080**. RabbitMQ's management UI is at http://localhost:15672 (guest / guest), and the admin page (streams and content) is at http://localhost:8080/admin.

The first media build downloads full YouTube broadcast replays (several GB; allow substantial download time and disk space). Install current `yt-dlp[default]`, Node, ffmpeg and ffprobe first. The builder selects 720p H.264/AAC by default (set `output.maxHeight` to 1080 for larger files), preserves native frame rate and normal speed, and caches downloads. Failed or low-quality replacements retain the previous catalog entry and produce a nonzero build exit; no new test patterns are generated. Run `npm run media -- --only=football-fra-ger` for one feed. Restart the publisher after rebuilding, or pass `--activate` to restart the local watch-mode publisher after each completed replay. Completed replacements become available incrementally while remaining games download. Source URLs, matching event labels and starting offsets live in `media/sources.json`; use `YT_DLP` to override the downloader executable. Optional: install `aria2` and run `MEDIA_DOWNLOADER=aria2c npm run media` for parallel download connections. The build stops accepting new downloads when less than 4 GiB is free.

## Local development

Requires Node ≥ 20.11, ffmpeg and Docker.

```bash
npm install
npm run media                       # one-off: build media/dist (demo footage)
docker compose up -d rabbitmq       # broker only
npm run dev                         # shared (watch) + backend + publisher + Vite on :5173
```

Other scripts: `npm test` (Vitest), `npm run typecheck`, `npm run build`.

## Architecture

```
 mock publisher ──AMQP──▶ RabbitMQ ──▶ backend ──WebSocket──▶ browser
 (provider stand-in)     topic exch.   (TS, Node)  metadata +     │
        │                sportlight    authoritative intensity    │ video over HTTP
        └── reads catalog ─ media ◀──────────────────────────────┘ (byte ranges)
                            (nginx; GCS/CDN in prod)
```

| Path | What |
| --- | --- |
| `packages/shared` | Typed contracts shared by every service: domain model, catalogue, AMQP events + zod schemas (`@sportlight/shared/schemas`), WebSocket protocol, admin API, the **selection engine**, and media-timeline helpers. |
| `apps/backend` | Consumes RabbitMQ events and owns authoritative feed state, intensity history and highlights. Fans out over WebSocket and serves REST (`/api/feeds`, `/api/highlights`, `/api/admin/overview`). |
| `apps/publisher` | Mock provider. Runs a seeded, repeatable demo scenario and publishes it the way a real adapter would. |
| `apps/web` | Vite + React + TypeScript + SCSS client: landing page, live view (with first-visit tour), Best of Today, settings and admin. |
| `media/` | `sources.json` (what footage to use) → `build.mjs` (download, transcode, thumbnails, `catalog.json`) → nginx image. |

### Event flow and ordering

Events (`feed.started`, `feed.intensity`, `feed.updated`, `feed.ended`) share an envelope with `eventId`, `feedId`, `runId`, `runStartedAt`, a per-run `seq` and `occurredAt` (see `packages/shared/src/events.ts`). The backend:

- drops exact redeliveries by `eventId`;
- ignores events from an older run (by `runStartedAt`);
- within a run, never lets `seq ≤ last` overwrite state. Late intensity readings are still back-filled into history;
- dead-letters schema-invalid messages to `sportlight.feeds.dead`;
- marks intensity **stale** after 5 s without readings, a feed **unavailable** after 15 s of silence, and **ended** after 2 min.

The publisher re-announces running feeds every 10 s, so a freshly started backend converges without replaying history. Compose enables light chaos (2% duplicates, 2% delayed readings). The admin view shows these being absorbed.

Intensity readings carry `streamTime` (seconds since the run started), which maps every score onto the media timeline. That is what lets highlights replay the right moment.

## Product decisions (confirmed for this prototype)

| Question in the spec | Decision |
| --- | --- |
| Main-window policy | **Stays on the user's choice.** It is filled automatically only when empty: initially with the top-ranked feed, and when its feed ends, becomes unavailable or is filtered out. In that case the best visible side feed moves up, keeping its player. |
| Video transport | **Simulated-live MP4.** Video travels separately from the WebSocket as looping MP4 over HTTP byte ranges. Every viewer derives the same live position from the run start and a server-clock offset. Pausing puts you behind live, and **Go live** catches up. `MediaSource` is a tagged union, so `hls` can be added later. |
| Highlights | **Known time ranges** in the bundled media for viewer replay. The content worker renders standalone vertical Shorts at runtime. |
| Demo media | **Full YouTube broadcast replays**, downloaded locally at native speed. Credits are in Settings → About and in `media/dist/CREDITS.md`. |

### Feed selection (`packages/shared/src/selection.ts`)

Selection is pure, deterministic and unit-tested. It runs per viewer on their own device, so preferences differ freely, and each viewer reports what they show to the backend for the admin view.

- **Eligible** means live and matching the viewer's follows. A feed that stops being eligible leaves its window immediately.
- **Rank** is the provider intensity plus the viewer's own vote (+8 up, −15 down). Votes are separate from intensity. They are stored per run and aggregated on the backend.
- Empty side windows fill immediately. A side feed is **replaced** only after it has been visible for **20 s**, when a fresh challenger beats the weakest such side feed by **≥ 10 points for 3 consecutive seconds**. At most one replacement happens per pass, and windows never reorder because scores change.
- Clicking a side feed **promotes** it: it swaps with the main feed, and both restart their minimum display time.

### Playback and animation

- Each feed keeps one `<video>` element for as long as it is on screen. Promotion animates the same element's position and size (220 ms), so playback never restarts.
- A replacement mounts the incoming player invisibly on top. It waits for an actual decoded frame (`requestVideoFrameCallback`), then crossfades over the outgoing one, so there are no blank frames or flashes.
- Playback stays at **1×**. Small drift is tolerated; large drift (stalls, background tabs) is corrected by seeking.
- Only the main window can play audio, and only once the viewer unmutes. Audio follows the main window when it changes.
- Controls appear on hover, keyboard focus or tap. A small intensity badge and a 3 px meter are always visible. `prefers-reduced-motion` (or Settings → Motion) removes the motion.

### Live view options (Settings → Layout, Switching, Switch animation)

- **Layouts.** *Live table* (default): main window, two side windows and a compact table of every live feed in your sports, ranked by intensity with a trend line per feed. The table re-sorts every 2.5 s, rows glide to their new place, and clicking a row puts that feed in the main window. Its expand button grows it over the whole sidebar with taller rows (broadcaster, competition, 30 s change). *Classic* (three side windows), *Theatre* (wide main, three beneath) and *Quad* (four equal windows). The sidebar can sit left or right.
- **Switching.** *Main window*: “My choice” (the original policy) or “Follow action”, where a side feed that out-ranks main by the margin swaps in. *Pace*: Calm / Balanced (server rules) / Eager, or Custom sliders for minimum time, margin and challenge time.
- **Switch warning.** Before an automatic switch, the window shows “Switching to X” with a draining ring and edge, for 3, 5 or 8 s (or off). **Keep** cancels it and restarts that window's minimum time. **Now** switches immediately. In the engine the warning is simply the last part of the challenge window (`challengeMs + countdownMs`), reported as `upcoming`, so a challenger that falls back cancels it on its own.
- **Lock.** The lock in the header (or **L**) freezes the live windows: no automatic replacements or swaps. Feeds that end still leave, and clicking a feed still promotes it.
- **Animations.** *Spotlight*: the new feed irises open from its intensity badge inside a ring of lime light, and the old one dims beneath. *Stinger*: a broadcast-style replay wipe in which a skewed lime slab with the Sportlight mark sweeps across and reveals the new feed along its edge. *Flip*: windows turn over like cards with a lime sheen, and moving feeds tilt in flight. All three keep the original guarantees (the incoming feed is shown only after its first frame; moves keep the same `<video>`). Reduced motion falls back to a plain crossfade. Previews in Settings use the same CSS (`apps/web/src/styles/switch-fx.scss`).
- **Intensity glow.** Windows glow lime with strength `(e^(4.5·t) − 1)/(e^4.5 − 1)`, where `t = (score − 65)/35`. That gives about 1% at 70, 6% at 80, 24% at 90 and 100% at 100, so only genuinely big moments light up. Each badge shows the last 45 s as a small line graph, seeded from `/api/feeds/recent` after connecting.

### Best of Today

The backend detects moments with hysteresis (enter ≥ 78, exit < 68). It merges peaks within 12 s and cuts a clip with 6 s pre-roll and 3 s post-roll, bounded to 8–24 s. Because the demo media loops, clips covering ≥ 50% of the same footage are de-duplicated, keeping the higher peak. Each highlight stores its thumbnail and intensity curve. "Today" is computed in `HIGHLIGHT_TIMEZONE`. Highlights and intensity history persist under `DATA_DIR` as daily JSON and NDJSON files.

**Captions.** Every highlight gets a neutral template caption until a video description is available. With `GEMINI_API_KEY` set, the backend extracts the exact replay window with FFmpeg, preserves the audio, and sends a compact MP4 to Gemini (`GEMINI_MODEL`, default `gemini-3.6-flash`). Video is encoded at 8 fps, up to 640×360, and sampled by Gemini at 4 fps. The prompt describes the visible sequence and outcome, omits unverified event names and venues from the model input, and avoids invented identities, results or intensity claims. Requests use structured JSON. Extraction is limited to 120 seconds and 14 MB; the complete caption operation has a 120-second timeout. Missing video keeps the fallback rather than generating from metadata alone. Requests are queued with three retries for 429/5xx errors. Captions persist with model, pipeline version and source window, so old captions regenerate after an upgrade. Updates reach clients automatically.

For local development, install `ffmpeg` and set `GEMINI_API_KEY` in the repository `.env` or backend process environment, then restart the backend. Local Node runs load the repository `.env`; explicit process environment values take precedence. `MEDIA_FETCH_BASE` defaults to `http://localhost:5173/media`; override it if the media server uses another address. Docker includes FFmpeg and configures its media origin. `FFMPEG_PATH` can override the binary. Without a key, the admin overview caption status and backend log explain why video descriptions are disabled. Existing highlights are queued for descriptions when the backend starts with a key.

To validate three available highlights from different sports, run `npx tsx scripts/evaluate-captions.ts`. This extracts clips, checks their duration and audio/video tracks with `ffprobe`, and writes a report under `apps/backend/data/caption-evaluation/`. To send those clips to Gemini and save before/after captions, run the same command with `--live` and `GEMINI_API_KEY` configured. Evaluation does not alter saved highlights. `BACKEND_URL`, `MEDIA_FETCH_BASE`, `GEMINI_MODEL`, `FFPROBE_PATH` and `CAPTION_EVAL_DIR` are optional overrides. Model output still needs review against the saved clips; local extraction tests alone do not establish caption quality.

Tile sizes are rank-based within the day (top ~10% large, next ~25% medium, the rest small), which keeps the grid dense. New moments never reflow the grid under you; a pill offers them instead.

## Configuration

Backend environment variables (defaults in brackets):

| Variable | Purpose |
| --- | --- |
| `AMQP_URL` [`amqp://guest:guest@localhost:5672`], `AMQP_QUEUE` [`sportlight.backend`] | Broker and queue. Give each replica its own queue, because state is per instance. |
| `SELECTION_MIN_DISPLAY_MS` [20000], `SELECTION_REPLACE_MARGIN` [10], `SELECTION_CHALLENGE_MS` [3000], `SELECTION_VOTE_UP_BOOST` [8], `SELECTION_VOTE_DOWN_BOOST` [-15] | Selection rules. Sent to clients on connect, so tuning needs no client release. |
| `HIGHLIGHT_ENTER_THRESHOLD` [78], `HIGHLIGHT_EXIT_THRESHOLD` [68], `HIGHLIGHT_PRE_ROLL_SEC` [6], `HIGHLIGHT_POST_ROLL_SEC` [3], `HIGHLIGHT_MIN_CLIP_SEC` [8], `HIGHLIGHT_MAX_CLIP_SEC` [24], `HIGHLIGHT_MERGE_GAP_SEC` [12], `HIGHLIGHT_DEDUPE_BY_MEDIA` [true], `HIGHLIGHT_MAX_PER_DAY` [250], `HIGHLIGHT_TIMEZONE` [`Europe/London`] | Highlight rules. |
| `STALE_AFTER_MS` [5000], `SILENT_AFTER_MS` [15000], `EXPIRE_AFTER_MS` [120000], `ENDED_RETENTION_MS` [60000] | Feed health timings. |
| `GEMINI_API_KEY` [unset], `GEMINI_MODEL` [`gemini-3.6-flash`], `MEDIA_FETCH_BASE` [`http://localhost:5173/media`], `MEDIA_PUBLIC_PREFIX` [`/media`] | Highlight captions. `MEDIA_FETCH_BASE` is where the backend can fetch media; `/media/...` video paths are rewritten onto it. |
| `DATA_DIR` [`./data`], `PORT` [4000], `CORS_ORIGINS` [`*`], `ADMIN_TOKEN` [unset] | Storage, HTTP, and an optional bearer token for `/api/admin/*`. |

Stream metadata: each demo feed carries mock rights-holder metadata (`event.broadcaster`, for example Sky Sports · Sky Sports Football) and a venue. The live tiles, table and captions use it.

Publisher: `SCENARIO_SEED`, `SCENARIO_OFFSET_SEC`, `SCENARIO_SPEED` (schedule only; video always plays in real time), `TICK_MS`, `REANNOUNCE_SEC`, `CHAOS_DUPLICATE_RATE`, `CHAOS_DELAY_RATE`, `CHAOS_INVALID_RATE`, `MEDIA_CATALOG`, `MEDIA_PUBLIC_BASE`.

### The demo scenario

The scenario is a 15-minute cycle (`apps/publisher/src/scenario.ts`) with authored beats that exercise the rules:

- At ~35 s, ice hockey surges for 25 s and replaces a side feed after the 20 s dwell.
- At ~70 s, chess spikes for about 2 s, which must **not** trigger a replacement.
- At 100 s, athletics starts hot.
- At 210 s, tennis ends (immediate replacement); it restarts at 300 s.
- At 240 s, F1 drops out for 22 s (unavailable).
- Basketball ends at 600 s and cycling at 780 s.

## Packaging as an app

The client is a static SPA with relative-capable routing and configurable endpoints, so it wraps cleanly in Capacitor, Tauri or Electron:

```bash
VITE_BASE=./ VITE_ROUTER=hash VITE_API_URL=https://api.example.com VITE_MEDIA_URL=https://media.example.com npm run build -w @sportlight/web
```

It ships a web app manifest and icons (`apps/web/public`). Preferences live in `localStorage`, and the backend allows cross-origin requests via `CORS_ORIGINS`.

## Towards GCP

- **Backend:** Cloud Run (WebSockets supported; use session affinity, `min-instances ≥ 1` and a 60 min request timeout) or GKE. Live feed state rebuilds from the event stream in seconds. Automatic publishing currently requires one backend instance with durable writable storage; migrate its queue and artifacts to managed storage before deploying ephemeral or multiple instances.
- **Broker:** CloudAMQP or RabbitMQ on GKE. The publisher/consumer boundary is the only coupling, so Pub/Sub would also fit behind the same contracts.
- **Media:** Cloud Storage + Cloud CDN for the video origin (HLS for real live streams).
- **Persistence:** `IntensityHistory` and `HighlightStore` hide storage behind small classes. Swap the file implementation for Firestore or Cloud SQL (highlights) and BigQuery (history).

## Tests

```bash
npm test
```

Tests cover the selection engine (placement, dwell, margin and challenge timing, stale challengers, filters, promotion, main-window policy, votes), event ordering in the feed store, moment detection, clip windows, highlight merge and de-dupe, and scenario determinism.


## Content dashboard and automatic YouTube Shorts

Open **/admin** (Admin in the navigation) and scroll to Content. Connect an authorized Google account with an existing YouTube channel. New qualifying highlights are rendered as 1080 × 1920 H.264/AAC MP4s, preserving the full sports frame and original audio, then uploaded with **public visibility, without per-clip review**. Generated highlight captions become the title and description; this release does not burn subtitles into the video. YouTube performs its own processing and visibility checks; the dashboard marks a clip Published only after the API confirms processing and public visibility.

### Setup helper

Run `gcloud auth login` if your CLI session has expired, then from the project directory:

```bash
npm run setup:youtube
```

The helper finds the project named Sportlight without changing your active gcloud project, enables YouTube Data API v3, prepares a private `.env`, and prints project-specific links for creating the Google OAuth Web client. Use `--project YOUR_PROJECT_ID` if discovery is ambiguous. It defaults to the current local development origin `http://localhost:5173`; pass `--origin http://localhost:8080` for Docker.

Google's standard OAuth Web client and consent configuration are completed in Cloud Console. Download the Web client JSON outside this repository, then import it:

```bash
npm run setup:youtube -- --project YOUR_PROJECT_ID --credentials /absolute/path/to/client.json
```

The import checks the project and redirect URI, preserves existing settings and the encryption key, and writes `.env` with owner-only permissions without printing credentials. It defaults the allowed operator email to the active gcloud account; override it with `--email YOUR_GOOGLE_EMAIL` on initial setup. `--skip-cloud --project YOUR_PROJECT_ID --email YOUR_GOOGLE_EMAIL` supports local import when cloud access is unavailable. Reload the environment and restart the service using the commands printed by the helper, then complete channel consent in the dashboard. The helper never completes Google account consent or uploads a video itself.

### Connect Google

1. In your Google Cloud project, enable **YouTube Data API v3**, configure the OAuth consent screen, and create an OAuth client of type **Web application**. In Testing, add your Google account as a test user. Complete Google's production/verification requirements as applicable for your account and scopes; testing credentials can expire and require reconnection.
2. Configure the backend environment (Docker Compose and the local backend read the repository `.env`; explicitly exported environment variables take precedence):

   ```dotenv
   CONTENT_APP_URL=http://localhost:8080
   GOOGLE_CLIENT_ID=your-web-client-id
   GOOGLE_CLIENT_SECRET=your-web-client-secret
   CONTENT_ENCRYPTION_KEY=64-hex-characters-generated-with-openssl-rand-hex-32
   CONTENT_ALLOWED_EMAILS=your-google-account@example.com
   ```

   Use `http://localhost:5173` for local Vite. Register **exactly** `${CONTENT_APP_URL}/api/content/auth/callback` as the OAuth redirect URI. Production must use an HTTPS origin. Keep the dashboard and its `/api/content/*` routes on the same origin; this cookie-based dashboard uses browser routing, not the packaged/hash-router mode.
3. Generate the encryption key once with `openssl rand -hex 32`. Keep it and the persistent data volume backed up together. Do not commit real credentials. Configure `CONTENT_ALLOWED_EMAILS` explicitly; arbitrary Google accounts cannot access the publishing dashboard or connect a destination.
4. Restart/rebuild the backend, open `/admin`, and choose **Continue with Google**. Grant the requested upload and channel-read permissions. Connecting the first channel starts automation for future highlights. Existing highlights are not backfilled. After disconnecting, reconnect and press Resume to restart automation.

OAuth uses offline access, PKCE, browser-bound single-use state, verified Google email allowlisting, HttpOnly/SameSite cookies, and CSRF-protected mutations. Refresh tokens and resumable-upload URLs are encrypted at rest. Credentials never appear in the dashboard API. Dashboard sessions expire after 12 hours or a backend restart; signing out does not stop the worker. Disconnecting removes the locally stored Google refresh token and pauses automation; you can also revoke the app in your Google account permissions. A request already uploading may still complete.

### Automation and recovery

- Defaults: minimum peak **90**, **5 uploads/day**, at least **15 minutes** apart. Adjust these in dashboard Settings. The daily limit uses `HIGHLIGHT_TIMEZONE` and counts upload reservations conservatively, including interrupted attempts.
- The worker runs with the backend while the browser is closed. Highlights settle for 30 seconds (`CONTENT_SETTLE_SECONDS`) before processing. Changed or removed pending highlights are refreshed/skipped. Overlapping footage is suppressed across source loops and highlight IDs.
- Pause prevents new uploads; new moments remain queued. Queue entries expire after 24 hours. Retry uses an existing resumable upload session whenever present; an expired or ambiguous session is flagged for attention and never silently replaced by another upload.
- The dashboard shows processing failures and actual visibility returned by YouTube. Public visibility remains subject to YouTube account, API, processing, and content restrictions. Shorts classification is performed by YouTube from the uploaded vertical video; there is no separate Shorts upload endpoint.
- FFmpeg is installed in the backend Docker image. Local development needs `ffmpeg` (or `FFMPEG_PATH`). `MEDIA_FETCH_BASE` defaults to `http://localhost:5173/media` for local rendering; Compose sets it to `http://media:8080`. Only retained MP4s on that configured origin are accepted.
- Queue state, encrypted connection details, and finished videos live under `DATA_DIR/content`. Atomic serialized JSON snapshots support **one backend instance per data directory**. Do not run multiple publishing workers against this volume. History/artifacts are retained for deduplication and recovery; monitor disk usage. The dashboard displays the latest 500 jobs. A storage failure stops the worker until corrected and restarted.

### Verification and references

`npm test`, `npm run typecheck`, and `npm run build` cover the application and publishing integration. Unit tests exercise public upload metadata, encryption, access control, OAuth state/PKCE, deduplication, persistent recovery, and resuming partial or completed uploads. Real Google OAuth consent and a live upload require configured credentials and a channel; local tests do not establish that Google will accept or publicly expose a video.

Official references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [YouTube uploads](https://developers.google.com/youtube/v3/docs/videos/insert), [resumable uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol), and [Shorts format eligibility](https://support.google.com/youtube/answer/15424877?hl=en).
