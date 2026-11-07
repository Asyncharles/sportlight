# Sportlight

**The moment is now.** A sports viewing prototype that watches many live feeds at once and puts the most intense moments in your sports on screen: one main window, three side windows, and a "Best of Today" reel.

![layout](UI-sketch.png)

## Quick start

```bash
docker compose up --build
```

Open **http://localhost:8080**. RabbitMQ's management UI is at http://localhost:15672 (guest / guest), and the stream admin view is at http://localhost:8080/admin.

The first build downloads about 190 MB of openly licensed footage from Wikimedia Commons and transcodes it, which takes a few minutes. After that the media image is cached. If a download fails, that clip falls back to a synthetic test pattern so the stack still runs offline.

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
| `apps/web` | Vite + React + TypeScript + SCSS client: onboarding, live view, Best of Today, settings and admin. |
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
| Highlights | **Known time ranges** in the bundled media. No recording or transcoding at runtime. |
| Demo media | **Openly licensed clips from Wikimedia Commons** (CC BY / BY-SA / public domain). Credits are in Settings → About and in `media/dist/CREDITS.md`. |

### Feed selection (`packages/shared/src/selection.ts`)

Selection is pure, deterministic and unit-tested. It runs per viewer on their own device, so preferences differ freely, and each viewer reports what they show to the backend for the admin view.

- **Eligible** means live and matching the viewer's follows. A feed that stops being eligible leaves its window immediately.
- **Rank** is the provider intensity plus the viewer's own vote (+8 up, −15 down). Votes are separate from intensity. They are stored per run and aggregated on the backend.
- Empty side windows fill immediately. A side feed is **replaced** only after it has been visible for **20 s**, when a fresh challenger beats the weakest such side feed by **≥ 10 points for 3 consecutive seconds**. At most one replacement happens per pass, and windows never reorder because scores change.
- Clicking a side feed **promotes** it: it swaps with the main feed, and both restart their minimum display time.

### Playback and animation

- Each feed keeps one `<video>` element for as long as it is on screen. Promotion animates the same element's position and size (220 ms), so playback never restarts.
- A replacement mounts the incoming player invisibly on top. It waits for an actual decoded frame (`requestVideoFrameCallback`), then crossfades over the outgoing one, so there are no blank frames or flashes.
- Small drift from the live edge is corrected by nudging `playbackRate`; large drift (stalls, background tabs) by seeking.
- Only the main window can play audio, and only once the viewer unmutes. Audio follows the main window when it changes.
- Controls appear on hover, keyboard focus or tap. A small intensity badge and a 3 px meter are always visible. `prefers-reduced-motion` (or Settings → Motion) removes the motion.

### Best of Today

The backend detects moments with hysteresis (enter ≥ 78, exit < 68). It merges peaks within 12 s and cuts a clip with 6 s pre-roll and 3 s post-roll, bounded to 8–24 s. Because the demo media loops, clips covering ≥ 50% of the same footage are de-duplicated, keeping the higher peak. Each highlight stores its thumbnail and intensity curve. "Today" is computed in `HIGHLIGHT_TIMEZONE`. Highlights and intensity history persist under `DATA_DIR` as daily JSON and NDJSON files.

Tile sizes are rank-based within the day (top ~10% large, next ~25% medium, the rest small), which keeps the grid dense. New moments never reflow the grid under you; a pill offers them instead.

## Configuration

Backend environment variables (defaults in brackets):

| Variable | Purpose |
| --- | --- |
| `AMQP_URL` [`amqp://guest:guest@localhost:5672`], `AMQP_QUEUE` [`sportlight.backend`] | Broker and queue. Give each replica its own queue, because state is per instance. |
| `SELECTION_MIN_DISPLAY_MS` [20000], `SELECTION_REPLACE_MARGIN` [10], `SELECTION_CHALLENGE_MS` [3000], `SELECTION_VOTE_UP_BOOST` [8], `SELECTION_VOTE_DOWN_BOOST` [-15] | Selection rules. Sent to clients on connect, so tuning needs no client release. |
| `HIGHLIGHT_ENTER_THRESHOLD` [78], `HIGHLIGHT_EXIT_THRESHOLD` [68], `HIGHLIGHT_PRE_ROLL_SEC` [6], `HIGHLIGHT_POST_ROLL_SEC` [3], `HIGHLIGHT_MIN_CLIP_SEC` [8], `HIGHLIGHT_MAX_CLIP_SEC` [24], `HIGHLIGHT_MERGE_GAP_SEC` [12], `HIGHLIGHT_DEDUPE_BY_MEDIA` [true], `HIGHLIGHT_MAX_PER_DAY` [250], `HIGHLIGHT_TIMEZONE` [`Europe/London`] | Highlight rules. |
| `STALE_AFTER_MS` [5000], `SILENT_AFTER_MS` [15000], `EXPIRE_AFTER_MS` [120000], `ENDED_RETENTION_MS` [60000] | Feed health timings. |
| `DATA_DIR` [`./data`], `PORT` [4000], `CORS_ORIGINS` [`*`], `ADMIN_TOKEN` [unset] | Storage, HTTP, and an optional bearer token for `/api/admin/*`. |

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

- **Backend:** Cloud Run (WebSockets supported; use session affinity, `min-instances ≥ 1` and a 60 min request timeout) or GKE. It is stateless apart from in-memory feed state, which rebuilds from the event stream in seconds.
- **Broker:** CloudAMQP or RabbitMQ on GKE. The publisher/consumer boundary is the only coupling, so Pub/Sub would also fit behind the same contracts.
- **Media:** Cloud Storage + Cloud CDN for the video origin (HLS for real live streams).
- **Persistence:** `IntensityHistory` and `HighlightStore` hide storage behind small classes. Swap the file implementation for Firestore or Cloud SQL (highlights) and BigQuery (history).

## Tests

```bash
npm test
```

Tests cover the selection engine (placement, dwell, margin and challenge timing, stale challengers, filters, promotion, main-window policy, votes), event ordering in the feed store, moment detection, clip windows, highlight merge and de-dupe, and scenario determinism.
