/**
 * Regression tests for the auth hardening.
 *
 * Four things are pinned here, and each of them is a bug that actually existed:
 *
 *  1. The default password (`123456`) is accepted ONLY when no other credential
 *     has been configured. The original defect tested `userPasswordHash` alone,
 *     so an instance that set `WEBOBSIDIAN_PASSWORD` (the documented
 *     docker-compose / .env deployment path) still accepted `123456` as a full
 *     owner session.
 *  2. `hasCustomPassword()` and the "is the default accepted?" branch are driven
 *     by the SAME predicate. Their disagreement was the actual defect: the
 *     ForceChangePassword screen submits `changePassword('123456', ...)`, so a UI
 *     that is told to force a change to a default that no longer works strands
 *     the user with no way through.
 *  3. The stored-hash format. The parameters are written into the string so the
 *     cost can be raised later, and the legacy 3-field form stays verifiable
 *     forever (a share created three versions ago must still unlock).
 *  4. A session token is bound to the credential state it was issued under, so a
 *     password change evicts every outstanding cookie.
 *
 * WHY EVERY TEST GOES THROUGH boot(). `services/password-policy.ts` and
 * `services/auth.ts` both read `config`, and `config.ts` snapshots process.env at
 * module-evaluation time. `WEBOBSIDIAN_PASSWORD` is therefore not a value a test
 * can set and re-read: it has to be in the environment BEFORE the first import.
 * A static `import { ... } from '../services/auth.js'` at the top of this file
 * would pin `config` to whatever the environment held when vitest loaded the
 * file, and every case below would silently exercise the same configuration.
 * boot() resets the module registry, points DATA_DIR at a throwaway directory,
 * sets the env var, writes the settings fixture, and only then imports.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { makeTmpDataDir, resetSettingsCache, writeSettings, type TmpDir } from './helpers.js';

/** ---- Fixture credentials ------------------------------------------------- */
//
// None of these is `123456`, deliberately. Every assertion below of the form
// "the default is refused" would pass for the wrong reason if a configured
// credential happened to BE the default.

const USER_PASSWORD = 'user-chosen-password';
const OVERRIDE_PASSWORD = 'hand-edited-override';
const ENV_PASSWORD = 'env-master-password';
const LEGACY_PASSWORD = 'password-from-an-older-build';

/**
 * Current-format hashes, computed once. scrypt at N=2^17 is deliberately
 * expensive (roughly half a second and 128 MiB per call, see SCRYPT_PARAMS), so
 * re-deriving these per test case would dominate the suite's runtime for no
 * added coverage: the stored string is just data once it exists.
 */
let userHash = '';
let overrideHash = '';

/**
 * A hash in the pre-parameters format, built here with node's own scrypt
 * defaults rather than by asking the module under test for one.
 *
 * That independence is the point. `LEGACY_SCRYPT_PARAMS` in services/auth.ts is
 * a claim about what older builds wrote (node's defaults: N=16384, r=8, p=1,
 * keylen 64). Producing the fixture from the same constant would make the test
 * agree with the claim by construction and would keep passing if the constant
 * were changed to something no historical hash was ever produced with.
 */
function legacyFormatHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}

beforeAll(async () => {
  const { hashPassword } = await import('../services/auth.js');
  [userHash, overrideHash] = await Promise.all([
    hashPassword(USER_PASSWORD),
    hashPassword(OVERRIDE_PASSWORD),
  ]);
}, 120_000);

/** ---- Per-test environment ------------------------------------------------ */

let tmp: TmpDir | null = null;
let savedEnvPassword: string | undefined;

beforeEach(() => {
  savedEnvPassword = process.env.WEBOBSIDIAN_PASSWORD;
});

afterEach(async () => {
  if (savedEnvPassword === undefined) delete process.env.WEBOBSIDIAN_PASSWORD;
  else process.env.WEBOBSIDIAN_PASSWORD = savedEnvPassword;
  // makeTmpDataDir's cleanup restores DATA_DIR / VAULT_PATH itself.
  if (tmp) await tmp.cleanup();
  tmp = null;
});

