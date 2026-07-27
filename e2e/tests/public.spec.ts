/**
 * The surface an anonymous visitor can reach, against a live instance behind its
 * real reverse proxy.
 *
 * The proxy is the point. A cookie's Secure flag, the forwarded scheme, the CSP
 * that decides whether the SSO button can navigate at all, and the Origin check
 * on the WebSocket upgrade are all properties of the deployment rather than of
 * the code, so none of them can be tested in-process. Every one of them has a
 * failure mode that looks like "login just does not work" with nothing in the
 * browser console to say why.
 *
 * RUNS IN ONE PROJECT, NOT PER DEVICE, and that is deliberate. Two tests here
 * deliberately submit a wrong password, and login is limited to 10 attempts per
 * 15 minutes per network. Running them once per device profile doubled the spend
 * for no extra coverage: these are protocol-level assertions, and an HTTP status
 * code does not vary by user agent.
 */
import { test, expect } from '@playwright/test';

test.describe('pre-auth surface', () => {
  test('the status endpoint reveals nothing about the password state', async ({ request }) => {
    const res = await request.get('/auth/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // The whole point of the reduced payload: a scanner must not be able to ask
    // an instance whether it still accepts the default password.
    expect(Object.keys(body).sort()).toEqual(['passwordSet', 'ssoEnabled']);
    expect(body).not.toHaveProperty('mustChangePassword');
  });

  test('every authenticated route refuses an anonymous request', async ({ request }) => {
    for (const path of ['/api/settings', '/api/keys', '/api/files', '/api/livesync/status']) {
      const res = await request.get(path);
      expect(res.status(), `${path} should require auth`).toBe(401);
    }
  });

  test('the default password is refused', async ({ request }) => {
    const res = await request.post('/auth/login', { data: { password: '123456' } });
    expect(res.status()).not.toBe(200);
  });

  test('the login page offers SSO when the provider is configured', async ({ page, request }) => {
    const { ssoEnabled } = await (await request.get('/auth/status')).json();
    await page.goto('/');
    await expect(page.getByPlaceholder('Password')).toBeVisible();
    const sso = page.getByRole('button', { name: /sign in with sso/i });
    if (ssoEnabled) await expect(sso).toBeVisible();
    else await expect(sso).toHaveCount(0);
  });
});

test.describe('the OIDC redirect chain', () => {
  test('hands off to the provider with state, nonce and a PKCE challenge', async ({ request }) => {
    const { ssoEnabled } = await (await request.get('/auth/status')).json();
    test.skip(!ssoEnabled, 'no provider configured on this instance');

    // maxRedirects: 0 so the 302 itself is the subject. Following it would test
    // the provider's login page, which is not ours.
    const res = await request.get('/auth/oidc/login', { maxRedirects: 0 });
    expect(res.status()).toBe(302);

    const location = res.headers()['location'];
    expect(location, 'the login route must redirect to the provider').toBeTruthy();
    const url = new URL(location);
    expect(url.searchParams.get('response_type')).toBe('code');
    // Query mode is load-bearing: no express.urlencoded() is registered, so a
    // form_post callback would arrive with an empty body, and a SameSite=Lax
    // cookie is not sent on a cross-site top-level POST either way.
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    // PKCE defaults to 'auto', which sends S256 unless the provider has
    // explicitly published a method list that excludes it. A missing challenge
    // here is a silent downgrade and would otherwise be invisible.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  test('parks the transaction in a short-lived, scoped, HttpOnly cookie', async ({ request }) => {
    const { ssoEnabled } = await (await request.get('/auth/status')).json();
    test.skip(!ssoEnabled, 'no provider configured on this instance');

    const res = await request.get('/auth/oidc/login', { maxRedirects: 0 });
    const setCookie = res.headers()['set-cookie'] ?? '';
    expect(setCookie).toContain('HttpOnly');
    // Scoped to the callback path so it is not attached to every vault request.
    expect(setCookie).toContain('Path=/auth/oidc');
    expect(setCookie).toContain('SameSite=Lax');
    if (new URL(res.url()).protocol === 'https:') {
      // Over TLS this must be Secure, and that depends on the proxy forwarding
      // the scheme. If X-Forwarded-Proto is dropped the app believes it is
      // serving plain HTTP and the browser then refuses the session cookie,
      // which presents as "login succeeds and immediately logs out again".
      expect(setCookie).toContain('Secure');
    }
  });

  test('refuses a callback with no transaction, and says so without detail', async ({ request }) => {
    const res = await request.get('/auth/oidc/callback?code=made-up&state=made-up', {
      maxRedirects: 0,
    });
    // Back to the login screen with a short reason; the detail stays in the log
    // because an unauthenticated visitor can reach this.
    expect([302, 400]).toContain(res.status());
    const body = await res.text();
    expect(body).not.toMatch(/client_secret|clientSecret/i);
  });
});

test.describe('a wrong password gets nothing', () => {
  // These two spend the login budget, so they are last and there are only two of
  // them. The successful login lives in auth.setup.ts and happens exactly once.
  test('a wrong password is refused and the session stays anonymous', async ({ request }) => {
    const res = await request.post('/auth/login', { data: { password: 'definitely-not-it' } });
    expect(res.status()).not.toBe(200);
    expect((await request.get('/api/settings')).status()).toBe(401);
  });

  test('the refusal says nothing about why', async ({ request }) => {
    const res = await request.post('/auth/login', { data: { password: 'also-not-it' } });
    const body = await res.text();
    // No hint about whether a password is set, whether SSO is on, or what the
    // configured credential looks like. A 401 and a generic string, or a 429 if
    // the previous test already consumed the budget, which is itself correct
    // behaviour and not a failure.
    expect([401, 429]).toContain(res.status());
    expect(body).not.toMatch(/hash|scrypt|jwt|secret|env|WEBOBSIDIAN_PASSWORD/i);
  });
});
