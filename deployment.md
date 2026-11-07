# Sportlight deployment handoff

## Scope and intended deployment

This is a single-instance PoC. Deploy one backend with a persistent writable `/data` volume, the web nginx container, a media origin, and the mock publisher if demo feeds are wanted. RabbitMQ can be external. Do not enable backend autoscaling: feed state, votes, sessions and worker ownership are process-local. The user explicitly accepts PoC admin/security defaults and has deferred automatic retention and scaling work.

The repository contains ongoing local changes; include required untracked source files when preparing a release. Do not commit `.env`, media caches, runtime data or credentials. Build images from the complete checkout.

## Broker information to obtain

Ask the broker operator for:

- AMQP hostname (not the management UI URL), port, and whether TLS is required. Usually TLS uses 5671 and plain AMQP uses 5672.
- Username, password, and virtual host; URL-encode each credential and the vhost. The default `/` vhost is `%2F`.
- CA trust requirements. For a private CA, mount its PEM certificate and set `NODE_EXTRA_CA_CERTS` in both Node containers. Never disable certificate verification. Client-certificate authentication needs additional connection configuration; it is not implemented here.
- Network access rules allowing both backend and publisher to reach that hostname/port.
- Permission to declare exchanges/queues, bind queues, consume, and publish in the chosen vhost. A dedicated PoC vhost with configure/read/write permissions is simplest.
- Any predeclared topology, queue type and policy constraints. Existing declarations must match the application's arguments, or RabbitMQ will reject them.

Example (place real credentials in the deployment secret store or private `.env`):

```dotenv
AMQP_URL=amqps://sportlight:URL_ENCODED_PASSWORD@broker.example.net:5671/%2F?heartbeat=30
AMQP_QUEUE=sportlight.backend
CONTENT_APP_URL=https://sportlight.example.com
```

The backend declares durable topic exchange `sportlight.feeds`, durable fanout dead-letter exchange `sportlight.feeds.dlx`, durable dead-letter queue `sportlight.feeds.dead` (24-hour message TTL), and the durable consumer queue (`AMQP_QUEUE`, default `sportlight.backend`). The consumer queue binds `feed.#`, has maximum length 100000, and dead-letters to `sportlight.feeds.dlx`. Queue type is not explicitly selected; agree on broker defaults/policies before provisioning. The application needs AMQP 0-9-1.

A real producer must follow `packages/shared/src/events.ts` and `schemas.ts`: schema version 1, unique event IDs, increasing sequence per run, lifecycle events and timestamped intensity readings. Repeat feed-start announcements so a restarted backend can rebuild state. The included publisher is a looping-media simulation, not a real sports provider.

## Build and start

Use a recent Docker Compose supporting `!override`. The base Compose file uses local RabbitMQ when `AMQP_URL` is blank. For an external broker:

```sh
docker compose -f docker-compose.yml -f docker-compose.external.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.external.yml up -d --build media backend publisher web
```

Select those services explicitly: running `up` without a service list also starts the local RabbitMQ service. If replacing the mock publisher, omit it. The external override removes the local broker startup dependency. Do not print resolved Compose configuration into shared logs: it contains secrets.

The media build downloads/transcodes replay assets unless `media/dist` is supplied. Prepare this ahead of deployment; network availability and source availability affect the build. A separate bucket/CDN can replace the media origin, but update nginx routing, publisher media URLs, and backend `MEDIA_FETCH_BASE` together. Both caption extraction and publishing need retained MP4 media reachable from the backend.

## DNS, HTTPS and routing

Choose a public hostname such as `sportlight.example.com`. Create an A record pointing to a VM's reserved public IPv4 address, or the CNAME requested by your hosting/load-balancer provider. Only create an AAAA record if IPv6 actually reaches the service. An apex domain may need the DNS provider's ALIAS/flattening feature instead of CNAME.

Terminate HTTPS at a cloud load balancer or reverse proxy with a certificate covering that hostname. Forward requests to the web container on port 8080, preserving the request path and WebSocket upgrade. Redirect HTTP to HTTPS. DNS only resolves the address; it does not configure TLS, ports or application routing.

The web nginx configuration routes `/api/` and `/ws` to `backend:4000`, `/media/` to `media:8080`, and other paths to the SPA. Preserve these internal service DNS names or change `docker/web.nginx.conf`. Keep the browser on one public origin so cookies, API calls, media and WebSockets work together. Configure the outer proxy for WebSocket upgrades and a suitably long idle timeout. Native container platforms need equivalent internal service routing.

Set `CONTENT_APP_URL` to the exact public HTTPS origin. For Google publishing, register `https://sportlight.example.com/api/content/auth/callback` as an authorized OAuth redirect URI. Supply `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, a stable 64-hex-character `CONTENT_ENCRYPTION_KEY`, and `CONTENT_ALLOWED_EMAILS`. Keep the encryption key backed up with `/data`. Captioning additionally uses `GEMINI_API_KEY`. Public publishing is enabled by the content settings when an authorized channel is connected.

The existing Compose ports and optional admin token are PoC defaults. If placing behind a public proxy, restrict direct backend/broker access at the host/network boundary. Set `ADMIN_TOKEN` if admin protection is desired; the dashboard accepts that bearer token.

## Storage and recovery

Persist and back up `/data`. History readings append to daily NDJSON with a synchronous flush before the event handler returns. Highlight snapshots are synchronously flushed then renamed. This is intentionally lightweight and can block the event loop under high disk latency; it is appropriate for the small PoC, not high-throughput ingestion.

This is not an exactly-once transactional event store. Live feed state, deduplication and unfinished moments are still in memory, and history files are not replayed on startup. A processing/storage error is dead-lettered; inspect the DLQ after failures. Publisher lifecycle events are persistent and use confirmation callbacks with in-memory retry buffering; process termination can still lose that buffer. Intensity events are deliberately not retained by the publisher while disconnected.

The admin dashboard's **Clear old archives** action deletes history/highlight files whose date and last modification are both more than seven days old. It asks for confirmation and reports file count and bytes reclaimed. Recent archives, OAuth credentials, publishing job records and rendered videos are preserved. There is no automatic retention. Do not delete active publishing state or videos while a job is uploading; stop the service before any manual full reset and back up first. Archive cleanup does not delete source media or videos already published to YouTube.

## Deployment checks

Run `npm test`, `npm run typecheck`, and `npm run build` before release. Verify `/healthz` and `/readyz` directly against the backend inside the deployment network: the former is liveness; the latter must return 200 only while the AMQP consumer is active. The web nginx does not proxy these paths.

Verify the public page, deep links, `/api/feeds`, `/ws` upgrade, and video range requests through HTTPS. Confirm event counts advance in the admin dashboard. Restart the broker connection and check automatic recovery. Cancel/delete a test consumer queue and verify recovery in an isolated test vhost. Restart the backend and verify stored highlights remain and feed announcements repopulate live state. Exercise cleanup with disposable archives before using it on retained data.

Dependency advisories and the older Docker Node pin were identified in review and remain separate follow-up work. No cloud resources, DNS records, credentials, live Google consent or public deployment have been created by these code changes.
