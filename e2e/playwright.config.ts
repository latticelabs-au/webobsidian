import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * End-to-end tests, run against a REAL running instance.
 *
 * Everything else in this repo's test suite is unit-level and runs in-process.
 * That is the right shape for logic, and it is exactly the wrong shape for the
 * two claims this project makes that only a browser can check: that the OIDC
 * redirect chain completes against a real provider, and that the UI is usable on
 * a phone. Both of those failed in production while every unit test was green,
 * which is why this directory exists.
 *
 * Point it at an instance with BASE_URL. There is no webServer block on purpose:
 * the interesting target is a deployed instance behind its real reverse proxy,
 * where the forwarded scheme, the cookie flags and the CSP are the deployment's
 * and not a test harness's.
 *
 *   BASE_URL=https://notes.example.com E2E_PASSWORD=... npm run e2e
 */
const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
// __dirname, not import.meta.url: Playwright loads this config through a CJS
// transform, and the repo root has no "type": "module", so import.meta is not
// available here even though the server workspace is ESM.
const AUTH_FILE = path.join(__dirname, '.auth', 'owner.json');

export default defineConfig({
  testDir: './tests',
  // Serial by default. These tests share one server and one settings file, and a
  // settings write from one worker while another reads is a race that would show
  // up as a flake rather than as the bug it is.
  workers: 1,
  fullyParallel: false,
  // A failing run against a live deployment should be believed, not retried until
  // it passes. Retries would hide exactly the intermittent auth and proxy
  // problems this suite exists to catch, and on the login route a retry actively
  // makes things worse: see the rate-limit note on the projects below.
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    /*
     * THE LOGIN BUDGET SHAPES THIS WHOLE LIST. Login is limited to 10 attempts
     * per 15 minutes per network, so a suite that signs in per test, per file or
     * per device profile exhausts it and then reports the lockout as a product
     * failure. It is not: it is the limiter working. So there is exactly one
     * successful login (setup), its session is shared by the signed-in projects,
     * and the deliberate failures live in a single project rather than one per
     * device. Total spend per run: three attempts.
     */
    { name: 'setup', testMatch: /auth\.setup\.ts/ },

    // Anonymous. No storageState, and only one browser: everything here is an
    // HTTP-level assertion that cannot vary by user agent.
    {
      name: 'public',
      testMatch: /public\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'desktop',
      testIgnore: [/public\.spec\.ts/, /auth\.setup\.ts/],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_FILE },
      dependencies: ['setup'],
    },
    /*
     * A real iOS profile rather than a narrow desktop window, and WebKit rather
     * than Chromium. The settings dead-end this suite guards against was a media
     * query plus a touch interaction, and a resized desktop Chrome reproduces
     * neither the viewport conditions nor the engine the reporter was actually
     * using.
     */
    {
      name: 'mobile',
      testIgnore: [/public\.spec\.ts/, /auth\.setup\.ts/],
      use: { ...devices['iPhone 13'], storageState: AUTH_FILE },
      dependencies: ['setup'],
    },
  ],
});
