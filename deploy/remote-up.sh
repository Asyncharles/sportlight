#!/usr/bin/env bash
# On si-web, as root, from /opt/sportlight-web/releases/<sha>. Called by deploy-reusable.yml.
set -euo pipefail
umask 077
# Secrets are read from Secret Manager at deploy time. The one exception is the Gemini key for
# highlight descriptions, taken from the repository's .env (private repo) so it is set in one place.
# Read it before .env is overwritten below; nothing else from the developer .env reaches the VM.
REPO_GEMINI=$(grep -E '^GEMINI_(API_KEY|MODEL)=' .env 2>/dev/null || true)
{
  gcloud secrets versions access latest --secret=sportlight-web-env | { grep -vE '^GEMINI_(API_KEY|MODEL)=' || true; }; echo
  if [[ -n "$REPO_GEMINI" ]]; then echo "$REPO_GEMINI"; fi
  cat release.env
  echo "COMPOSE_PROJECT_NAME=sportlight-web"   # fixed: volumes survive release dirs
} > .env

# Demo footage (deploy input demo_footage): the four engine demo clips and the 13 tuning clips (extra
# feeds, off for each viewer until they turn them on in Settings), plus posters, thumbnails and catalog,
# pulled from the private bucket and mounted into the media server. Deploying without it deletes the
# footage from this VM.
FOOTAGE=/opt/sportlight-web/footage
BASE_COMPOSE_FILE=docker-compose.yml:docker-compose.external.yml:deploy/compose.gcp.yml
COMPOSE_FILE=$BASE_COMPOSE_FILE
cp .env .env.base   # the site without demo footage, to fall back to
DEMO_FOOTAGE_BUCKET=$(sed -n 's/^DEMO_FOOTAGE_BUCKET=//p' release.env)
DEMO_FEED_SET=$(sed -n 's/^DEMO_FEED_SET=//p' release.env)
if [[ -n "${DEMO_FOOTAGE_BUCKET:-}" ]]; then
  mkdir -p "$FOOTAGE/videos" "$FOOTAGE/local"
  # Demo clips and tuning/; never the striped timing_audio_only/ clips.
  gcloud storage rsync -r --exclude='^timing_audio_only/' "gs://$DEMO_FOOTAGE_BUCKET/samples" "$FOOTAGE/videos" --quiet
  gcloud storage rsync -r "gs://$DEMO_FOOTAGE_BUCKET/sportlight-local" "$FOOTAGE/local" --quiet
  # The videos are mounted inside the read-only local/ mount, so their mount point must already
  # exist on the host: Docker cannot create it inside a read-only mount.
  mkdir -p "$FOOTAGE/local/videos"
  chmod -R a+rX "$FOOTAGE"   # nginx in the media container reads it as a non-root user
  {
    echo "LOCAL_FOOTAGE_DIR=$FOOTAGE/videos"
    echo "LOCAL_MEDIA_DIR=$FOOTAGE/local"
    echo "FEED_SET=${DEMO_FEED_SET:-all}"
    echo "MAX_LIVE_FEEDS=17"   # the 4 demo feeds plus all 13 tuning clips can be on air at once
  } >> .env
  COMPOSE_FILE="$COMPOSE_FILE:docker-compose.local-feeds.yml"
  echo "demo footage: on ($(find "$FOOTAGE/videos" -name '*.mp4' | wc -l) clips, FEED_SET=${DEMO_FEED_SET:-all})"
else
  rm -rf "$FOOTAGE"
  echo "demo footage: off"
fi
echo "COMPOSE_FILE=$COMPOSE_FILE" >> .env
echo "COMPOSE_FILE=$BASE_COMPOSE_FILE" >> .env.base
gcloud auth configure-docker europe-west4-docker.pkg.dev --quiet >/dev/null 2>&1
docker compose config --quiet      # never print the resolved config: it contains secrets

# The engine's demo clips (the files SportlightEngine scores), from the private bucket; top-level
# samples/*.mp4 only, never tuning footage. Never re-encoded: the engine's labels refer to these files.
# With demo footage on, the sync above already has them (in $FOOTAGE/videos, mounted over this).
if [[ -z "${DEMO_FOOTAGE_BUCKET:-}" ]]; then
  mkdir -p "$FOOTAGE" && chmod 755 "$FOOTAGE"
  PATH=$PATH:/snap/bin gcloud storage rsync "gs://${ENGINE_BUCKET:-sportlight-514020-si-private}/samples" "$FOOTAGE" \
    --exclude='.*/.*' --quiet \
    || echo "WARNING: could not sync the engine demo clips; engine feeds will have no video" >&2
  chmod 644 "$FOOTAGE"/*.mp4 2>/dev/null || true
fi

# SportlightEngine publishes the four demo feeds. The publisher runs when asked (MOCK_PUBLISHER=1:
# every feed, as the mock provider) or with demo footage on, where it announces only the extra feeds
# (the tuning clips and the open clips, behind Settings > Extra feeds) and leaves the demo feeds to the
# engine (ENGINE_OWNS_DEMO_FEEDS).
BASE_S="media backend web caddy"
S=$BASE_S
if [[ "${MOCK_PUBLISHER:-0}" == 1 ]]; then
  export COMPOSE_PROFILES=mock
  S="$S publisher"
  BASE_S=$S
elif [[ -n "${DEMO_FOOTAGE_BUCKET:-}" ]]; then
  export COMPOSE_PROFILES=mock
  echo "ENGINE_OWNS_DEMO_FEEDS=1" >> .env
  S="$S publisher"
  echo "publisher: extra feeds only (the engine publishes the demo feeds)"
else
  docker compose --profile mock rm --stop --force publisher >/dev/null 2>&1 || true
fi
docker compose pull --quiet $S
if ! docker compose up -d --no-build --remove-orphans $S; then
  [[ "$COMPOSE_FILE" != "$BASE_COMPOSE_FILE" ]] || exit 1
  # Demo footage must never take the site down: start it without the footage, then still fail the
  # deploy so the footage problem is seen.
  echo "demo footage failed to start; starting the site without it" >&2
  cp .env.base .env
  # Without the footage there are no extra feeds, so the publisher goes too (unless it is the mock).
  [[ "$S" == "$BASE_S" ]] || docker compose --profile mock rm --stop --force publisher >/dev/null 2>&1 || true
  docker compose up -d --no-build --remove-orphans $BASE_S
  rm -f .env.base
  exit 1
fi
rm -f .env.base
