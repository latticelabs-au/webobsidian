/**
 * The contract between what isAllowed() READS and what an operator can WRITE.
 *
 * This file exists because `oidc.allowedEmails` was matched on from the day SSO
 * landed and was never declared in the zod schema. Zod objects strip unknown
 * keys by default, so the field was deleted from settings.json on the first load
 * and every write after it. The matcher had a paragraph of documentation about
 * how an entry there requires email_verified, the settings page had no control
 * for it, the PUT allowlist had no branch for it, and the list it compared
 * against was permanently empty. An operator who configured only that got a
 * locked instance and a log line saying their account "matched no allowlist
 * entry", which is true and completely unhelpful.
 *
 * The general shape of the bug is the four-file contract this repo documents:
 * schema, redaction, PUT allowlist, UI panel. Miss one and the failure is
 * silent, and a silent failure in an AUTHORIZATION allowlist is the worst place
 * to have one, because both directions are bad. An axis that is always empty
 * locks people out; the same mistake on a deny-list would let them in.
 *
 * So these tests are deliberately mechanical: for every axis the matcher reads,
 * seed it, load it back, and prove it survived. A new axis added to
 * OidcSettings without its schema entry fails here rather than in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import {
  makeTmpDataDir,
  writeSettings,
  resetSettingsCache,
  makeTestApp,
  type TmpDir,
} from './helpers.js';

let tmp: TmpDir | undefined;

const OIDC_BASE = {
  enabled: true,
  issuer: 'https://auth.example.com',
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'https://notes.example.com/auth/oidc/callback',
  scopes: ['openid', 'profile', 'email', 'groups'],
};

async function boot(oidc: Record<string, unknown>) {
  resetSettingsCache();
  tmp = await makeTmpDataDir();
  await writeSettings(tmp.dataDir, { oidc: { ...OIDC_BASE, ...oidc } });

  const settings = await import('../services/settings.js');
  const { settingsRouter } = await import('../routes/settings.js');
  const { errorHandler } = await import('../middleware/error.js');
  const { issueToken } = await import('../services/auth.js');
  const oidcService = await import('../services/oidc.js');

  const app = makeTestApp();
  app.use('/api/settings', settingsRouter);
  app.use(errorHandler);
  const token = await issueToken();
  return { app, token, settings, oidcService };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tmp?.cleanup();
  tmp = undefined;
});

describe('every allowlist axis survives a load', () => {
  /*
   * One case per axis, and the assertion is always the same: what went into
   * settings.json is what getOidcSettings() reads back. `allowedEmails` is the
   * one that regressed; the others are here so the next addition cannot.
   */
  const AXES: { name: string; seed: Record<string, unknown>; read: (s: any) => unknown }[] = [
    {
      name: 'allowedSubjects',
      seed: { allowedSubjects: ['774ebec3-d4a1-461e-a5b6-2dbc1c5faefd'] },
      read: (s) => s.allowedSubjects,
    },
    { name: 'allowedGroups', seed: { allowedGroups: ['vault-admins'] }, read: (s) => s.allowedGroups },
    { name: 'allowedEmails', seed: { allowedEmails: ['ops@example.com'] }, read: (s) => s.allowedEmails },
    {
      name: 'allowedClaims',
      seed: { allowedClaims: [{ claim: 'preferred_username', values: ['addie'] }] },
      read: (s) => s.allowedClaims,
    },
  ];

  it.each(AXES)('$name is not stripped by the schema', async ({ seed, read }) => {
    const b = await boot(seed);
    const loaded = await b.oidcService.getOidcSettings();
    const value = read(loaded);
    expect(value, 'the axis must survive the schema, not heal to empty').not.toEqual([]);
    expect(Array.isArray(value) && value.length).toBeGreaterThan(0);
  });

  it('an axis that only the matcher knows about would fail this test', async () => {
    // Documents the failure mode rather than asserting on a name: a key the
    // schema does not declare is dropped, which is exactly what happened.
    const b = await boot({ notARealAxis: ['x'] });
    // Double cast because OidcSettings has no index signature, which is itself
    // the point: a key nothing declares cannot be read without going around the
    // type system, and going around it is exactly what the bug did.
    const loaded = (await b.oidcService.getOidcSettings()) as unknown as Record<string, unknown>;
    expect(loaded.notARealAxis).toBeUndefined();
  });
});

describe('every allowlist axis is writable through the API', () => {
  async function putOidc(b: Awaited<ReturnType<typeof boot>>, oidc: Record<string, unknown>) {
    return request(b.app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ oidc });
  }

  it('accepts and persists an email allowlist', async () => {
    const b = await boot({ allowedSubjects: ['keep-me-reachable'] });
    const res = await putOidc(b, { allowedEmails: ['Ops@Example.COM'] });
    expect(res.status).toBe(200);

    const loaded = await b.oidcService.getOidcSettings();
    // Folded on the way in so the stored value is the value compared. Storing
    // the operator's capitalisation and folding only at compare time would work
    // too, but then the two entry points (API and hand-edited file) would have
    // to agree forever, and they are in different files.
    expect(loaded.allowedEmails).toEqual(['ops@example.com']);
  });

  it('accepts and persists claim rules', async () => {
    const b = await boot({ allowedSubjects: ['keep-me-reachable'] });
    const res = await putOidc(b, {
      allowedClaims: [{ claim: 'nextcloud_username', values: ['addie'] }],
    });
    expect(res.status).toBe(200);
    const loaded = await b.oidcService.getOidcSettings();
    expect(loaded.allowedClaims).toEqual([{ claim: 'nextcloud_username', values: ['addie'] }]);
  });

  it('refuses a claim rule that would admit the whole issuer', async () => {
    const b = await boot({ allowedSubjects: ['keep-me-reachable'] });
    const res = await putOidc(b, { allowedClaims: [{ claim: 'iss', values: ['https://auth.example.com'] }] });
    expect(res.status).toBe(400);
    // The refusal has to explain itself. A bare "invalid" on this field would
    // read as a bug in the form rather than as the deliberate guard it is.
    expect(res.body?.error ?? res.text).toMatch(/every user|admit/i);
  });

  it('refuses a claim rule with no values instead of storing a rule that matches nothing', async () => {
    const b = await boot({ allowedSubjects: ['keep-me-reachable'] });
    const res = await putOidc(b, { allowedClaims: [{ claim: 'department', values: [] }] });
    expect(res.status).toBe(400);
  });
});
