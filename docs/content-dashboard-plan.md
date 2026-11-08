# Sportlight content dashboard plan

> Historical design proposal. The subsequent request superseded private-only uploads: the implemented dashboard publishes public Shorts automatically, without per-clip review. See README → Content dashboard and automatic YouTube Shorts for the current implementation, setup, and limits. The broader editing/subtitle/outbox features below remain proposals.

## Outcome and scope

Create a content workspace at `/dashboard` that automatically turns detected highlights into standalone vertical videos and uploads them privately to one connected YouTube channel. The dashboard is where the operator sees what was detected, previews the finished content, adjusts automation, and resolves failures.

The existing `/admin` stream monitoring page stays available as Streams. The dashboard links to it. Best of Today remains the viewer-facing highlights experience.

This is an implementation plan; no account connection, uploads, or application changes have been made yet.

## Design direction

Use the existing Sportlight brand: Manrope headings/body, IBM Plex Mono for times and technical values, lime #C5FF00 for primary actions, ink #171917, paper #F7F8F4, and Lucide icons. Support existing light/dark preferences. Use restrained borders, clear typography, and video thumbnails as the main visual elements.

Desktop layout:

```text
SPORTLIGHT    Live    Best of Today    Content    Settings

Content dashboard             YouTube: channel name · Private
Automatic uploads active      [Pause automation] [Settings]

[Detected today]  [In progress]  [Uploaded privately]  [Needs attention]

All clips | In progress | Uploaded | Needs attention | Skipped
[Search event or title] [Sport] [Date] [Sort: newest]

CLIP LIBRARY                           SELECTED CLIP
thumbnail  title / event               vertical rendered-video preview
           sport · duration · peak     [Original | Final render]
           Rendering / Uploaded        Title
           detected time               Description and tags
                                       Captions / audio / layout
thumbnail  title / event               Status and activity
           ...                         [Save changes] [Retry / Skip]
                                       [Open in YouTube Studio]
```

The library takes approximately two thirds of the main area; the inspector takes one third. Rows have large enough thumbnails to recognise the action, with concise metadata rather than a dense operational table. Selection stays stable as new clips arrive. A small 'New clips' action reveals new arrivals without moving the row being edited.

On tablet, open the inspector in a drawer. On mobile, use a single column with a full-screen detail view. All filters, status labels, controls, and previews work with keyboard navigation; respect reduced motion. Do not autoplay sound.

## Dashboard behaviour

### Header and summary

- Show the connected channel, connection health, and a persistent Private uploads badge.
- Global Pause automation stops new jobs from starting. An in-flight request may finish; show that explicitly. Resume continues pending work.
- Summary values come from backend job records, scoped to the selected day in Europe/London by default. They are content counts, not estimated audience analytics.
- Needs attention includes rendering failures, rejected uploads, authentication problems, and jobs needing upload reconciliation.

### Library and filters

Each row shows source thumbnail, generated title, event, sport, duration, peak intensity, detection time, processing status, and private visibility once uploaded. Filters cover date, sport, status, and title/event search. Default to all sports: operator content choices are independent of viewer preferences.

Use the following states with readable explanations:

`Detected → Preparing → Rendering → Queued → Uploading → Processing on YouTube → Uploaded privately`

Additional states: `Skipped`, `Failed`, and `Needs attention`. A disconnected account blocks the upload stage while retaining the rendered asset. YouTube accepting an upload does not mean it has finished processing.

### Clip inspector

- Preview the actual final video, including overlays and captions. Allow comparison with the original source segment.
- Edit title, description, and tags before upload. Changes to caption text/layout invalidate the existing render and create a new revision.
- Show caption/script generation status and distinguish source audio subtitles from generated editorial overlay text.
- Display a small source timeline with current in/out points and peak location. Manual trim adjustment can follow the initial release; read-only bounds are sufficient for the first version.
- Show a concise activity timeline: detected, generated, rendered, upload started, processing completed, or a useful failure message.
- Allow Skip for pending clips, Retry for known failures, Download rendered video, and Open in YouTube Studio after upload.
- Lock the job's content snapshot when upload starts. Later edits become a draft revision and never silently create another upload. Editing an already uploaded YouTube video is outside the first release.

