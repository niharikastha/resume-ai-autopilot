# AUTOPILOT

Daily job discovery, resume tailoring, and **assisted** apply.

It finds openings that match your profile, rewrites your resume for each one, and
fills the application form up to - never including - the submit button. See
`PLAN-v2.txt` for the phase plan and the reasoning behind each constraint.

## Screenshots

<!-- Add 3-4 screenshots here: the morning digest (email or Telegram), the jobs
     page, a match with its score and reasons, and a tailored resume next to the
     base one. A 60-second screen recording of one morning run is even better. -->

## How matching works

Around 16,500 open postings from 6 applicant-tracking platforms (Ashby, Greenhouse,
Lever, SmartRecruiters, Workable, Workday) go through a funnel where each stage is
cheaper than the one after it:

```
discovery (06:00)
  -> 1. screen        free, deterministic, drops ~90%    matching/stage1.screen.ts
  -> 2. vector        local bge-small + pgvector, top 60 matching/stage2.vector.ts
  -> 3. score         Claude Haiku, prompt-cached (07:00)
  -> 4. pay gate      stated salary below floor rejects  matching/stage4.pay.ts
  -> digest (09:00 IST)  STRONG, GOOD, BORDERLINE only   matching/decidable.ts
  -> tailor           STRONG/GOOD only, Claude Opus      tailoring/provenance.guard.ts
```

- **Screen.** Title rules, dealbreakers, years of experience, location, freshness,
  already-applied. Every rejection carries a named reason, so the reason histogram
  shows which rule is doing the work.
- **Vector.** A spend cap and an ordering, not a verdict: topical overlap is not
  fit. It decides which 60 postings are worth a model call.
- **Score.** Haiku, because this is high-volume rubric classification and the
  price difference decides whether a daily run is sustainable.
- **Pay gate.** Asymmetric on purpose: a *stated* salary below the floor rejects,
  an *estimated* one does not, and unknown pay passes.
- **Tailor.** Opus, because there are few of these and an overstated resume costs
  an application. The schema only allows rewrites of existing bullets, and the
  provenance guard rejects unsupported numbers, new technologies and changed
  employers. It fails closed: the whole variant is dropped and the base resume is
  used.

Known limits: the guard only knows technologies in its dictionary and cannot see
unquantified overstatement ("led" vs "contributed"), which is why a human confirms
before submit. Title rules match substrings, so excluding "intern" also excludes
"internal".

---

## The one command

```bash
npm install
npm run dev
```

`npm run dev` does the whole thing, in order:

1. **`.env`** — creates it from `.env.example` if missing, and tells you so.
2. **Containers** — `docker compose up -d --wait`, blocking until Postgres and
   Redis report *healthy*, not merely *started*.
3. **`prisma generate`** — the typed client.
4. **`prisma migrate deploy`** — applies pending migrations. Forward-only.
5. **Three watch processes in parallel** — api on `127.0.0.1:3100`, worker, web on
   `:3200`.

Then open <http://localhost:3200>.

First time on a fresh database, use `npm run setup` instead — same steps plus the
spike snapshot as seed data, so the dashboard has something to draw.

## Accounts

Two ways in, and only one of them can produce an administrator.

**The CLI** — the only route to an ADMIN, and how you make your own first account:

```bash
npm run cli -- create-user --email you@example.com --name "Your Name" --role admin
```

The password comes from `CREATE_USER_PASSWORD` or is generated and printed once.
It is never taken as a flag — argv is world-readable via `/proc` and lands in your
shell history. Accounts made here skip the approval queue: whoever can run this
command is already trusted.

**Self-signup** — `/signup` is open to anyone, and worth nothing on its own. The
account is created *switched off* and cannot sign in until an admin approves it
under *Accounts*. The role is hardcoded to candidate; the endpoint has no field
for a role at all, so asking for administrator is not something the request can
express. Pending accounts are counted at the top of the admin *Accounts* screen so
a signup nobody notices does not become a person waiting indefinitely.

Sign-in is enumeration-safe: a wrong password and an address with no account get
the identical error. A *correct* password on an unapproved account is told why it
cannot get in — at that point the caller has already proven the account is theirs.

## Sessions and password reset

Two cookies, both HttpOnly and both rows in the database — nothing is a
self-validating token, so revocation is immediate rather than eventual.

| | |
| --- | --- |
| `autopilot_access` | 15 min, path `/`. Sent with every API call. |
| `autopilot_refresh` | 14-day idle / 90-day absolute, path `/api/auth`. |

Neither cookie is both long-lived *and* widely sent, which is the whole point of
splitting them. Refresh **rotates**: each use issues a new pair and revokes the old
one. A rotated refresh token replayed later is treated as theft and revokes the
entire session family, including the legitimate holder — deliberately, because at
that point you cannot tell which of the two is the attacker. Replays within 30
seconds are exempt: two browser tabs waking from sleep together is a race, not an
attack, and the loser retries onto the winner's new cookie.

**Forgot password** needs SMTP configured. Fill `SMTP_HOST`, `SMTP_USER` and
`SMTP_PASSWORD` in `.env` (Gmail wants an App Password, not your account
password); `SMTP_PORT` defaults to 587 with STARTTLS, set `SMTP_SECURE=true` for
465. `APP_URL` is what the link in the email points at. Until those are set the
endpoint returns a 503 naming the missing variables rather than accepting the
request and dropping the email — a reset that silently vanishes is worse than one
that says it is unavailable. That the *server* lacks SMTP says nothing about
whether a given address has an account, so it is safe to report.

