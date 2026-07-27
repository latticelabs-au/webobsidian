/**
 * Sign in once per run and hand the session to every other project.
 *
 * This is not just a speed optimisation. The login route is rate limited to 10
 * attempts per 15 minutes per network, and that limit is real: an earlier
 * version of this suite logged in separately per test and per device profile,
 * spent its whole budget inside two minutes, and then failed every remaining
 * test with "Too many login attempts" while reporting it as a product bug. The
 * app was working correctly and the suite was DoSing itself.
 *
 * So exactly one successful login happens here, its cookie is written to disk,
 * and the signed-in projects reuse it. The only other requests that touch the
 * budget are the deliberate failures in public.spec.ts, which run in one project
 * rather than per device for the same reason.
 */
import { test as setup, expect } from '@playwright/test';
import path from 'node:path';

// Must resolve to the same file the config hands to the signed-in projects as
// storageState. __dirname for the same reason as there: this is transformed to
// CJS, so import.meta is unavailable.
const AUTH_FILE = path.join(__dirname, '..', '.auth', 'owner.json');

const PASSWORD = process.env.E2E_PASSWORD ?? '';

setup('sign in and save the session', async ({ page }) => {
  setup.skip(!PASSWORD, 'set E2E_PASSWORD to run the signed-in tests');

  await page.goto('/');
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /^unlock$/i }).click();

  // The password box disappearing is the app's own signal that the session took:
  // App.tsx swaps the login card for the workspace once api.me() succeeds. If the
  // proxy has dropped X-Forwarded-Proto the cookie is refused as insecure and
  // this is where that shows up, which is precisely the deployment-level failure
  // an in-process test cannot see.
  await expect(page.getByPlaceholder('Password')).toHaveCount(0, { timeout: 20_000 });

  await page.context().storageState({ path: AUTH_FILE });
});
