import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    /**
     * Each test file runs in a separate OS-level fork (child process). When the
     * file's tests finish, the fork is sent SIGTERM and then SIGKILL if it does
     * not exit in time. This is the correct way to contain the handle leak from
     * server/vendor/livesync-engine: its close() leaves a TCP socket and a
     * timer alive, so a test process that has touched the engine will not exit
     * naturally. Running in a thread (pool: 'threads') would share one Node
     * process across all files and cannot kill those handles; the fork is killed
     * at the OS level regardless of what its event loop holds.
     *
     * pool: 'forks' is also the safest choice for code that touches process.env
     * or module-level singletons (services/settings.ts, config.ts), because
     * each file starts with a completely clean process.
     */
    pool: 'forks',

    // Paths are relative to this config file's directory (server/).
    include: ['src/**/*.test.ts'],
    exclude: ['vendor/**', 'node_modules/**'],

    // Per-test wall-clock limit. Generous enough to cover real file I/O in
    // makeTmpDataDir(), but short enough to fail fast on a hung livesync-engine
    // init that blocks inside its PouchDB promise.
    testTimeout: 30_000,

    // beforeAll / afterAll / beforeEach / afterEach get the same limit.
    hookTimeout: 20_000,

    // How long vitest waits for a worker to run its afterAll teardown before
    // force-killing it. The fork-kill is the real safety net for leaked handles;
    // this timeout protects against an afterAll that is itself stuck.
    teardownTimeout: 10_000,

    coverage: {
      provider: 'v8',
      // Only report on application source, not on the vendored engine or the
      // test helpers themselves.
      include: ['src/**'],
      exclude: ['vendor/**', 'src/__tests__/**'],
    },
  },
});
