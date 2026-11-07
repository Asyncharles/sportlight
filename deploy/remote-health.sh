#!/usr/bin/env bash
# Healthy = backend's AMQP consumer is active (/readyz) AND nginx serves the API.
# Probes run inside the backend container: nginx doesn't proxy /readyz.
set -euo pipefail
probe='require("http").get(process.argv[1],r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1)).setTimeout(5000,()=>process.exit(1))'
docker compose exec -T backend node -e "$probe" http://127.0.0.1:4000/readyz
docker compose exec -T backend node -e "$probe" http://web:8080/api/feeds
