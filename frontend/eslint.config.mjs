// @ts-check
//
// Next 16 REMOVED `next lint`. The old script was `next lint`, which now parses
// "lint" as a directory argument and dies with "no such directory: ./lint" - so
// the frontend has had a lint script that could only ever fail. That matters more
// in a monorepo than it did before: `turbo run lint` fans out to every workspace,
// so one broken script fails the whole repo's lint task.
//
// The replacement is plain eslint with eslint-config-next, which is what
// `next lint` wrapped anyway. In v16 that package exports FLAT config arrays, so
// they are spread directly - no FlatCompat. Wrapping them in FlatCompat throws
// "Converting circular structure to JSON", because the eslintrc validator tries
// to serialize a plugin object that already holds a self-reference.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypeScript from 'eslint-config-next/typescript';

const config = [
  {
    // .next/** is generated output; linting it reports thousands of errors in
    // code nobody wrote.
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  // core-web-vitals promotes the perf rules (next/image, next/script, fonts)
  // from warning to error.
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // Matches the backend config: an underscore prefix is the deliberate
      // "declared but unused on purpose" marker across both workspaces.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];

export default config;