Reset links work once, expire in an hour, are superseded by a newer request, are
limited to 5 per address per hour, and revoke every session on use.

## Why it splits into two halves

Steps 1-4 are **ordered side effects** on things outside the repo - a Docker
daemon, a database schema. "The inputs did not change" is no reason to skip them;
the machine whose database is behind is exactly the machine that needs the
migration to run. So they live in `scripts/stack.mjs`, plain and sequential.

Everything else - `build`, `lint`, `typecheck`, `test` - is fan-out work where
re-running unchanged tasks is pure waste, so it lives in `turbo.json` and is
cached. A repeat `npm run build` finishes in about a second.

Nothing in the one command can destroy data. It uses `migrate deploy`, never
`migrate dev` (which can offer to reset on drift) and never `migrate reset`.
Dropping the database is `npm run db:reset`, typed deliberately, on its own.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | **the one command** — stack up, then api + worker + web in watch mode |
| `npm run setup` | same, plus seed data. Use on a fresh clone. |
| `npm run stack` | just the stateful part: env, containers, generate, migrate |
| `npm run dev:api` / `dev:web` / `dev:worker` | one process at a time |
| `npm run check` | typecheck + lint + test across both workspaces |
| `npm run build` | production build of both, cached |
| `npm run deploy` | migrate + build + `pm2 startOrReload` (no Docker; server Postgres is external) |
| `npm run cli -- <cmd>` | the operator CLI |
| `npm run db:migrate` | author a new migration (interactive) |
| `npm run db:studio` | Prisma Studio |
| `npm run db:reset` | **destroys all data.** Never called by anything above. |

## Layout

```
backend/     Nest 11 — api, worker, cron, connectors, CLI
frontend/    Next 16 — admin + candidate dashboards
scripts/     stack.mjs, the ordered startup chain
docker/      Postgres init (pgvector, pg_trgm)
spike/       phase-0 discovery measurements, kept for reference
```

Two roles. **ADMIN** sees the machinery - connector health, board yield, every
account - and uses the app as a candidate too. **USER** only uses the app. Being an
admin is not permission to act for someone else: the personal answers that go into
an application (work authorization, notice period, expected CTC) are writable only
by the account that owns them. An admin can see they are blank and cannot fill
them in. Approving an account decides whether someone may sign in, and nothing
else — it grants no role, and there is no admin route that does.

## Ports

| | |
| --- | --- |
| `127.0.0.1:3100` | api — **loopback only.** Reached over an SSH tunnel on the server, never exposed. |
| `:3200` | web |
| `:5433` | Postgres (container) |
| `:6380` | Redis (container) |

## Configuration

All secrets live in `.env` at the repo root, which is gitignored. They are never
written to the database and never displayed in the UI - not even masked, since a
masked key still leaks its length and prefix. The admin *Integrations* screen
reports presence only.

The env contract is a Zod schema (`backend/src/config/env.schema.ts`) and it
**fails closed**: an invalid or missing required value means the process refuses
to start rather than booting into a half-configured state. `DATABASE_URL` is
required. `DISCOVERY_CONTACT_EMAIL` is what identifies this crawler honestly to
every job board it touches.

The `SMTP_*` block is optional — leave it blank and everything works except
"forgot password", which then reports itself unavailable. Blank is treated as
absent, not as a value: dotenv reads `SMTP_PORT=` as the empty string, so the
schema normalises `''` to undefined before defaults apply. Otherwise an empty line
in `.env` would fail the port's `.positive()` check and the process would refuse to
boot over a setting nobody was using.

### Gmail sync (optional)

The tracker can read recruiter mail and suggest stage changes ("Atlassian:
Applied -> Interviewing", with the sentence that says so). It only suggests;
nothing changes until you press Apply. Each user connects their own inbox with
the `gmail.readonly` scope, and the refresh token is stored AES-256-GCM encrypted.

1. In Google Cloud Console, create a project and enable the **Gmail API**.
2. Set up the **OAuth consent screen**: External, in *Testing* mode, and add each
   person who will connect as a **test user** (up to 100). Add the scope
   `.../auth/gmail.readonly`.
3. Create an **OAuth client ID** of type *Web application*, with the authorised
   redirect URI `http://localhost:3100/api/me/gmail/callback`.
4. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and
   `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) in `.env`, then restart.

The worker checks every connected inbox hourly at :20; *Sync now* is on the page.
The first read covers the last 30 days. Only a suggestion's subject, sender and one
quoted sentence are stored.

## Requirements

Node >= 24, npm 11, Docker.

```bash
nvm use          # reads .nvmrc
```

`.nvmrc` pins the **major**, not an exact patch, so `nvm use` picks up Node
security releases without a repo edit — `engines.node` already enforces the floor.
`packageManager` in `package.json` is pinned exactly, because that one is a
reproducibility contract corepack enforces rather than a floor.

`npm install` needs to run the install scripts for
Prisma's engines and sharp; npm 11 blocks those by default, so the decisions are
recorded in the `allowScripts` field of the root `package.json` and a fresh clone
picks them up with no extra flags.

## Known advisories

`npm audit` reports two high-severity issues under `prisma` (the dev-only CLI):
`deepmerge-ts` and `mysql2`. Neither is reachable here - `deepmerge-ts` only merges
our own `prisma.config.ts`, and `mysql2` is a driver adapter for a database this
project does not use. Prisma 7.10.0 is the latest 7.x, so there is no fix short of
a major downgrade to Prisma 6. Revisit when 7.11 lands.
