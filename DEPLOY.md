# Deploying

One server runs everything except the submit step. `npm run deploy` is the command;
the rest of this file is what has to be true before it works.

## What cannot be hosted, and why it matters

**The submit session stays on your laptop.** `browser.service.ts` opens a *visible*
Chrome with a persistent profile so a human can read the filled form, clear a
CAPTCHA, and click submit. That is the project's oldest constraint, not an
implementation detail. The server does discovery, matching, tailoring and digests;
you run `npm run cli -- submit` locally against the server's database over the SSH
tunnel.

**The rest cannot be serverless.** Four things rule out Vercel/Lambda-style hosting
for the backend, and each one fails differently:

| | Where | Symptom if you try |
| --- | --- | --- |
| Long-lived worker + 4 crons | `ecosystem.config.js`, `*.scheduler.ts` | Functions do not stay alive; BullMQ has no consumer |
| 130MB of ONNX weights on disk | `embeddings.service.ts`, `backend/.models/` | Re-downloaded on every cold start |
| `soffice` shelled out for PDF | `tailoring/resume.render.ts` | No LibreOffice in the runtime; PDFs silently absent |
| Persistent directories | `generated-resumes/`, `uploads/` | The document attached to an open application disappears |

The frontend alone *can* go on Vercel. See "Frontend on Vercel" below for what that
costs you.

## The box

2 vCPU / 4GB is the floor. PM2's own limits add to ~2GB (api 512M + worker 1G + web
512M) and the ONNX runtime spikes above its resting size on the first embed of a
run, so 2GB total will OOM the worker mid-pass. Hetzner CX22 or a DigitalOcean 4GB
droplet, Ubuntu 24.04.

```bash
# Node 24 (engines.node enforces the floor; .nvmrc pins the major)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Postgres and Redis run in containers, as in dev
sudo apt-get install -y docker.io docker-compose-v2

# LibreOffice, for docx -> pdf. Without it tailoring still produces the .docx and
# logs that the pdf step was skipped - a real state the CLI reports, not a crash.
sudo apt-get install -y libreoffice-writer fonts-liberation

sudo npm install -g pm2
sudo apt-get install -y caddy   # see https://caddyserver.com/docs/install

sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

Chrome is deliberately **not** installed. The api never loads Playwright
(`SubmissionModule` has no controller and no processor), so a browser on the server
would be an unused attack surface.

## First deploy

```bash
git clone <repo> && cd <repo>
cp .env.example .env    # then fill it in, see below
npm install
docker compose up -d --wait    # Postgres with pgvector + pg_trgm, and Redis
npm run db:migrate:deploy      # forward-only, never `migrate dev`
npm run deploy                 # stack --no-db, build both, pm2 startOrReload
pm2 save && pm2 startup        # survive a reboot
```

`npm install` prints a warning that `onnxruntime-node` and `protobufjs` have
postinstall scripts npm 11 has not been told to run. The prebuilt binaries ship in
the package, so embeddings work anyway — but if `npm run cli -- profile:embed` fails
to load the runtime, that warning is the first thing to look at, and
`npm install-scripts approve onnxruntime-node` is the fix.

Then create your admin — the only route to one:

```bash
npm run cli -- create-user --email you@example.com --name "Your Name" --role admin
```

## The `.env` values that only matter in production

In the **root `.env`**, which is what the backend reads:

| | Set it to |
| --- | --- |
| `APP_URL` | `https://app.example.com` — the public origin. Never derived from a header |
| `COOKIE_SAMESITE` | `lax`, unless the frontend is genuinely cross-site |
| `TRUST_PROXY` | `1` behind Caddy |
| `NODE_ENV` | `production` — set by PM2 already; it is what turns on `secure` cookies |

`APP_URL` on plain http with Secure cookies **refuses to boot**, deliberately. A
Secure cookie sent to an http origin is discarded by the browser with no error
anywhere — login returns 200 and the next request 401, which looks like a session
bug and is not one. The env schema rejects that pairing and says so. `localhost` is
exempt, which is what keeps the SSH-tunnel setup working.

### The frontend's variable is separate, and it is a *build* input

`NEXT_PUBLIC_API_URL` does **not** live in the root `.env` — the frontend reads its
own env files. `frontend/.env` is committed and holds the dev value
(`http://localhost:3100`), so a deployment must override it. Create
`frontend/.env.local`, which is gitignored and takes precedence:

```bash
echo 'NEXT_PUBLIC_API_URL=https://app.example.com' > frontend/.env.local
```

No `/api` suffix: the frontend's own fetches add it (`src/lib/api.ts` calls
`${API_URL}/api/auth/refresh`).

