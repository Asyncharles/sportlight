#!/usr/bin/env bash
docker compose ps
docker compose logs --tail 80 --no-color media backend publisher web caddy
