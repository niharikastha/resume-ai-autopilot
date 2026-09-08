/**
 * CLI entry point.  npm run cli -- <command> [flags]
 *
 * Commands are separate modules imported on demand so one broken command cannot
 * stop the others from running.
 */
const COMMANDS: Record<string, () => Promise<unknown>> = {
  'create-user': () => import('./cli/create-user'),
  'prune-auth': () => import('./cli/prune-auth'),
  discover: () => import('./cli/discover'),
  'companies:probe': () => import('./cli/probe-companies'),
  'companies:sweep': () => import('./cli/sweep-companies'),
  'profile:ingest': () => import('./cli/profile-ingest'),
  'profile:embed': () => import('./cli/profile-embed'),
  'skills:list': () => import('./cli/skills'),
  'skills:add': () => import('./cli/skills'),
  'skills:remove': () => import('./cli/skills'),
  match: () => import('./cli/match'),
  tailor: () => import('./cli/tailor'),
};

const command = process.argv[2];

if (!command || !(command in COMMANDS)) {
  console.error(`usage: npm run cli -- <command> [flags]

commands:
  create-user       --email <email> --name <name> [--role admin|user]
  prune-auth        [--apply]   delete expired sessions/tokens/resets (dry run by default)
  discover          [--dry-run] [--source <name>] [--limit <n>]
                    fetch job boards and store postings with descriptions
  companies:probe   --slug <slug> | --file <path> [--create] [--recheck]
                    find which ATS a company uses
  companies:sweep   [--dry-run] [--tier T1,T2] [--limit <n>] [--recheck]
                    probe every company in config/companies.yaml and create the
                    hits, tier included. The list is the bottleneck of the whole
                    project (PLAN-v2 change 1), so this is how it grows.
  profile:ingest    "<resume path>" [--user <email>] [--label <name>]
                    [--confirm] [--force]
                    parse a resume into atoms. Prints them and writes NOTHING
                    unless --confirm is given - read them first.
  profile:embed     [--user <email>] [--all]
                    compute missing atom vectors for an already-confirmed
                    profile. Repair only; ingest normally does this itself.
  skills:list       [--user <email>]
  skills:add        --skill "TypeScript, Python" [--user <email>] [--staged]
                    [--note <why>]
  skills:remove     --skill "Kafka" [--user <email>]
                    skills the candidate has that the resume never tagged. The
                    provenance guard discards a tailored resume that names
                    anything outside the resume's own tech tags plus these, so
                    this is what its "add it to SkillsReserve" message means.
                    New rows are ENABLED unless --staged.
  match             [--dry-run] [--user <email>] [--top <n>] [--limit <n>]
                    [--budget <n>] [--mode auto|batch|inline]
                    run the four-stage funnel and print the shortlist. Start
                    with --dry-run: it prints the per-stage counts and stage 1's
                    rejection histogram without calling an LLM, and a filter
                    that is too tight looks exactly like a quiet job market
                    unless you read those numbers.
  tailor            [--dry-run] [--user <email>] [--limit <n>] [--job <id>]
                    [--force] [--mode auto|batch|inline]
                    tailor a resume per shortlisted posting, run the provenance
                    guard, and render docx+pdf into RESUME_OUTPUT_DIR. A variant
                    that fails the guard is DISCARDED and the base resume is
                    rendered instead. Note that --dry-run here still makes the
                    LLM calls - it only skips the files and the rows - so pair
                    it with --limit 1.

The three discovery commands need DISCOVERY_CONTACT_EMAIL set in .env - every
outbound request carries a contact address so a site operator can reach a human.
`);
  process.exit(1);
}

void COMMANDS[command]();