It is **inlined into the JavaScript bundle at build time**, not read at runtime, so
changing it requires a rebuild — `npm run deploy` — and not a restart. Skip this step
and the deployed page asks the visitor's browser for `http://localhost:3100`, which
fails in a way that reads like a CORS problem.

## TLS and routing

Copy `deploy/Caddyfile`, replace `app.example.com`, keep **Layout A**: one host,
`/api/*` to 3100 and everything else to 3200. Both processes stay bound to
127.0.0.1 — Caddy is the only way in, and the firewall above keeps it that way.

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Point an A record at the box first; Caddy fetches the certificate on first request
and cannot do so before DNS resolves.

Layout A is worth choosing for one specific reason: the web app and the API share an
origin, so the cookies stay `SameSite=lax` and CORS never applies. Every other
layout trades that away for something.

## Frontend on Vercel

Workable, and it does buy you a CDN, preview deployments and `git push` deploys.
What it costs: you still need this server for the backend, and you now have two
origins, so CORS and cookie policy become things you maintain rather than things
that are true by construction.

If the Vercel deployment uses a custom domain on the **same registrable domain** as
the API (`app.example.com` + `api.example.com`), it is still the same *site* and
`COOKIE_SAMESITE=lax` keeps working — subdomains are not part of a site. That is the
version worth doing.

If you leave it on `*.vercel.app`, it is cross-site and needs
`COOKIE_SAMESITE=none`, which means the session cookie rides along on cross-site
requests and you give up the CSRF protection `lax` provided. Prefer the custom
domain.

Either way: Layout B in the Caddyfile, `TRUST_PROXY=1`, `CORS_EXTRA_ORIGINS` for any
second name the frontend answers on, and set `NEXT_PUBLIC_API_URL` in Vercel's
Production environment then **redeploy** — an existing build has the old value
compiled in.

## Rate limits

The auth routes are rate limited per IP (`auth.controller.ts`): login and password
change 10 per 5 minutes, signup 5 per hour, forgot/reset 10 per hour. `refresh` and
`me` are exempt on purpose — see the comments there.

Storage is **in-memory**, which is correct while `instances: 1` in
`ecosystem.config.js` and wrong the moment the api runs in cluster mode: each worker
would keep its own counter and the real limit would multiply. Redis is already a
dependency if that day comes.

The limits are keyed on `req.ip`, so `TRUST_PROXY=1` is what makes them meaningful.
Left at 0 behind Caddy, every caller shares the proxy's address and the first person
to mistype a password ten times locks out everyone.

## Open signup, on a public box

`/signup` is public and creates a **disabled** account that an admin must approve.
Read that as the cost gate it now is: an approved candidate's daily matching run
spends *your* Anthropic or Bedrock credits, and stage 2 caps LLM calls per run but
nothing caps the number of candidates. Approve people you are willing to pay for.

Two more things change once other people are on it:

- **You are storing other people's resumes** — names, phone numbers, addresses,
  employment history. That is third-party PII rather than your own. `uploads/` and
  `generated-resumes/` are covered by `.gitignore` but nothing encrypts them, and a
  delete-account path does not exist yet.
- **Telegram digests go to admins only**, deliberately (`telegram.service.ts`), so
  candidates need SMTP configured or they get the in-app copy and nothing else.

## Operating it

```bash
pm2 logs autopilot-worker     # where the 6/7/9 AM runs report
pm2 status
ssh -L 3200:127.0.0.1:3200 -L 3100:127.0.0.1:3100 user@server   # if not public
```

The daily chain: discovery 06:00, matching 07:00 (one queued job per candidate),
digest 09:00 IST, auth cleanup 03:30. Each scheduler self-gates on
`AUTOPILOT_ROLE=worker`, because `AppModule` is loaded by both the api and the
worker and every `@Cron` in the tree would otherwise be registered twice.

Back up the database — nothing in the repo does this yet:

```bash
docker exec autopilot-postgres pg_dump -U autopilot autopilot | gzip > /backups/$(date +%F).sql.gz
```

Credentials come from `POSTGRES_USER`/`POSTGRES_DB` in your `.env`. A daily
cron plus the provider's own snapshots is enough; `backend/.models` and
`.browser-profile` do not need backing up, the first being re-downloadable and the
second belonging to your laptop.

## Updating

```bash
git pull && npm install && npm run db:migrate:deploy && npm run deploy
```

`npm run deploy` uses `migrate deploy` and never `migrate dev` or `migrate reset`,
so it cannot offer to drop the database on drift. `npm run db:reset` destroys data
and is called by nothing else.
