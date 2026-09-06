#!/usr/bin/env node
/**
 * The ordered, stateful half of `npm run dev`.
 *
 * WHY THIS IS NOT A TURBO TASK. Turborepo is a cache over pure-ish tasks: given
 * the same inputs, skip the work. Every step below is the opposite of that - a
 * side effect on something outside the repo (a Docker daemon, a Postgres schema),
 * where "the inputs did not change" is no reason at all to skip it. Wiring
 * `migrate deploy` into a cached task graph would mean the migration silently does
 * not run on the one machine whose database is behind, which is precisely the
 * machine that needs it.
 *
 * So: side effects here, in a fixed order, with a real dependency chain. Pure
 * fan-out work (build, lint, typecheck, test) stays in turbo.json where the cache
 * earns its keep.
 *
 *   node scripts/stack.mjs           # env -> containers -> generate -> migrate
 *   node scripts/stack.mjs --seed    # ...then load the spike snapshot
 *   node scripts/stack.mjs --no-db   # skip docker (server, where Postgres is external)
 *
 * NOTHING HERE IS DESTRUCTIVE. It uses `prisma migrate deploy`, never
 * `migrate dev` (which can prompt to reset) and never `migrate reset`. Dropping
 * data is always an explicit, separately-typed command - see `npm run db:reset`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

let stepNo = 0;
function step(label) {
  stepNo += 1;
  console.log(`\n${c.bold(`[${stepNo}] ${label}`)}`);
}

/**
 * Run a command, inheriting stdio so the tool's own output is the output.
 *
 * Exits the whole script on failure rather than collecting errors: these steps
 * are a chain, not a set. `prisma migrate deploy` against a database that never
 * came up produces a confusing connection error on top of the real problem, so
 * the first failure is the one worth reading.
 */
function run(cmd, cmdArgs, opts = {}) {
  console.log(c.dim(`    $ ${cmd} ${cmdArgs.join(' ')}`));
  const res = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: opts.cwd ?? ROOT,
    // Windows needs a shell to resolve npm/npx shims; POSIX does not, and not
    // using one keeps arguments out of shell-quoting territory.
    shell: process.platform === 'win32',
  });
  if (res.error) {
    console.error(c.red(`\n  ${cmd} could not be started: ${res.error.message}`));
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(c.red(`\n  ${cmd} ${cmdArgs.join(' ')} exited ${res.status}`));
    if (opts.hint) console.error(`  ${opts.hint}`);
    process.exit(res.status ?? 1);
  }
}

// ---------------------------------------------------------------------------

step('Environment file');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  console.log(`    ${c.green('ok')} .env present`);
} else {
  const examplePath = join(ROOT, '.env.example');
  if (!existsSync(examplePath)) {
    console.error(c.red('    no .env and no .env.example to copy from'));
    process.exit(1);
  }
  // Copied, never generated with invented values. The app validates env with Zod
  // at boot and REFUSES to start on a bad one (see backend/src/config/env.schema),
  // so a placeholder that looks plausible would turn a clear "you have not
  // configured this yet" into a puzzling runtime failure later.
  copyFileSync(examplePath, envPath);
  console.log(`    ${c.yellow('created')} .env from .env.example`);
  console.log(
    `    ${c.yellow('!')} Fill it in before the API will boot. DATABASE_URL is required;`,
  );
  console.log(
    `      DISCOVERY_CONTACT_EMAIL is what identifies this crawler honestly to job boards.`,
  );
}

if (!args.has('--no-db')) {
  step('Postgres + Redis containers');
  // --wait blocks until both healthchecks in docker-compose.yml report healthy,
  // rather than until the containers merely exist. Without it, `prisma migrate
  // deploy` races Postgres' startup and fails on a connection refused roughly
  // one run in three.
  run('docker', ['compose', 'up', '-d', '--wait'], {
    hint: 'Is the Docker daemon running? `docker info` will say.',
  });
  console.log(`    ${c.green('ok')} both services healthy`);
} else {
  step('Postgres + Redis containers');
  console.log(`    ${c.dim('skipped')} --no-db: expecting an external database`);
}

step('Prisma client');
// Before migrate, not after: if a migration fails, a generated client is still
// the right thing to have on disk for reading the error.
run('npm', ['run', 'prisma:generate', '-w', '@job-autopilot/backend']);

step('Database migrations');
// deploy, NOT dev. `migrate dev` diffs the schema against the database and can
// offer to reset it to resolve drift - an interactive prompt in the middle of a
// one-command startup, attached to a data-loss option. deploy only ever applies
// pending migration files forward, and errors out on drift instead of offering to
// fix it. Authoring new migrations is `npm run db:migrate`, typed on purpose.
run('npm', ['run', 'prisma:migrate:deploy', '-w', '@job-autopilot/backend'], {
  hint: 'Schema drift? `npm run db:migrate` authors a migration; resetting is never automatic.',
});

if (args.has('--seed')) {
  step('Seed data');
  run('npm', ['run', 'prisma:seed', '-w', '@job-autopilot/backend']);
}

console.log(`\n${c.green('Stack ready.')}`);
