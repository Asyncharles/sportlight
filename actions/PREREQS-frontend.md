# Front-end deploy: human prerequisites

Run these from your default gcloud config, not `si-agent`. They add to the handoff's prerequisites 1–5, which must already be done. Replace `<GH_OWNER>`, `<WEB_REPO>` and `sportlight.example.com`.

```bash
P=sportlight-514020; PN=251387512246; R=europe-west4; OWNER=<GH_OWNER>; WEB_REPO=<WEB_REPO>
```

## 1. Let the front-end repo use `si-ci`

```bash
gcloud iam service-accounts add-iam-policy-binding si-ci@$P.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PN/locations/global/workloadIdentityPools/github/attribute.repository/$OWNER/$WEB_REPO"
```

`si-ci` needs nothing else. `si-web` runs as `si-vm-sa`, which `si-ci` can already act as, and it carries the `si` tag for IAP SSH.

## 2. Public address and HTTPS ports, for the web VM only

```bash
gcloud compute addresses create si-web-ip --region=$R
gcloud compute addresses describe si-web-ip --region=$R --format='value(address)'
gcloud compute firewall-rules create si-web-public --network=default \
  --allow=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=si-web
```

Then create a DNS A record `sportlight.example.com` → that address **before** the first deploy, so Caddy can get its certificate.

## 3. App secrets (one Secret Manager secret holding the private .env)

```bash
APP_PW_ENC=$(gcloud secrets versions access latest --secret=rabbitmq-app-password \
  | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(),safe=""))')

cat > web.env <<EOF
PUBLIC_HOST=sportlight.example.com
CONTENT_APP_URL=https://sportlight.example.com
AMQP_URL=amqp://app:$APP_PW_ENC@si-mq.europe-west4-a.c.$P.internal:5672/sportlight?heartbeat=30
AMQP_QUEUE=sportlight.backend
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CONTENT_ENCRYPTION_KEY=$(openssl rand -hex 32)
CONTENT_ALLOWED_EMAILS=...
GEMINI_API_KEY=...
ADMIN_TOKEN=$(openssl rand -hex 24)
EOF
# edit the ... values, then:
gcloud secrets create sportlight-web-env --replication-policy=user-managed --locations=$R --data-file=web.env
gcloud secrets add-iam-policy-binding sportlight-web-env \
  --member=serviceAccount:si-vm-sa@$P.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
shred -u web.env
```

- The password must be URL-encoded: `openssl rand -base64` output can contain `/`, `+` and `=`.
- `CONTENT_ENCRYPTION_KEY` must never change once OAuth credentials are stored. When you add a new secret version for any other value, copy the key over unchanged.
- To change a value, add a new secret version and redeploy; `remote-up.sh` reads `latest` on every deploy.

## 4. Google OAuth

Add `https://sportlight.example.com/api/content/auth/callback` as an authorized redirect URI.

## 5. GitHub, front-end repo

- Same repository variables as the engine repo: `GCP_PROJECT`, `GCP_REGION`, `GCP_ZONE`, `GCP_WIF_PROVIDER`, `GCP_CI_SA`, `AR_REPO`.
- `DEMO_FREEZE_AT` (e.g. `2026-11-08T18:00:00Z`) on **both** repos.
- Environment `demo`: you as required reviewer, `main` only.
- Branch protection on `main` with `ci` required; workflow permissions read-only.
- In `sports-intensity` → Settings → Actions → General → Access: allow repositories owned by `<GH_OWNER>` (needed if the repos are private).

## 6. The VM (for the agent as `si-deployer`, never Actions)

`si-web`: `e2-medium`, Ubuntu 24.04, `pd-balanced` 30 GB, `europe-west4-a`, service account `si-vm-sa` with scope `cloud-platform`, address `si-web-ip`, tags `si,si-web`, labels `app=sports-intensity,owner=charles,role=web`. Install Docker Engine from Docker's apt repository: `deploy/compose.gcp.yml` needs Compose ≥ 2.24.