### Connection and empty states

- No channel: show Connect YouTube, explain that uploads are private, and keep the clip library usable.
- No highlights: show that Sportlight is waiting for moments and link to Streams.
- No filter matches: offer Clear filters.
- Expired/revoked authorisation: show Reconnect YouTube; retain pending jobs.
- Backend disconnected: keep the last snapshot visible with its last updated time, and disable mutations until reconnected.

## Automation settings

Initial proposed defaults, editable in the dashboard:

| Setting | Initial value |
| --- | --- |
| Destination | One connected YouTube channel |
| Visibility | Private, enforced by backend; no public visibility control in v1 |
| Eligible sports | All; configurable separately from viewing preferences |
| Minimum peak intensity | 90 |
| Daily upload cap | 5 |
| Minimum time between uploads | 15 minutes |
| Clip length | Existing 8–24 second highlight bounds |
| Output | 1080 × 1920 MP4, H.264 video, AAC audio when present |
| Layout | Full landscape frame inside a vertical Sportlight composition |
| Generated title and description | Enabled, using current captioner and template fallback |
| On-screen editorial text | Enabled; fitted to the clip duration |
| Spoken AI commentary | Optional follow-up; source audio is the initial default |

Automatically process new eligible highlights after the channel is connected and automation enabled. Do not require per-clip approval. Historical highlights are not uploaded automatically when connecting or reconnecting; offer an explicit Queue selected action for backfill. Store skip reasons such as 'Below intensity threshold', 'Daily limit', and 'Duplicate footage'. Rate-limited eligible clips remain queued and are rechecked before upload. Default to expiring queued clips after 24 hours so a backlog does not grow indefinitely.

Upload timing is controlled by the backend. Do not use YouTube's `status.publishAt`, which schedules public publication rather than a private upload.

## Content preparation

The current `Highlight` already contains source URL, `clip.mediaStart`, `clip.mediaEnd`, event metadata, intensity curve, and generated caption. It does not contain a rendered video file.

Add a separate renderer worker using FFmpeg. Preserve the full sports frame in a vertical layout so the initial version does not crop away action. Place the event/title above or below it with safe margins and a restrained Sportlight mark. Keep subtitle text readable and clear of the source action. Handle sources with no audio.

Use the existing template/Gemini caption pipeline for titles and descriptions. Set a bounded wait for model output, then use the template fallback so generation failure cannot block the queue indefinitely. Snapshot the chosen output for each render revision.

True speech subtitles require transcription and timestamps. Generated editorial text is labelled separately. Optional spoken commentary requires a short grounded script, a TTS provider, timing, and ducking the original audio. Add that after the private upload workflow works end to end; use the actual clip or reliable event data for factual narration, rather than inferring specific plays from intensity alone.

## Backend and persistence

1. Add shared contracts for content items, render revisions, upload jobs, channel connection summary, automation settings, and job events.
2. Introduce a persistent job store, initially SQLite on the existing single-instance persistent volume, behind a repository interface. Keep it separate from the daily highlight JSON files. Use a managed relational database before deploying multiple replicas or workers sharing a distributed filesystem.
3. Retain the content item and source snapshot independently of the live highlight store, so a highlight being merged/pruned does not erase upload history. For current demo MP4s the source file is persistent; future live feeds will need retained media before rendering.
4. Queue only settled highlight revisions. The existing detector has a merge delay, but store updates can still merge/replace highlights; cancel superseded pending work and freeze source/caption/settings before rendering.
5. Use a durable outbox to publish renderer/upload jobs to RabbitMQ, with acknowledgements after durable state changes. Workers acquire leases so redelivery does not run the same job concurrently.
6. Identify candidate content using source/run/timeline provenance, and apply media-overlap suppression across highlight IDs, including looping demo footage. Do not depend on a changing highlight ID alone for upload deduplication.
7. Add separate render and upload workers so FFmpeg cannot block live metadata processing. Start with concurrency one per stage. Preserve successful renders for upload retries.
8. Store channel ID, YouTube video ID, resumable-upload session, artifact path, processing status, attempt count, next retry time, settings version, and timestamps.
9. On ambiguous upload completion, resume or reconcile the existing session. Do not blindly create a new video if the upload might already have succeeded; flag unresolved cases for attention.
10. Poll YouTube processing status with backoff until success/failure. Persist completion and expose a Studio link.
11. Expose authenticated `/api/admin/content`, `/api/admin/content/:id`, `/api/admin/content/settings`, `/api/admin/youtube/*`, and narrowly scoped job action endpoints. Add request schemas and enforce authorisation for every read/mutation/callback initiation; OAuth callback validates state. OAuth secrets and refresh tokens remain server-side and encrypted at rest.
12. Provide paginated content snapshots and incremental status updates over WebSocket, with snapshot refresh after reconnect. Never send credentials in snapshots, events, or logs.

