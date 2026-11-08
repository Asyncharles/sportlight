#!/usr/bin/env bash
# On si-web, as root, from /opt/sportlight-web/releases/<sha>. Called by deploy-reusable.yml.
set -euo pipefail
umask 077
# Secrets are read from Secret Manager at deploy time; none are in the repo or the release.
{
  gcloud secrets versions access latest --secret=sportlight-web-env; echo
  cat release.env
  echo "COMPOSE_PROJECT_NAME=sportlight-web"   # fixed: volumes survive release dirs
  echo "COMPOSE_FILE=docker-compose.yml:docker-compose.external.yml:deploy/compose.gcp.yml"
} > .env
gcloud auth configure-docker europe-west4-docker.pkg.dev --quiet >/dev/null 2>&1
docker compose config --quiet      # never print the resolved config: it contains secrets

# The engine's demo clips (the files SportlightEngine scores), from the private bucket; top-level
# samples/*.mp4 only, never tuning footage. Never re-encoded: the engine's labels refer to these files.
FOOTAGE=/opt/sportlight-web/footage
mkdir -p "$FOOTAGE" && chmod 755 "$FOOTAGE"
PATH=$PATH:/snap/bin gcloud storage rsync "gs://${ENGINE_BUCKET:-sportlight-514020-si-private}/samples" "$FOOTAGE" \
  --exclude='.*/.*' --quiet \
  || echo "WARNING: could not sync the engine demo clips; engine feeds will have no video" >&2
chmod 644 "$FOOTAGE"/*.mp4 2>/dev/null || true

# SportlightEngine is the producer; the mock publisher runs only when asked (MOCK_PUBLISHER=1).
S="media backend web caddy"
if [[ "${MOCK_PUBLISHER:-0}" == 1 ]]; then
  export COMPOSE_PROFILES=mock
  S="$S publisher"
else
  docker compose --profile mock rm --stop --force publisher >/dev/null 2>&1 || true
fi
docker compose pull --quiet $S
docker compose up -d --no-build --remove-orphans $S