/** The three credentials that can exist independently of each other. */
interface Credentials {
  /** auth.userPasswordHash: the password the owner set through the UI. */
  user: boolean;
  /** auth.passwordHash: the recovery override, hand-edited into settings.json. */
  override: boolean;
  /** WEBOBSIDIAN_PASSWORD: the plaintext recovery override from the env. */
  env: boolean;
}

interface MatrixCase extends Credentials {
  /** Expected result of isDefaultPasswordActive for this combination. */
  defaultActive: boolean;
  label: string;
}

/**
 * All eight combinations. `defaultActive` is true in exactly one of them, which
 * is the whole specification: `123456` works only on an instance that has no
 * other credential at all.
 */
const MATRIX: MatrixCase[] = [
  { user: false, override: false, env: false, defaultActive: true, label: 'no credential configured' },
  { user: false, override: false, env: true, defaultActive: false, label: 'WEBOBSIDIAN_PASSWORD only' },
  { user: false, override: true, env: false, defaultActive: false, label: 'auth.passwordHash only' },
  { user: false, override: true, env: true, defaultActive: false, label: 'both overrides' },
  { user: true, override: false, env: false, defaultActive: false, label: 'user password only' },
  { user: true, override: false, env: true, defaultActive: false, label: 'user password + WEBOBSIDIAN_PASSWORD' },
  { user: true, override: true, env: false, defaultActive: false, label: 'user password + auth.passwordHash' },
  { user: true, override: true, env: true, defaultActive: false, label: 'all three configured' },
];

/**
 * Bring up a fresh module registry with the given credential state in place, and
 * hand back the modules under test. See the file header for why this cannot be a
 * static import.
 */
async function boot(state: Credentials) {
  resetSettingsCache();
  tmp = await makeTmpDataDir();
  if (state.env) process.env.WEBOBSIDIAN_PASSWORD = ENV_PASSWORD;
  else delete process.env.WEBOBSIDIAN_PASSWORD;

  await writeSettings(tmp.dataDir, {
    // `userPasswordHash` is written explicitly even when empty: its ABSENCE from
    // the raw JSON is the signal that triggers the v1 -> v2 auth migration in
    // settings.ts, which would move `passwordHash` into `userPasswordHash` and
    // quietly turn the override cases below into user-password cases.
    auth: {
      userPasswordHash: state.user ? userHash : '',
      passwordHash: state.override ? overrideHash : '',
      jwtSecret: 'test-jwt-secret-0123456789abcdef',
    },
    vault: { path: tmp.vaultDir },
  });

  const [auth, policy, settings] = await Promise.all([
    import('../services/auth.js'),
    import('../services/password-policy.js'),
    import('../services/settings.js'),
  ]);
  return { auth, policy, settings };
}

/** ------------------------------------------------------------------------- */

describe('isDefaultPasswordActive: the default-password matrix', () => {
  it.each(MATRIX)('$label -> default active: $defaultActive', async (c) => {
    const { policy } = await boot(c);
    expect(
      policy.isDefaultPasswordActive({
        userPasswordHash: c.user ? userHash : '',
        passwordHash: c.override ? overrideHash : '',
      }),
    ).toBe(c.defaultActive);
  });

  it('reads the env override live rather than only the two hashes it is passed', async () => {
    // The predicate takes the hashes as an argument but pulls the third input
    // (WEBOBSIDIAN_PASSWORD) from `config`. This pins that third input: identical
    // arguments, opposite answers, because the environment differs.
    const withoutEnv = await boot({ user: false, override: false, env: false });
    expect(withoutEnv.policy.isDefaultPasswordActive({ userPasswordHash: '', passwordHash: '' })).toBe(
      true,
    );
    await tmp?.cleanup();
    tmp = null;

    const withEnv = await boot({ user: false, override: false, env: true });
    expect(withEnv.policy.isDefaultPasswordActive({ userPasswordHash: '', passwordHash: '' })).toBe(
      false,
    );
  });
});