Pause, disconnect, and cancellation operate on pending work; expose any in-flight completion clearly. Persist automation state across backend restarts. Use bounded retries/backoff for temporary failures; require reconnection for revoked credentials and attention for permanent media errors. Enforce upload quotas and the daily cap at dispatch time with an atomic reservation, not just when a clip is first queued.

## YouTube setup

The user will create a YouTube channel. A Google account alone is not enough: complete channel creation before connecting it.

The integration also needs a Google Cloud project with YouTube Data API enabled, an OAuth web client, configured redirect URI, and consent screen. Request upload access plus the minimum read scope needed to verify the destination channel and processing status. Use offline access for refresh tokens. Handle Google OAuth consent/testing restrictions explicitly in setup documentation, including possible short-lived refresh tokens while an external app remains in Testing.

Set `status.privacyStatus = private` on every upload regardless of client input. Show the actual selected channel clearly after OAuth. Do not schedule public release. The operator completes account consent once; subsequent uploads run from the backend while the dashboard is closed, until credentials expire or are revoked.

## Delivery sequence

1. Build the `/dashboard` layout and shared contracts, with realistic fixture states for every stage. Add Content to navigation and link Streams from the dashboard.
2. Wire the library, inspector, filters, settings, and live updates to persistent content APIs. Model source/caption revisions and skip reasons.
3. Implement FFmpeg rendering, artifact storage/downloads, and final previews using existing demo MP4s. Validate the finished files visually and with ffprobe.
4. Implement Google OAuth, channel verification, private resumable uploads, processing checks, and recovery from interrupted uploads.
5. Connect automatic candidate selection, settled-revision handling, cap/spacing rules, pause/resume, and failure recovery. Enable end-to-end operation after the user supplies account consent and OAuth configuration.
6. Add optional transcription and spoken commentary, with previewable scripts and audio controls.

## Acceptance checks

- New eligible moments automatically become private videos on the connected channel while the dashboard is closed.
- No upload can become public through this version's API or UI.
- The final rendered preview matches the uploaded asset and preserves the full source frame; captions fit and audio plays correctly when present.
- Low-intensity clips, superseded highlights, repeated loop footage, and explicit skips do not produce duplicate uploads.
- Daily caps and spacing survive restart, parallel requests, and RabbitMQ redelivery.
- Render/upload failures are visible, retryable when appropriate, and never stop live viewing.
- Restart during rendering, upload, or YouTube processing recovers without silently creating another video.
- Disconnect/reconnect retains job history and queue state; no historical bulk upload occurs without an explicit action.
- Keyboard navigation, mobile inspector, light/dark themes, loading, empty, and disconnected states are checked in the browser.
- Run existing typecheck/build/tests, plus focused tests for eligibility, private visibility, durable job transitions, deduplication, OAuth state validation, and interrupted upload recovery. Live upload verification requires the user's channel and OAuth consent; mocks alone cannot verify that integration.

## Official references

- YouTube upload endpoint and supported metadata: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- Video visibility, processing status, and publication scheduling: https://developers.google.com/youtube/data/reference/rest/v3/videos
- OAuth server flow and offline access: https://developers.google.com/identity/protocols/oauth2/web-server
- Shorts aspect ratio and duration eligibility: https://support.google.com/youtube/answer/15424877?hl=en
