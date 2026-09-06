// PM2 process definitions. Applied by `npm run deploy`.
//
// Three processes, deliberately separate: the api can be restarted without
// interrupting an in-flight pipeline run, the worker can be scaled or stopped
// without taking the review surface down, and the web server is just a static
// renderer that never needs to come down for a backend change.
//
// Note the submit session (phase 6) is NOT here. It needs a visible browser so
// a human can clear CAPTCHAs, so it runs on the laptop via `npm run cli --
// submit`, never as a managed daemon. See PLAN-v2.txt phase 6.
module.exports = {
  apps: [
    {
      name: 'autopilot-api',
      cwd: './backend',
      script: 'dist/src/main.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'autopilot-worker',
      cwd: './backend',
      script: 'dist/src/worker.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
    },
    {
      // Bound to 127.0.0.1, like the api. Neither is exposed publicly - the
      // browser reaches them over an SSH tunnel, so a default 0.0.0.0 bind would
      // put both the review UI and the api on the open internet with only a
      // password in front of them.
      name: 'autopilot-web',
      cwd: './frontend',
      // require.resolve, not a hardcoded path. npm workspaces HOIST next to the
      // root node_modules, so './node_modules/next/...' relative to frontend/ does
      // not exist - and whether a given package hoists depends on the rest of the
      // tree, so it is not something to hardcode either way.
      //
      // Resolving the real binary also means pm2 supervises node directly rather
      // than an `npm run` wrapper. pm2 signals the process it started; with a
      // wrapper in between, a restart kills the wrapper and orphans the server,
      // which then holds the port against its own replacement.
      script: require.resolve('next/dist/bin/next'),
      args: 'start -p 3200 -H 127.0.0.1',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
