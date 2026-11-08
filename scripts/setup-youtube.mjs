#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function validateOrigin(value) {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Origin must be HTTPS or HTTP localhost, with no path or query.');
  }
  return url.origin;
}
export function importClient(data, project, origin) {
  const client = data.web;
  if (!client || !client.client_id || !client.client_secret) throw new Error('Download a Web application OAuth client JSON, not a desktop client or service account key.');
  if (client.project_id !== project) throw new Error('The downloaded OAuth client belongs to a different project.');
  if (!client.redirect_uris?.includes(`${origin}/api/content/auth/callback`)) {
    throw new Error(`Add ${origin}/api/content/auth/callback to the client redirect URIs, then download the JSON again.`);
  }
  return { GOOGLE_CLIENT_ID: client.client_id, GOOGLE_CLIENT_SECRET: client.client_secret };
}
export function updateEnv(source, changes) {
  const remaining = new Map(Object.entries(changes));
  const lines = source.split('\n').filter(line => {
    const match = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    return !match || !remaining.has(match[1]);
  });
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  for (const [key, value] of remaining) {
    if (typeof value !== 'string' || /['\r\n\0]/.test(value)) throw new Error(`Invalid value for ${key}.`);
    lines.push(`${key}='${value}'`);
  }
  return `${lines.join('\n').trim()}\n`;
}
export function existingValue(source, key) {
  return parseEnv(source)[key] || '';
}

function gcloud(args) {
  try { return execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim(); }
  catch (err) {
    const message = String(err.stderr || '');
    if (message.includes('invalid_grant') || message.includes('auth login') || message.includes('no active account')) {
      throw new Error('Your gcloud login needs renewal. Run gcloud auth login, then rerun this command.');
    }
    if (err.code === 'ENOENT') throw new Error('Install the Google Cloud CLI, then run gcloud auth login.');
    // Cloud output might contain credentials; do not echo arbitrary command output.
    throw new Error(`gcloud ${args.slice(0, 2).join(' ')} failed. Check your login, project ID and project permissions.`);
  }
}
async function main() {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, origin: { type: 'string', default: 'http://localhost:5173' },
    credentials: { type: 'string' }, email: { type: 'string' }, 'skip-cloud': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: npm run setup:youtube -- [--project PROJECT_ID] [--origin http://localhost:5173] [--email EMAIL] [--credentials /path/to/client.json] [--skip-cloud]\nRun once to configure the project and get Console links, then rerun with the downloaded Web OAuth client JSON.\n--skip-cloud requires --project and --email; it imports local credentials without calling Google Cloud.');
    return;
  }
  const origin = validateOrigin(values.origin);
  let project = values.project;
  let email = values.email;
  if (!values['skip-cloud']) {
    const account = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']).split('\n')[0];
    if (!account) throw new Error('Run gcloud auth login before setup.');
    email ||= account;
    if (!project) {
      const projects = JSON.parse(gcloud(['projects', 'list', '--format=json(projectId,name)']));
      const matches = projects.filter(p => p.name?.toLowerCase() === 'sportlight' || p.projectId === 'sportlight');
      if (matches.length !== 1) throw new Error('Could not uniquely identify Sportlight. Rerun with --project YOUR_PROJECT_ID.');
      project = matches[0].projectId;
    }
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('Use a valid Google Cloud project ID.');
  }
  if (!project || !email) throw new Error('--skip-cloud requires --project and --email.');
  if (!/^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+$/.test(email)) throw new Error('Specify your Google account with --email EMAIL.');
  const file = resolve(root, '.env');
  const info = await lstat(file).catch(err => { if (err.code !== 'ENOENT') throw err; });
  if (info?.isSymbolicLink()) throw new Error('Refusing to replace a symlinked .env. Configure it manually.');
  const source = info ? await readFile(file, 'utf8') : await readFile(resolve(root, '.env.example'), 'utf8');
  const changes = {
    CONTENT_APP_URL: origin,
    CONTENT_ALLOWED_EMAILS: existingValue(source, 'CONTENT_ALLOWED_EMAILS') || email.toLowerCase(),
    CONTENT_ENCRYPTION_KEY: existingValue(source, 'CONTENT_ENCRYPTION_KEY') || randomBytes(32).toString('hex'),
  };
  if (!/^[a-f0-9]{64}$/i.test(changes.CONTENT_ENCRYPTION_KEY)) throw new Error('Existing CONTENT_ENCRYPTION_KEY is invalid; correct it without losing access to existing encrypted credentials.');
  if (values.credentials) Object.assign(changes, importClient(JSON.parse(await readFile(resolve(values.credentials), 'utf8')), project, origin));
  const updated = updateEnv(source, changes);
  if (!values['skip-cloud']) {
    console.log(`Enabling YouTube Data API v3 in ${project}…`);
    gcloud(['services', 'enable', 'youtube.googleapis.com', `--project=${project}`, '--quiet']);
  }
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, updated, { mode: 0o600, flag: 'wx' });
  await rename(temp, file); await chmod(file, 0o600);
  console.log(`Saved private local .env configuration. Existing encryption key and unrelated settings were preserved.\nProject: ${project}\nApp origin: ${origin}\nRedirect URI: ${origin}/api/content/auth/callback`);
  if (!existingValue(updated, 'GOOGLE_CLIENT_ID') || !existingValue(updated, 'GOOGLE_CLIENT_SECRET')) {
    console.log(`\nFinish the Google Console steps:\n1. Branding: https://console.cloud.google.com/auth/branding?project=${encodeURIComponent(project)}\n   Set app name Sportlight and your support email.\n2. Audience: https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(project)}\n   For a personal Google account choose External; in Testing add ${email} as a test user.\n   Then click Publish app (In production): in Testing, Google expires refresh tokens after 7 days.\n3. Clients: https://console.cloud.google.com/auth/clients?project=${encodeURIComponent(project)}\n   Create Web application; add origin ${origin} and redirect URI above.\n   Download the client JSON and store it outside the repository.\n4. Import it:\n   npm run setup:youtube -- --project ${project} --origin ${origin} --credentials /absolute/path/to/client.json`);
  } else {
    console.log('\nOAuth credentials are configured. Start/restart the app, open the dashboard, and Continue with Google.');
  }
  console.log(`\nLocal development (environment must be reloaded before starting):\n  set -a\n  source .env\n  set +a\n  npm run dev\n\nDocker alternative: rerun setup with --origin http://localhost:8080 and a matching OAuth redirect, then docker compose up -d --build.\n\nDashboard: ${origin}/dashboard\nShorts are generated into the dashboard library; only those you select and publish are uploaded (publicly). Google account consent must be completed in your browser.`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(err => { console.error(`YouTube setup: ${err.message}`); process.exitCode = 1; });
}
