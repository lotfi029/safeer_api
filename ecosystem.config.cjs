// PM2 process config.
//
// instances: 1 is not a performance knob here — it is required by the
// in-process LRU cache (11-architecture.md D-10, 13-backend-build-plan.md
// trap 9). The cache lives inside one Node process; under `instances > 1`
// or `exec_mode: 'cluster'`, a cache purge clears only the worker that
// handled the write, and the other workers keep serving stale content for
// up to CACHE_TTL_SECONDS after an editor saves a change. That shows up as
// "I saved it but the site didn't change", intermittently, depending on
// which worker answered the next request. If the API ever needs more than
// one process, the cache moves to Redis first (the get/set/purgeTag
// interface is the seam) — do not raise `instances` on its own.
module.exports = {
  apps: [
    {
      name: 'safeer-api',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      // A4: on a restart PM2 sends SIGINT, then SIGKILL after kill_timeout.
      // The app waits up to 10 s for background sends still running
      // (request-otp answers before its SMS/email goes out — see
      // src/common/background/background-work.service.ts); 12 s lets that
      // drain finish instead of cutting it at PM2's default 1.6 s.
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
