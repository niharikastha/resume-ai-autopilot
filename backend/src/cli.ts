/**
 * CLI entry point.  npm run cli -- <command> [flags]
 *
 * Commands are separate modules imported on demand so one broken command cannot
 * stop the others from running.
 */
const COMMANDS: Record<string, () => Promise<unknown>> = {
  'create-user': () => import('./cli/create-user'),
  'prune-auth': () => import('./cli/prune-auth'),
};

const command = process.argv[2];

if (!command || !(command in COMMANDS)) {
  console.error(`usage: npm run cli -- <command> [flags]

commands:
  create-user   --email <email> --name <name> [--role admin|user]
  prune-auth    [--apply]   delete expired sessions/tokens/resets (dry run by default)
`);
  process.exit(1);
}

void COMMANDS[command]();
