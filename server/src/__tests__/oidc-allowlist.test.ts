/**
 * The SSO authorization decision.
 *
 * `isAllowed()` is the only thing standing between "the IdP says this person
 * exists" and "this person owns the vault", so it gets a truth table rather than
 * a happy-path test. The cases that matter most are the ones where a rule looks
 * specific and is not: a claim that carries the same value in everybody's token
 * turns an allowlist into `return true`, and that mistake is invisible from the
 * login screen because a successful login looks identical either way.
 */
import { describe, it, expect } from 'vitest';
import { isAllowed, isReservedClaim } from '../services/oidc.js';
import type { OidcSettings, OidcIdentity } from '../services/oidc.js';

/** A settings block with nothing allowed; each test opens exactly one door. */
function settings(over: Partial<OidcSettings> = {}): OidcSettings {
  return {
    enabled: true,
    pkce: 'auto',
    issuer: 'https://auth.example.com',
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://notes.example.com/auth/oidc/callback',
    allowedSubjects: [],
    allowedGroups: [],
    allowedEmails: [],
    allowedClaims: [],
    ...over,
  };
}

/**
 * An identity shaped like a real Pocket ID token, custom claims and all. The
 * claim set is copied from an actual token rather than invented, because the
 * whole feature exists to handle claims no specification mentions.
 */
function identity(over: Partial<OidcIdentity> = {}): OidcIdentity {
  const claims: Record<string, unknown> = {
    iss: 'https://auth.example.com',
    sub: '774ebec3-d4a1-461e-a5b6-2dbc1c5faefd',
    aud: ['client'],
    type: 'id-token',
    email: 'hello@example.com',
    email_verified: true,
    preferred_username: 'addie',
    nextcloud_username: 'addie',
    portainer_username: 'admin',
    name: 'Cosmo',
    ...(over.claims as Record<string, unknown> | undefined),
  };
  return {
    iss: 'https://auth.example.com',
    sub: '774ebec3-d4a1-461e-a5b6-2dbc1c5faefd',
    name: 'Cosmo',
    email: 'hello@example.com',
    emailVerified: true,
    preferredUsername: 'addie',
    groups: [],
    ...over,
    claims,
  };
}

describe('an empty allowlist admits nobody', () => {
  it('refuses a perfectly valid identity when every list is empty', () => {
    expect(isAllowed(identity(), settings())).toBe(false);
  });

  it('still refuses when a claim rule exists but names a claim the token lacks', () => {
    const s = settings({ allowedClaims: [{ claim: 'department', values: ['eng'] }] });
    expect(isAllowed(identity(), s)).toBe(false);
  });
});

describe('the fixed axes still work', () => {
  it('matches a subject exactly', () => {
    const s = settings({ allowedSubjects: ['774ebec3-d4a1-461e-a5b6-2dbc1c5faefd'] });
    expect(isAllowed(identity(), s)).toBe(true);
  });

  it('does not fold case on a subject, which is opaque', () => {
    const s = settings({ allowedSubjects: ['774EBEC3-D4A1-461E-A5B6-2DBC1C5FAEFD'] });
    expect(isAllowed(identity(), s)).toBe(false);
  });

  it('folds case on groups and emails, which are not case-significant', () => {
    expect(isAllowed(identity({ groups: ['admins'] }), settings({ allowedGroups: ['Admins'] }))).toBe(true);
    expect(isAllowed(identity(), settings({ allowedEmails: ['HELLO@Example.com'] }))).toBe(true);
  });

  it('refuses an unverified email even when the address matches', () => {
    const s = settings({ allowedEmails: ['hello@example.com'] });
    expect(isAllowed(identity({ emailVerified: false }), s)).toBe(false);
  });
});

describe('claim rules', () => {
  it('matches a custom claim the specification never mentions', () => {
    const s = settings({ allowedClaims: [{ claim: 'nextcloud_username', values: ['addie'] }] });
    expect(isAllowed(identity(), s)).toBe(true);
  });

  it('matches any listed value for one claim', () => {
    const s = settings({ allowedClaims: [{ claim: 'preferred_username', values: ['bob', 'addie'] }] });
    expect(isAllowed(identity(), s)).toBe(true);
  });

  it('ORs across several rules, so one match anywhere is enough', () => {
    const s = settings({
      allowedClaims: [
        { claim: 'department', values: ['finance'] },
        { claim: 'portainer_username', values: ['admin'] },
      ],
    });
    expect(isAllowed(identity(), s)).toBe(true);
  });

  it('compares exactly, because a claim named by the operator has unknown semantics', () => {
    const s = settings({ allowedClaims: [{ claim: 'preferred_username', values: ['Addie'] }] });
    expect(isAllowed(identity(), s)).toBe(false);
  });

  it('matches inside an array-valued claim', () => {
    const s = settings({ allowedClaims: [{ claim: 'roles', values: ['editor'] }] });
    expect(isAllowed(identity({ claims: { roles: ['viewer', 'editor'] } }), s)).toBe(true);
  });

  it('compares a numeric claim against the string an operator typed', () => {
    const s = settings({ allowedClaims: [{ claim: 'uid', values: ['1042'] }] });
    expect(isAllowed(identity({ claims: { uid: 1042 } }), s)).toBe(true);
  });

  it('never matches a boolean claim, which is a flag rather than an identity', () => {
    // The failure this prevents: `is_active = true` reads like a rule and would
    // admit every active account at the IdP.
    const s = settings({ allowedClaims: [{ claim: 'is_active', values: ['true'] }] });
    expect(isAllowed(identity({ claims: { is_active: true } }), s)).toBe(false);
  });

  it('never matches an object or null by stringifying it', () => {
    const objRule = settings({ allowedClaims: [{ claim: 'address', values: ['[object Object]'] }] });
    expect(isAllowed(identity({ claims: { address: { city: 'Melbourne' } } }), objRule)).toBe(false);
    const nullRule = settings({ allowedClaims: [{ claim: 'manager', values: ['null'] }] });
    expect(isAllowed(identity({ claims: { manager: null } }), nullRule)).toBe(false);
  });

  it('makes a rule on an email-shaped claim inherit the verification requirement', () => {
    // Without the coupling, this rule would be a strictly weaker allowlist that
    // reads as strictly more specific than allowedEmails.
    const s = settings({ allowedClaims: [{ claim: 'email', values: ['hello@example.com'] }] });
    expect(isAllowed(identity(), s)).toBe(true);
    expect(isAllowed(identity({ emailVerified: false }), s)).toBe(false);
  });
});

describe('reserved claims cannot be used as an axis', () => {
  const everyoneClaims = ['iss', 'aud', 'azp', 'type', 'typ', 'scope', 'token_type'];
  const nobodyClaims = ['exp', 'iat', 'nbf', 'auth_time', 'nonce', 'jti', 'at_hash', 'c_hash', 's_hash'];

  it.each([...everyoneClaims, ...nobodyClaims, 'email_verified'])('refuses %s', (claim) => {
    expect(isReservedClaim(claim)).toBe(true);
  });

  it('refuses them case-insensitively, because claim names are matched that way at the API', () => {
    expect(isReservedClaim('ISS')).toBe(true);
    expect(isReservedClaim('  Aud  ')).toBe(true);
  });

  it('permits the claims that actually identify a person', () => {
    for (const claim of ['sub', 'email', 'preferred_username', 'nextcloud_username', 'groups', 'roles']) {
      expect(isReservedClaim(claim)).toBe(false);
    }
  });
});
