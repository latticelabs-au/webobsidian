/**
 * The settings dialog, and specifically that it can be left.
 *
 * This file exists because of a production failure that no unit test could have
 * caught. On a phone the media query promotes .settings-modal to
 * `position: fixed; inset: 0`, which covers the .modal-bg backdrop, and clicking
 * that backdrop was the only way to close the dialog. Opening settings on a
 * phone was a one-way trip: no close control, no Escape handler, and no browser
 * back to fall through to because the dialog is not a route. The only escape was
 * reloading the page.
 *
 * So the mobile project here is not a nice-to-have variant of the desktop one.
 * It is the test.
 */
import { test, expect } from '@playwright/test';

// The session arrives via storageState from the setup project. Signing in here
// instead would spend the login rate-limit budget once per test per device, and
// that is exactly how an earlier version of this file locked the suite out.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByPlaceholder('Password'), 'the saved session should already be signed in')
    .toHaveCount(0);
});

/** Open settings however this viewport exposes it. */
async function openSettings(page: import('@playwright/test').Page) {
  const gear = page.locator('[aria-label*="ettings" i], [title*="ettings" i]').first();
  if (await gear.count()) {
    await gear.click();
  } else {
    // Fall back to the command palette, which is the keyboard route in.
    await page.keyboard.press('Control+P');
    await page.keyboard.type('settings');
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.settings-modal')).toBeVisible();
}

test('the settings dialog can be closed', async ({ page }) => {
  await openSettings(page);
  const modal = page.locator('.settings-modal');

  // The control has to be REACHABLE, not merely present in the DOM. The nav
  // strip scrolls horizontally on a narrow screen, and a close button that
  // scrolled away with the tabs would reintroduce the dead end it exists to fix.
  const close = page.getByRole('button', { name: /close settings/i });
  await expect(close).toBeVisible();
  await expect(close).toBeInViewport();

  await close.click();
  await expect(modal).toHaveCount(0);
});

test('the close control survives scrolling the section tabs', async ({ page }) => {
  await openSettings(page);
  const nav = page.locator('.settings-nav');
  // Scroll the strip to its far end, where an unpinned control would be gone.
  await nav.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const close = page.getByRole('button', { name: /close settings/i });
  await expect(close).toBeInViewport();
  await close.click();
  await expect(page.locator('.settings-modal')).toHaveCount(0);
});

test('Escape closes the dialog', async ({ page }) => {
  await openSettings(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-modal')).toHaveCount(0);
});

test('every section renders without throwing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openSettings(page);
  const tabs = page.locator('.settings-nav button:not(.settings-close)');
  const count = await tabs.count();
  expect(count).toBeGreaterThan(5);

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const name = (await tab.textContent())?.trim() ?? `tab ${i}`;
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    // The panel heading confirms the section actually mounted rather than
    // leaving an empty pane, which is what a section wired into the nav array
    // but not the render switch looks like.
    await expect(page.locator('.settings-content h2'), `${name} should render a panel`).toBeVisible();
  }
  expect(errors, 'no section may throw').toEqual([]);
});

test('nothing on the settings page shows a secret in clear', async ({ page }) => {
  await openSettings(page);
  for (const section of [/single sign-on/i, /livesync/i, /github/i]) {
    const tab = page.locator('.settings-nav button', { hasText: section });
    if (!(await tab.count())) continue;
    await tab.first().scrollIntoViewIfNeeded();
    await tab.first().click();
    // Secrets round-trip as the redaction sentinel. A password-type input whose
    // value is neither empty nor the sentinel means a real credential was sent
    // to the browser.
    const secrets = page.locator('.settings-content input[type="password"]');
    for (let i = 0; i < (await secrets.count()); i++) {
      const value = await secrets.nth(i).inputValue();
      if (value) expect(value).toMatch(/^[•*]+$/);
    }
  }
});