describe('the original bug: WEBOBSIDIAN_PASSWORD left 123456 working', () => {
  it('refuses 123456 on an instance whose only credential is WEBOBSIDIAN_PASSWORD', async () => {
    const { auth, policy } = await boot({ user: false, override: false, env: true });

    // Pinned rather than assumed: every other assertion in this file about "the
    // default" means nothing if the constant has drifted.
    expect(auth.DEFAULT_PASSWORD).toBe('123456');

    expect(policy.isDefaultPasswordActive({ userPasswordHash: '', passwordHash: '' })).toBe(false);
    expect(await auth.authenticatePassword('123456')).toBeNull();
    expect(await auth.checkPassword('123456')).toBe(false);

    // The configured credential does work, so the refusal above is the rule
    // firing and not a broken fixture.
    expect(await auth.authenticatePassword(ENV_PASSWORD)).toBe('override-env');

    // And the operator is not then told to change a password that no longer works.
    expect(await auth.hasCustomPassword()).toBe(true);
  });

  it('refuses 123456 on an instance whose only credential is a hand-edited auth.passwordHash', async () => {
    const { auth } = await boot({ user: false, override: true, env: false });
    expect(await auth.checkPassword('123456')).toBe(false);
    expect(await auth.authenticatePassword(OVERRIDE_PASSWORD)).toBe('override-hash');
    expect(await auth.hasCustomPassword()).toBe(true);
  });
});

describe('hasCustomPassword and the default-accepted condition cannot disagree', () => {
  it.each(MATRIX)('$label', async (c) => {
    const { auth, policy, settings } = await boot(c);
    const stored = await settings.getSettings();

    // One predicate, three consumers: the login path, the "must change" flag and
    // the redacted settings payload. They are asserted against each other rather
    // than each against a literal, because agreement is the property that broke.
    const defaultActive = policy.isDefaultPasswordActive(stored.auth);
    expect(defaultActive).toBe(c.defaultActive);

    const defaultAccepted = await auth.checkPassword(auth.DEFAULT_PASSWORD);
    const custom = await auth.hasCustomPassword();

    expect(defaultAccepted).toBe(defaultActive);
    expect(custom).toBe(!defaultActive);
    // The invariant the ForceChangePassword screen depends on: it is shown when
    // hasCustomPassword() is false, and what it submits is the default password.
    expect(custom).toBe(!defaultAccepted);

    // redactSettings publishes the same bit to the client. A fourth copy of the
    // condition here would be exactly the drift this whole module exists to stop.
    expect(settings.redactSettings(stored).auth.hasCustomPassword).toBe(custom);

    // Whichever credentials this case configured still authenticate. Without
    // this the case would also pass if the fixture had written nothing at all.
    if (c.user) expect(await auth.authenticatePassword(USER_PASSWORD)).toBe('user');
    if (c.override) expect(await auth.authenticatePassword(OVERRIDE_PASSWORD)).toBe('override-hash');
    if (c.env) expect(await auth.authenticatePassword(ENV_PASSWORD)).toBe('override-env');
  });

  it('lets the forced change through when, and only when, the change screen is shown', async () => {
    // This is the user-visible consequence of the two conditions agreeing. The
    // screen is rendered on !hasCustomPassword() and submits the default as the
    // CURRENT password, so changePassword must accept it.
    const { auth } = await boot({ user: false, override: false, env: false });
    expect(await auth.hasCustomPassword()).toBe(false);

    await expect(auth.changePassword(auth.DEFAULT_PASSWORD, 'a-real-password')).resolves.toBeUndefined();

    expect(await auth.hasCustomPassword()).toBe(true);
    expect(await auth.checkPassword('a-real-password')).toBe(true);
    // The default is gone the moment a real password exists.
    expect(await auth.checkPassword(auth.DEFAULT_PASSWORD)).toBe(false);
  });

  it('enforces the minimum length on the forced change', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const tooShort = 'x'.repeat(auth.MIN_PASSWORD_LEN - 1);
    await expect(auth.changePassword(auth.DEFAULT_PASSWORD, tooShort)).rejects.toThrow();
    // Refused, so the instance is still on the default and still reachable.
    expect(await auth.checkPassword(auth.DEFAULT_PASSWORD)).toBe(true);
  });

  it('rejects a wrong current password on change-password', async () => {
    const { auth } = await boot({ user: true, override: false, env: false });
    await expect(auth.changePassword('not-the-password', 'a-real-password')).rejects.toThrow(
      /incorrect/i,
    );
    expect(await auth.checkPassword(USER_PASSWORD)).toBe(true);
  });
});

