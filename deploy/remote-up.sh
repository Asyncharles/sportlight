#!/usr/bin/env bash
# On si-web, as root, from /opt/sportlight-web/releases/<sha>. Called by deploy-reusable.yml.
set -euo pipefail
umask 077
# Secrets are read from Secret Manager at deploy time; none are in the repo or the release.
{
  gcloud secrets versions access latest --secret=sportlight-web-env; echo
  cat release.env
  echo "COMPOSE_PROJECT_NAME=sportlight-web"   # fixed: volumes survive release dirs
} > .env

# Demo footage (deploy input demo_footage): the four engine demo clips, plus their posters, thumbnails
# and catalog, pulled from the private bucket and mounted into the media server. Deploying without it
# deletes the footage from this VM.
FOOTAGE=/opt/sportlight-web/footage
COMPOSE_FILE=docker-compose.yml:docker-compose.external.yml:deploy/compose.gcp.yml
DEMO_FOOTAGE_BUCKET=$(sed -n 's/^DEMO_FOOTAGE_BUCKET=//p' release.env)
DEMO_FEED_SET=$(sed -n 's/^DEMO_FEED_SET=//p' release.env)
if [[ -n "${DEMO_FOOTAGE_BUCKET:-}" ]]; then
  mkdir -p "$FOOTAGE/videos" "$FOOTAGE/local"
  # Top level of samples/ only: the demo clips, not the tuning clips below it.
  gcloud storage rsync "gs://$DEMO_FOOTAGE_BUCKET/samples" "$FOOTAGE/videos" --quiet
  gcloud storage rsync -r "gs://$DEMO_FOOTAGE_BUCKET/sportlight-local" "$FOOTAGE/local" --quiet
  chmod -R a+rX "$FOOTAGE"   # nginx in the media container reads it as a non-root user
  {
    echo "LOCAL_FOOTAGE_DIR=$FOOTAGE/videos"
    echo "LOCAL_MEDIA_DIR=$FOOTAGE/local"
    echo "FEED_SET=${DEMO_FEED_SET:-local}"
  } >> .env
  COMPOSE_FILE="$COMPOSE_FILE:docker-compose.local-feeds.yml"
  echo "demo footage: on ($(ls "$FOOTAGE/videos" | wc -l) clips, FEED_SET=${DEMO_FEED_SET:-local})"
else
  rm -rf "$FOOTAGE"
  echo "demo footage: off"
fi
echo "COMPOSE_FILE=$COMPOSE_FILE" >> .env
gcloud auth configure-docker europe-west4-docker.pkg.dev --quiet >/dev/null 2>&1
docker compose config --quiet      # never print the resolved config: it contains secrets
S="media backend publisher web caddy"
docker compose pull --quiet $S
docker compose up -d --no-build --remove-orphans $S
