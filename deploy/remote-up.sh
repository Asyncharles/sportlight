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
S="media backend publisher web caddy"
docker compose pull --quiet $S
docker compose up -d --no-build --remove-orphans $S