describe('password hashing', () => {
  it('verifies a hash it produced, and refuses a wrong password', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const stored = await auth.hashPassword('correct horse battery staple');

    expect(await auth.verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await auth.verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await auth.verifyPassword('', stored)).toBe(false);
    // Case matters, and so does trailing whitespace: both would be silently
    // accepted by a comparison that normalised its input.
    expect(await auth.verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await auth.verifyPassword('correct horse battery staple ', stored)).toBe(false);
  });

  it('writes the cost parameters into the string, and a fresh salt every time', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const a = await auth.hashPassword(USER_PASSWORD);
    const b = await auth.hashPassword(USER_PASSWORD);

    // The parameter field is what makes the cost migrateable rather than pinned
    // forever to whatever node defaulted to on the day the hash was written.
    expect(a).toMatch(/^scrypt\$N=131072,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    // Same password, different stored string: the salt is per-hash.
    expect(a).not.toBe(b);
    expect(await auth.verifyPassword(USER_PASSWORD, b)).toBe(true);
    expect(auth.needsRehash(a)).toBe(false);
  });

  it('still accepts the legacy 3-field format, and marks it for upgrade', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const legacy = await legacyFormatHash(LEGACY_PASSWORD);

    expect(legacy.split('$')).toHaveLength(3);
    expect(await auth.verifyPassword(LEGACY_PASSWORD, legacy)).toBe(true);
    expect(await auth.verifyPassword('wrong', legacy)).toBe(false);
    // Readable forever, but not left at the old cost once the plaintext is in hand.
    expect(auth.needsRehash(legacy)).toBe(true);
  });

  it('upgrades a legacy stored password on the one occasion it can: a successful login', async () => {
    resetSettingsCache();
    tmp = await makeTmpDataDir();
    delete process.env.WEBOBSIDIAN_PASSWORD;
    const legacy = await legacyFormatHash(LEGACY_PASSWORD);
    await writeSettings(tmp.dataDir, {
      auth: { userPasswordHash: legacy, passwordHash: '', jwtSecret: 'test-jwt-secret-0123456789abcdef' },
      vault: { path: tmp.vaultDir },
    });
    const auth = await import('../services/auth.js');
    const settings = await import('../services/settings.js');

    expect(await auth.authenticatePassword(LEGACY_PASSWORD)).toBe('user');

    const after = (await settings.getSettings()).auth.userPasswordHash;
    expect(after).not.toBe(legacy);
    expect(auth.needsRehash(after)).toBe(false);
    // The upgrade must not change what the password IS.
    expect(await auth.verifyPassword(LEGACY_PASSWORD, after)).toBe(true);
    expect(await auth.checkPassword(LEGACY_PASSWORD)).toBe(true);
  });

  it('refuses malformed stored strings instead of throwing', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const valid = await auth.hashPassword(USER_PASSWORD);
    const [, params, salt, hash] = valid.split('$');

    const malformed = [
      '',
      'scrypt',
      'scrypt$',
      `scrypt$${salt}`,
      `bcrypt$${params}$${salt}$${hash}`,
      // Five fields: neither the legacy nor the current shape.
      `scrypt$${params}$${salt}$${hash}$extra`,
      // Unparseable / implausible cost parameters. N below 2^14 would be a
      // downgrade, N above 2^20 is a multi-gigabyte allocation on the login path.
      `scrypt$N=1,r=8,p=1$${salt}$${hash}`,
      `scrypt$N=2097152,r=8,p=1$${salt}$${hash}`,
      `scrypt$N=131073,r=8,p=1$${salt}$${hash}`, // not a power of two
      `scrypt$garbage$${salt}$${hash}`,
      // Non-hex fields. Buffer.from(x, 'hex') stops silently at the first bad
      // character, so without the isHex guard these decode to a SHORT buffer and
      // get compared as if they were a legitimate (shorter) digest.
      `scrypt$${params}$zz${salt.slice(2)}$${hash}`,
      `scrypt$${params}$${salt}$zz${hash.slice(2)}`,
      `scrypt$${params}$${salt.slice(0, -1)}$${hash}`, // odd length
      `scrypt$${params}$$${hash}`,
    ];

    for (const stored of malformed) {
      expect(await auth.verifyPassword(USER_PASSWORD, stored), stored).toBe(false);
      // Nothing can be done with an unreadable string, so it must not be
      // reported as upgradeable either: rewriting it would destroy a hash we
      // merely failed to parse.
      expect(auth.needsRehash(stored), stored).toBe(false);
    }
  });

  it('refuses a truncated digest that is a valid prefix of the real one', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const valid = await auth.hashPassword(USER_PASSWORD);
    const [, params, salt, hash] = valid.split('$');
    const truncated = `scrypt$${params}$${salt}$${hash.slice(0, 64)}`;

    // The length check in verifyPassword is what stops a comparison against a
    // short digest from succeeding on a matching prefix.
    expect(await auth.verifyPassword(USER_PASSWORD, truncated)).toBe(false);
  });
});

