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

Both discovery commands need DISCOVERY_CONTACT_EMAIL set in .env - every outbound
request carries a contact address so a site operator can reach a human.
`);
  process.exit(1);
}

void COMMANDS[command]();
