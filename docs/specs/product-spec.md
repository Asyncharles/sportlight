# Sportlight
**The moment is now.**

## Product goal

Build a sports viewing platform that helps users watch the most exciting moments happening across multiple events.

Each live feed has a continuously updated intensity score. Combine those scores with the user’s sport preferences to decide which feeds to display.

The experience should feel exceptionally clean, immediate, and focused on video. Prioritise visual polish, stable playback, and satisfying transitions.

## Scope

Create a working prototype with:

- Onboarding and sport selection.
- A live viewing page.
- A “Best of Today” highlights page.
- A simple settings page.
- A TypeScript backend consuming RabbitMQ events.
- A mock feed publisher with playable videos and changing intensity scores.
- Docker configuration for running the complete application.

Real provider integrations and intensity calculation are outside this prototype. Intensity scores are supplied by the mock publisher.

Create this so it can easily be packaged as an app if needed. 

Create an admin view of streams which speaks to the backend. It should provide an clear view into what feeds are live, their state, how behind they are etc. 

## Visual direction

Use the supplied assets:

- [`docs/ui-sketch.png`](../ui-sketch.png) for the layout and interaction direction.
- [`brand.css`](../../brand.css) for brand tokens.
- `/logos` for the logo assets, when supplied.

The brand uses Manrope, IBM Plex Mono, lime `#C5FF00`, ink `#171917`, and paper `#F7F8F4`. Extend these into coherent light and dark themes.

Use Lucide icons.

Design principles:

- Video dominates the screen.
- Keep navigation and controls minimal.
- Use restrained borders, spacing, and rounded corners.
- Make transitions fast, subtle, and consistent.
- Avoid excessive pulsing, movement, or decorative dashboard elements.
- Respect reduced-motion preferences.

## Onboarding and preferences

Show a welcome screen with the logo, tagline, and a short animated illustration of the windowed viewing experience.

The main action is “Choose your sports”.

Let users select multiple sports from a hardcoded catalogue. They can update their selections later.

**Suggested prototype default:** no authentication; save preferences and theme locally in the browser.

Keep the data model extensible to leagues, teams, and competitions.

## Live viewing page

Follow the desktop sketch:

- Three smaller video windows stacked on the left.
- One large main video on the right.
- A compact header with the logo, live indicator, navigation to “Best of Today”, and settings.

Display up to four distinct eligible feeds. Handle fewer than four feeds gracefully.

Each feed has:

- A stable ID.
- Sport and event metadata.
- A playable media source.
- Live status.
- Current intensity score and update timestamp.

### Selection and replacement

Select feeds using intensity and the user’s sport preferences.

Keep the layout stable as scores change. Do not continuously reorder visible windows.

**Suggested starting behaviour, subject to confirmation:**

- Use intensity scores from 0–100.
- Initially place the highest-ranked feed in the main window.
- Keep each automatically selected feed visible for at least 20 seconds.
- Replace the lowest-ranked eligible side feed when a new candidate exceeds its score by at least 10 points for 3 consecutive seconds.
- Replace a feed immediately if it ends or becomes unavailable.
- Apply explicit user actions and filter changes immediately.
- Make timing and threshold values configurable.

Clicking a side feed promotes it into the main window. Preserve playback continuity during the transition.

**Main-window policy remains to be confirmed:** whether it automatically follows intensity or remains on the user’s selection.

### Playback and controls

Side videos play muted. Only the main video may have audio, after the user enables it.

Show playback and voting controls on hover or keyboard focus; make them accessible on touch devices.

Keep a restrained intensity indicator visible so the live state is understandable without hovering.

Provide:

- Play/pause.
- Mute/unmute.
- Fullscreen for the main video.
- Upvote/downvote interactions.
- A “Go live” action if pausing allows playback to fall behind.

Define voting behaviour separately from the supplied intensity score.

Handle loading, buffering, ended feeds, stale intensity updates, disconnection, and an empty filtered selection.

## Animation

Animate feed promotion and replacement without flashing, blank frames, or unnecessary player restarts.

Use short transitions, approximately 180–250 ms as a starting point.

Prioritise stable window positions and uninterrupted playback. Do not resize the entire live layout on every intensity update.

## Best of Today

Show the highest-intensity moments recorded during the day.

Use a denser layout than the live page, with larger tiles for more intense moments. Use a small number of tile sizes to keep the layout orderly.

Each highlight should include:

- Event and sport.
- Thumbnail.
- Clip duration.
- Peak intensity.
- Time of occurrence.

Selecting a highlight opens a larger player with other highlights alongside it for exploration.

Apply the user’s sport filters here too.

Avoid creating many overlapping clips from the same moment. Highlight thresholds, clip duration, merging rules, and the timezone defining “today” must be configurable.

Store intensity history and enough media to replay each retained highlight.

**Prototype decision to confirm:** whether to record and cut actual streams or generate highlights from known time ranges in bundled demo videos.

## Frontend

Use:

- Vite.
- React.
- TypeScript.
- SCSS.
- Lucide icons.

Use shared, typed contracts for backend messages.

The browser receives feed lifecycle and intensity updates over a WebSocket connection.

**Proposed media boundary:** use WebSockets for metadata and intensity updates, with video delivered through a separate media URL. Confirm the intended video transport before implementation.

Support automatic reconnection and restore the current feed snapshot after reconnecting.

## Backend and event flow

Implement the backend in TypeScript.

The intended flow is:

Mock publisher → RabbitMQ → backend → browser WebSocket.

Consume events for:

- Feed started.
- Intensity updated.
- Feed metadata or source updated.
- Feed ended.

Include feed IDs, timestamps, and ordering information so duplicate or delayed events do not restore outdated state.

Associate intensity updates with the media timeline so highlights replay the correct moment.

Keep authoritative feed state and intensity history on the backend. Keep each viewer’s display selection separate so users can have different preferences.

The target hosting environment is GCP. The specific deployment service and persistent storage are still to be selected.

## Mock environment

Run a real RabbitMQ broker locally, with a separate mock publisher simulating providers.

Use a hardcoded catalogue of sports and demo feeds.

The simulator should:

- Supply playable video sources.
- Publish changing intensity values.
- Create sustained peaks and quieter periods.
- Start and end feeds during a session.
- Exercise replacement thresholds and minimum display times.
- Offer a repeatable demo scenario.

Keep mock publishing separate from the application backend so real providers can replace it later.