describe('session tokens are bound to the credential state that issued them', () => {
  it('stops verifying once the password changes', async () => {
    const { auth, settings } = await boot({ user: false, override: false, env: false });
    const token = await auth.issueToken();
    expect(await auth.verifyToken(token)).toBe(true);

    await settings.updateSettings((d) => {
      d.auth.userPasswordHash = userHash;
    });

    // No session store exists, so this claim is the only thing that can evict a
    // 30-day cookie that was captured before the password changed.
    expect(await auth.verifyToken(token)).toBe(false);
  });

  it('refuses a token that carries no cv claim', async () => {
    const { auth, settings } = await boot({ user: false, override: false, env: false });
    const s = await settings.getSettings();
    const preUpgrade = jwt.sign({ sub: 'owner' }, s.auth.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '30d',
    });
    // Accepting one "for compatibility" would leave exactly the bypass the claim
    // exists to close, since a stolen pre-upgrade cookie is the token an attacker
    // would replay.
    expect(await auth.verifyToken(preUpgrade)).toBe(false);
  });

  it('refuses a share unlock token replayed as an owner session', async () => {
    const { auth, settings } = await boot({ user: false, override: false, env: false });
    const s = await settings.getSettings();
    // Same jwtSecret signs the public share cookies, so `sub` is the only thing
    // separating a share visitor from the owner.
    const shareToken = jwt.sign({ sub: 'share', id: 'some-share' }, s.auth.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    expect(await auth.verifyToken(shareToken)).toBe(false);
  });

  it('refuses an unsigned (alg=none) token and outright garbage', async () => {
    const { auth } = await boot({ user: false, override: false, env: false });
    const unsigned = jwt.sign({ sub: 'owner', cv: 'anything' }, '', { algorithm: 'none' });
    expect(await auth.verifyToken(unsigned)).toBe(false);
    expect(await auth.verifyToken('not.a.token')).toBe(false);
    expect(await auth.verifyToken('')).toBe(false);
  });
});
