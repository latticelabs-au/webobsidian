/**
 * Setup URI codec tests.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE OF THE TEST VECTORS -- READ THIS BEFORE CHANGING ANY LITERAL
 *
 * The single failure mode that would make this whole feature pointless is a
 * decoder that cannot read a URI the REAL Obsidian plugin produced. A test that
 * only round-trips our own encoder against our own decoder cannot detect that:
 * two mutually consistent implementations of the wrong format pass it happily.
 *
 * So the ciphertext literals below are NOT self-generated. Every one of them was
 * produced by the real `octagonal-wheels@0.1.51` -- the exact library the plugin
 * and our own vendored engine both call -- by invoking
 * `encryptWithEphemeralSalt`, `encrypt` and `encryptV1` directly and committing
 * the output. They are known-answer tests: the codec has to decrypt bytes it did
 * not produce, to a plaintext fixed in advance.
 *
 * The generator was run against
 * `webobsidian/node_modules/octagonal-wheels/dist/encryption/{hkdf,encryption}.js`.
 * It is not committed and is not needed to run these tests, which is the point:
 * `octagonal-wheels` is a dependency of the VENDORED ENGINE, not of the server,
 * and is only present here through hoisting. Depending on it at test time would
 * be the same undeclared-dependency trap that `peer-couchdb.ts` documents at
 * `decodeEntryData`, and it would make the suite silently stop testing interop
 * the day hoisting changed. Static vectors have neither problem.
 *
 * To regenerate after a deliberate format change, encrypt `PLAINTEXT_JSON` with
 * `SETUP_PASSPHRASE` using those two modules and replace the literals. If a
 * vector ever fails without a deliberate change, the codec has drifted from the
 * wire format and the feature is broken, however green everything else looks.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS *NOT* PINNED BY A REAL VECTOR, STATED LOUDLY
 *
 * No fixture anywhere in the reference tree pairs a known plaintext, a known
 * passphrase and a known ciphertext for the SETTINGS-OBJECT layer: upstream's
 * own tests round-trip against a live commonlib, and the plugin's unit specs
 * mock the codec out entirely. The vectors below therefore pin the ENVELOPE
 * (crypto, framing, encoding) against the real library, and the SETTINGS MAPPING
 * is pinned by structural assertions derived from the plugin's source rather
 * than by a captured example. The URI prefix, the percent-encoding step and the
 * `JSON.parse(decryptString(...))` pipeline are confirmed verbatim against the
 * plugin's own longhand decoder in
 * `reference/obsidian-livesync/src/modules/features/SetupWizard/dialogs/UseSetupURI.svelte:41-45`.
 */

import { describe, it, expect } from 'vitest';
import {
  decodeSetupUri,
  encodeSetupUri,
  unsupportedRemoteReason,
  SetupUriError,
  SETUP_URI_BASE,
  MAX_SETUP_URI_LENGTH,
  MIN_SETUP_URI_PASSPHRASE_LENGTH,
  type LiveSyncBlockView,
} from '../services/livesync/setup-uri.js';

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

const SETUP_PASSPHRASE = 'setup-secret';

/**
 * The astral-plane text (U+2714 U+FE0F, U+26A1, U+20BB7) is deliberate and load
 * bearing. It rides in `ignoreFiles`, which is a key the codec CARRIES rather
 * than drops, so the assertion reaches it. Hand-rolled UTF-8 and base64 code
 * breaks on surrogate pairs specifically, and upstream's own crypto self-tests
 * use astral input for exactly this reason.
 */
const ASTRAL = 'ignore-✔️⚡𠮷';

const PLAINTEXT_JSON =
  '{"couchDB_URI":"https://couch.example.test","couchDB_DBNAME":"notes","couchDB_USER":"alice",' +
  '"couchDB_PASSWORD":"couch-secret","passphrase":"vault-secret","encrypt":true,' +
  '"usePathObfuscation":true,"liveSync":false,"periodicReplication":true,' +
  '"periodicReplicationInterval":60,"syncInternalFiles":false,"customChunkSize":60,' +
  `"E2EEAlgorithm":"v2","chunkSplitterVersion":"v3-rabin-karp","ignoreFiles":"${ASTRAL}",` +
  '"isConfigured":true,"deviceAndVaultName":"device-local-name"}';

/** `%$` HKDF ephemeral-salt: the format a current plugin build emits. */
const VECTOR_HKDF =
  '%$gMp9FAFZxeUyOdu1c71/v+wHwpffH+1hbgO/AnDwz89y8ibEFfGgECd/h6dk/wDQ4g2c83IIAjA+mk14hJKzYMtN6f9M' +
  'gVLl901/q3vhoPEqaexsjjU93k50ZMk/TiP22suWQCE1hlo0J5TgpRhaHnFSaaNNn9Ng/8Sx1sr7Mw0TyXKS/B19qo3QY2Ay' +
  'IBp36Esr7akTTjrHGKAj0nW6vQF2+Y1z/YerbTAxX74c2wmYSEfWfy+RWvc1lOnYHH6wOkELD/Vw3cLazI1ba45ocOFXXDzv' +
  '3EzB6FB5KlJiOJ+pMCjQbnCxvuNUerAfte70SWdHAzKnm2ujzv0ws/md51Ib59A+xFuqtvE7F1Jzga46O8GaMWok9CZybSiG' +
  'SKZBcWv6SOdd4iV1d+oJYN0G0bPXH9spL0sYXUC8rz+1w4JyNs69SWl2e/IqJMaEQO2TwMiKrvgXzuFE1Eo9w16nbNpxrwRO' +
  'pMi3JfDYrlY0N+ey7wh61moy5y8NwkeJh9h3gP/d75GJZif7BYo7mRlYEkHKdMGgzfFnsMjywf0B8Ak2Hde1Fxteq6n9TAyq' +
  '1hcQxgm8oPkOkHZkG2bh7Kou2jbPehjKs5on3N8grx5DwOqxZrQEEXl3Sp06QGoXDcbgMkk4o9UWoN0e+BPjGvhm2VtirgR9' +
  'naW1FESy/Tq1Sk5qwjr6iM/0zgVdWKvaM85iFwhErenVM0UsW7AJYslZmGKBfWnENsN1qao8BtYu6SSCMs1avGMUzwc=';

/** `%` V2 legacy, fixed 100_000 iterations. */
const VECTOR_V2 =
  '%f9f0e60b03a4b9c4bcb864ca01000000678946a472521c1deea9ab383dc031a6O33ywXiigbNfACfJ0QZ7IsLZONLw5fe' +
  'oh7arnx5+UHbuIJoVxRnvpBR2q994guGRwNvWo6tHjO37fh4q/AU5ys7cJumIr6h35mWNdejDT5w6BN7f74xUUzPa8ZZB5WZ' +
  'gg5VVVbKtjd8G+fCe3hXl10f89WWWALbSukdsNGIBmxVenWoqHyyd0CVnJ3FXF2u31rr+lfpDpjxQyYTt8y700sWu90z//3T' +
  'Zbmox0PMtLO4F/ozMbYQMU5slDKpENBA7R5Zga/r5fmoQ/zwXZi7yE78Y26k3ydhdS2llGN9FxiIuBmwyX1Aa7RCqQ1p3J8e' +
  'Qav0j4fLOk1nf5P9zYBlPp3LRXZSmOupLP6Ecrt6KXNyeW/2eZMo2EgWpf7QIEcreQkd5QvJNayaP09C+JqoF2De+093cuWs' +
  'U6/+qsIjWTsiisPJA31DijlBStokJ5thJkIiFwqOlru/uGDFGvOrCQhs3aKYgjljfV/cVmY225+nPydnEfMGWPvInOxcvTMu' +
  'cIhXw4pffkPTPMHVYmdfmW5KCc/YrXCkbK0Br8K3ymM/eFWtaKR+5SPk0fP9JetCeEEsa9XJLHa3FVIWvZ7sZz5iEGHaEHO/' +
  'riO2+XFaFEzLKQGSnCo0fcTBLln6VAXt2egc5P3bmnDJ8wzvHNg==';

/** `[` V1 legacy, the oldest form -- note the extra JSON layer inside. */
const VECTOR_V1 =
  '["AH6FzhU3t1wbT4+iyyPY/SBrvdy0OMnopGDpSEnownAaTLXeup3z6OfcoojZz5K8V6kbNR2ibFHNVnu2NARrpQfgM/MyGy' +
  'Oh/IOrbLhjn3ZfNqdLBByOZSt+BL9WRQj4Hlsz/0MksJ9sB98vIXLgZhh+82HZ5Q8OHBSUniwhzmzUg9sZTF1DNuPR6yS4rR' +
  'QjubZkZzx12klflTbeVN5kDtshkY2d4ZD02OL+TlKzQoJe2oDSfKt9P+I/wu7xIrAst90VJKdVKqJAQv9xxGiMUS2GahJbBt' +
  'Mk9rcto7s4cJUDCjfb6J+v7pdKIWT1lB1BYaKbHHdnN2qU0py3jkkeJgR3zhczDr21WO4K95S2/iACvYKtgaCFHq5WdbbdBl' +
  'wevYXhAgFXFeMyBiMdHEcMNQB472vHCCOlRw8uYITp0RIUPcAc7Fs0Zu8YplSJJ4fjXCytd1Xl6U4z6CUohzdWTTnm0iNbLQ' +
  'MrNyu+b2HG0+rrmIEV0dyPjA70wbEuT8rpRsj9YhT/IAtvdd8yydWVpiMJGohzkDarrZ0tiVXLOSsjdNEIK1TWJuepmAP/Hl' +
  '/wyE8vYvCzr9rrGzkPDGOhYAF8v6Q00mtoXP3S6KQsXt4lGQJwzFGblmSXfYTwymYdJTJINajpAZuaHVd39ezIKJIxm90epe' +
  'wjkpG4g/5632GjGOtaW5/IFsrq851kPeMDrYFqx+KwFjP3ZjSOlUAHeV7Y3A==",' +
  '"f9f0e60b03a4b9c4bcb864ca02000000","678946a472521c1deea9ab383dc031a6"]';

/**
 * A V2 blob written under the DYNAMIC iteration count.
 *
 * Its passphrase is under 15 characters, so upstream's `useDynamicIterationCount`
 * arithmetic yields an iteration count that is not 100_000. Verified at
 * generation time that this vector does NOT decrypt under the fixed count, so it
 * genuinely exercises the two-mode retry loop rather than passing by accident.
 */
const VECTOR_V2_AUTO_PASSPHRASE = 'short-pass';
const VECTOR_V2_AUTO =
  '%f9f0e60b03a4b9c4bcb864ca030000008cd2ff0e98225e3cfd971b8177d968d4Enbka4rR63Tg/izWTJcVrXRMCXAkBiPY' +
  'JZYRy4cxDF6apNYlr852ZbPFYfTiamfBxIkUIUYjxBqJF480IcGBWziT6mYGRDc67bnWhABuMgCOkWdVPLJVfHuFwzElqskn' +
  'IAaq5WDk6jFGPQKWJA6QvgMR1GQj61Z6uNzbmrkDNZhpp4fWmpsWMVM9SCfTnMeROy+egL7AfmbIMcz9P8UlHPf/H4Qn1gbu' +
  'uGBxVWblEFoq4OO56CAfYHg6r2udXIoH8m0WcM/SE1YtzG6FiQQto5U0qTeeI/8ywCfs1o5P7WYir/PstN/DvHpHI9yy6LVf' +
  'dD9lIzKyWR8QWNIvYBmRrsCP2mOjzcSOciPKVgBwyMO7vZ2krI7pBOZSouux751uOTJxnUZ4K9lzHPUkemVmn3TK8wQz7fy0' +
  '/CIQ1I6H3kCQLds8GYNbLse3ysSo7uGTxEx635rHco3kkXeBEJCuhRwqBwYe38HruZy7w+/ofYrQuYwPw4hWMFs3z8bzcmD5' +
  '8Sq/DLgMFOu8Hn/vFiXtvCc6C6x4Jh4hDbtP7AGMvocddoJTpjhcmWaLPJIrHd6YF29i0f6dYX5vaQ96KZiSf2Aroyo5sKVM' +
  'aFWCs+wSCKpXZqbSuqHZDKeK33nU5baUMRxG+lXGvLK5mi5H+Q==';

/** Wrap a raw envelope in the URI shell exactly as the plugin does. */
const asUri = (envelope: string) => SETUP_URI_BASE + encodeURIComponent(envelope);

const BLOCK: LiveSyncBlockView = {
  uri: 'https://couch.example.test',
  database: 'notes',
  username: 'alice',
  password: 'couch-secret',
  passphrase: 'vault-secret',
  obfuscatePassphrase: 'vault-secret',
  liveMode: false,
  intervalSec: 60,
};

const LONG_PASSPHRASE = 'a-sufficiently-long-uri-passphrase';

// ---------------------------------------------------------------------------

describe('decoding a URI the real plugin library produced (known-answer tests)', () => {
  /**
   * The headline assertion of this entire file. If this fails, WebObsidian
   * cannot read a Setup URI from a real device and the feature is worthless,
   * regardless of how well it round-trips against itself.
   */
  it('decrypts a %$ HKDF envelope produced by octagonal-wheels', async () => {
    const decoded = await decodeSetupUri(asUri(VECTOR_HKDF), SETUP_PASSPHRASE);
    expect(decoded.block).toEqual(BLOCK);
  });

  it('decrypts a % V2 legacy envelope produced by octagonal-wheels', async () => {
    const decoded = await decodeSetupUri(asUri(VECTOR_V2), SETUP_PASSPHRASE);
    expect(decoded.block).toEqual(BLOCK);
  });

  it('decrypts a [ V1 legacy envelope, unwrapping its extra JSON layer', async () => {
    const decoded = await decodeSetupUri(asUri(VECTOR_V1), SETUP_PASSPHRASE);
    expect(decoded.block).toEqual(BLOCK);
  });

  it('decrypts a V2 blob written under the dynamic iteration count', async () => {
    const decoded = await decodeSetupUri(asUri(VECTOR_V2_AUTO), VECTOR_V2_AUTO_PASSPHRASE);
    expect(decoded.block).toEqual(BLOCK);
  });

  /**
   * UTF-8 across the surrogate-pair boundary. A codec that mishandles astral
   * characters still decrypts and still parses as JSON: it just silently
   * corrupts the text. Only an exact comparison catches it.
   */
  it('round-trips astral-plane UTF-8 out of a real ciphertext byte for byte', async () => {
    const decoded = await decodeSetupUri(asUri(VECTOR_HKDF), SETUP_PASSPHRASE);
    expect(decoded.carryOver.ignoreFiles).toBe(ASTRAL);
  });

  it('refuses every real vector under the wrong passphrase', async () => {
    for (const vector of [VECTOR_HKDF, VECTOR_V2, VECTOR_V1]) {
      await expect(decodeSetupUri(asUri(vector), 'not-the-passphrase')).rejects.toThrow(
        SetupUriError,
      );
    }
  });
});

describe('the settings mapping', () => {
  it('projects the plugin key names onto our block', async () => {
    const { block } = await decodeSetupUri(asUri(VECTOR_HKDF), SETUP_PASSPHRASE);
    expect(block.uri).toBe('https://couch.example.test');
    expect(block.database).toBe('notes');
    expect(block.username).toBe('alice');
    expect(block.password).toBe('couch-secret');
  });

  /**
   * The plugin has no separate obfuscation passphrase: `usePathObfuscation` is a
   * boolean keyed off `passphrase`. Adopting anything else would make the two
   * devices hash the same path to different `f:` ids.
   */
  it('derives obfuscatePassphrase from passphrase when usePathObfuscation is set', async () => {
    const { block, usePathObfuscation } = await decodeSetupUri(
      asUri(VECTOR_HKDF),
      SETUP_PASSPHRASE,
    );
    expect(usePathObfuscation).toBe(true);
    expect(block.obfuscatePassphrase).toBe(block.passphrase);
  });

  it('folds periodicReplication and its interval into one number', async () => {
    const { block } = await decodeSetupUri(asUri(VECTOR_HKDF), SETUP_PASSPHRASE);
    expect(block.intervalSec).toBe(60);
  });

  /**
   * A settings object can carry a leftover passphrase with `encrypt: false`.
   * Adopting it would turn E2EE ON against a remote written in the clear, which
   * is an `IncompatibleChanges`-class fault: it corrupts rather than erroring.
   */
  it('ignores a passphrase that arrives with encrypt disabled', async () => {
    const uri = await encodeSetupUri(
      { ...BLOCK, passphrase: '', obfuscatePassphrase: '' },
      LONG_PASSPHRASE,
      { passphrase: 'a-leftover-value', encrypt: false },
    );
    const { block, encrypt } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(encrypt).toBe(false);
    expect(block.passphrase).toBe('');
    expect(block.obfuscatePassphrase).toBe('');
  });

  it('keeps its own interval default when periodic replication is off', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE, {
      periodicReplication: false,
      periodicReplicationInterval: 999,
    });
    // The encoder rewrites both keys from the block, so re-decoding shows the
    // block's own interval rather than the carried 999.
    const { block } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(block.intervalSec).toBe(60);
  });

  it('normalises a trailing slash on the CouchDB URL', async () => {
    const uri = await encodeSetupUri(
      { ...BLOCK, uri: 'https://couch.example.test///' },
      LONG_PASSPHRASE,
    );
    const { block } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(block.uri).toBe('https://couch.example.test');
  });

  /**
   * Secrets are key material and must survive byte for byte, including
   * surrounding whitespace. Trimming one silently derives a different key, and
   * the symptom appears much later as undecryptable documents.
   */
  it('never trims secrets', async () => {
    const spaced = { ...BLOCK, password: '  pw  ', passphrase: ' pp ', obfuscatePassphrase: ' pp ' };
    const uri = await encodeSetupUri(spaced, LONG_PASSPHRASE);
    const { block } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(block.password).toBe('  pw  ');
    expect(block.passphrase).toBe(' pp ');
  });
});

describe('round-trip fidelity for keys we do not model', () => {
  /**
   * The codec layer is deliberately FAITHFUL (the HTTP layer is the strict one).
   * A user who passes a URI through WebObsidian must not silently lose their
   * ignore rules, plugin-sync configuration or the ~24 P2P keys.
   */
  it('carries unmodelled keys across a decode and back out again', async () => {
    const decoded = await decodeSetupUri(asUri(VECTOR_HKDF), SETUP_PASSPHRASE);
    expect(decoded.carryOver.customChunkSize).toBe(60);
    expect(decoded.carryOver.E2EEAlgorithm).toBe('v2');
    expect(decoded.carryOver.chunkSplitterVersion).toBe('v3-rabin-karp');

    const reEncoded = await encodeSetupUri(decoded.block, LONG_PASSPHRASE, decoded.carryOver);
    const again = await decodeSetupUri(reEncoded, LONG_PASSPHRASE);
    expect(again.carryOver.customChunkSize).toBe(60);
    expect(again.carryOver.E2EEAlgorithm).toBe('v2');
    expect(again.carryOver.chunkSplitterVersion).toBe('v3-rabin-karp');
    expect(again.block).toEqual(decoded.block);
  });

  it('preserves unknown future keys verbatim, including nested structure', async () => {
    const exotic = {
      someFutureKey: { nested: [1, 2, { deep: true }] },
      remoteConfigurations: [{ id: 'x', uri: 'sls+https://example' }],
      activeConfigurationId: 'x',
    };
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE, exotic);
    const { carryOver } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(carryOver.someFutureKey).toEqual(exotic.someFutureKey);
    expect(carryOver.remoteConfigurations).toEqual(exotic.remoteConfigurations);
    expect(carryOver.activeConfigurationId).toBe('x');
  });

  /**
   * Device identity and at-rest key material must not be transplanted. The
   * plugin drops the first group itself; the second describes how ONE device
   * encrypted its own data.json and is documented as never leaving that device.
   */
  it('drops device-local identity and at-rest secrets rather than carrying them', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE, {
      deviceAndVaultName: 'someone-elses-device',
      P2P_DevicePeerName: 'peer-name',
      configPassphrase: 'at-rest-secret',
      configPassphraseStore: 'LOCALSTORAGE',
      encryptedPassphrase: 'blob',
      encryptedCouchDBConnection: 'blob',
      isConfigured: true,
      useIndexedDBAdapter: true,
    });
    const { carryOver } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    for (const key of [
      'deviceAndVaultName',
      'P2P_DevicePeerName',
      'configPassphrase',
      'configPassphraseStore',
      'encryptedPassphrase',
      'encryptedCouchDBConnection',
      'isConfigured',
      'useIndexedDBAdapter',
    ]) {
      expect(carryOver[key]).toBeUndefined();
    }
  });

  it('drops those keys even when they arrive inside a real ciphertext', async () => {
    const { carryOver } = await decodeSetupUri(asUri(VECTOR_HKDF), SETUP_PASSPHRASE);
    expect(carryOver.deviceAndVaultName).toBeUndefined();
    expect(carryOver.isConfigured).toBeUndefined();
  });

  /**
   * One value, one home. If a projected key were also carried, an export would
   * emit both and which one the receiving plugin honoured would depend on key
   * order in the serialised JSON.
   */
  it('lets our own block win over a stale carried copy of a projected key', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE, {
      couchDB_URI: 'https://attacker.example',
      couchDB_PASSWORD: 'stale',
      liveSync: true,
    });
    const { block, carryOver } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(block.uri).toBe('https://couch.example.test');
    expect(block.password).toBe('couch-secret');
    expect(block.liveMode).toBe(false);
    expect(carryOver.couchDB_URI).toBeUndefined();
  });
});

describe('the shape the plugin will read back', () => {
  /**
   * The plugin merges a decoded object over DEFAULT_SETTINGS and reads the flat
   * `couchDB_*` fields, so these key NAMES are the interop contract. Asserting
   * on our own decoder would be circular, so the payload is inspected directly.
   */
  it('emits the plugin key names, not ours', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE);
    const payload = await decryptForInspection(uri, LONG_PASSPHRASE);
    expect(payload).toMatchObject({
      couchDB_URI: 'https://couch.example.test',
      couchDB_DBNAME: 'notes',
      couchDB_USER: 'alice',
      couchDB_PASSWORD: 'couch-secret',
      passphrase: 'vault-secret',
      encrypt: true,
      usePathObfuscation: true,
      liveSync: false,
      periodicReplication: true,
      periodicReplicationInterval: 60,
    });
  });

  it('starts with the exact prefix the plugin validates against', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE);
    expect(uri.startsWith('obsidian://setuplivesync?settings=')).toBe(true);
    // Upstream's own recogniser, from utils/flyio/generate_setupuri.test.ts.
    expect(uri).toMatch(/obsidian:\/\/setuplivesync\?settings=\S+/);
  });

  it('emits the current %$ HKDF envelope, percent-encoded', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE);
    const envelope = decodeURIComponent(uri.substring(SETUP_URI_BASE.length));
    expect(envelope.startsWith('%$')).toBe(true);
    // Percent-encoding is what makes standard-alphabet base64 (`+`, `/`, `=`)
    // safe in a query value. A raw `+` would be read as a space.
    expect(uri.substring(SETUP_URI_BASE.length)).not.toContain('+');
  });

  it('sets encrypt from the presence of a passphrase, and disables it when absent', async () => {
    const uri = await encodeSetupUri(
      { ...BLOCK, passphrase: '', obfuscatePassphrase: '' },
      LONG_PASSPHRASE,
    );
    const payload = await decryptForInspection(uri, LONG_PASSPHRASE);
    expect(payload.encrypt).toBe(false);
    expect(payload.usePathObfuscation).toBe(false);
  });

  it('never emits periodicReplication alongside liveSync', async () => {
    const live = await decryptForInspection(
      await encodeSetupUri({ ...BLOCK, liveMode: true }, LONG_PASSPHRASE),
      LONG_PASSPHRASE,
    );
    expect(live.liveSync).toBe(true);
    expect(live.periodicReplication).toBe(false);
  });

  /**
   * Rule E7: a Setup URI is not a configuration dump. It must never carry this
   * server's own filesystem layout, and it must never carry tweak values this
   * server does not actually pin (both sides adopt those from the remote
   * milestone document instead).
   */
  it('omits host filesystem layout and locally-unpinned tweaks', async () => {
    const payload = await decryptForInspection(
      await encodeSetupUri(BLOCK, LONG_PASSPHRASE),
      LONG_PASSPHRASE,
    );
    expect(payload.syncInternalFiles).toBeUndefined();
    expect(payload.syncInternalFilesTargetPatterns).toBeUndefined();
    expect(payload.E2EEAlgorithm).toBeUndefined();
    expect(payload.chunkSplitterVersion).toBeUndefined();
    expect(payload.isConfigured).toBeUndefined();
  });
});

describe('the obfuscation shape mismatch', () => {
  /**
   * The most consequential refusal in the codec. Emitting `usePathObfuscation:
   * true` while our own ids are hashed under a DIFFERENT string would make both
   * devices write `f:<hash>` ids for the same path under different hashes: every
   * file silently becomes two permanently divergent documents. Sync would look
   * like it was working.
   */
  it('refuses to encode when obfuscatePassphrase differs from passphrase', async () => {
    await expect(
      encodeSetupUri({ ...BLOCK, obfuscatePassphrase: 'a-different-string' }, LONG_PASSPHRASE),
    ).rejects.toMatchObject({ reason: 'unrepresentable' });
  });

  it('encodes happily when the two agree', async () => {
    await expect(encodeSetupUri(BLOCK, LONG_PASSPHRASE)).resolves.toContain(SETUP_URI_BASE);
  });

  it('encodes happily when obfuscation is off entirely', async () => {
    await expect(
      encodeSetupUri({ ...BLOCK, obfuscatePassphrase: '' }, LONG_PASSPHRASE),
    ).resolves.toContain(SETUP_URI_BASE);
  });
});

describe('hostile and malformed input', () => {
  it('refuses a URI that does not carry the Setup URI prefix', async () => {
    await expect(decodeSetupUri('https://example.com/?settings=x', 'passphrase')).rejects.toMatchObject({
      reason: 'not-a-setup-uri',
    });
    // The QR-only variant is a DIFFERENT, unencrypted transport and must not be
    // mistaken for this one.
    await expect(
      decodeSetupUri('obsidian://setuplivesync?settingsQR=abc', 'passphrase'),
    ).rejects.toMatchObject({ reason: 'not-a-setup-uri' });
  });

  it('refuses an oversized URI before doing any key derivation', async () => {
    const huge = SETUP_URI_BASE + 'A'.repeat(MAX_SETUP_URI_LENGTH);
    const started = Date.now();
    await expect(decodeSetupUri(huge, 'passphrase')).rejects.toMatchObject({ reason: 'too-large' });
    // 310_000 PBKDF2 iterations take far longer than this. Finishing quickly is
    // the observable proof that the cap runs BEFORE the derivation, which is the
    // whole point: otherwise the caller chooses our work factor.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses an unrecognised envelope', async () => {
    await expect(decodeSetupUri(asUri('not-an-envelope'), 'passphrase')).rejects.toMatchObject({
      reason: 'unsupported-format',
    });
  });

  /**
   * V3 is a CHUNK format; nothing in the string-encryption path emits it. Naming
   * it explicitly means a future encounter reports an honest "unsupported
   * format" rather than a decryption failure that reads as a wrong passphrase.
   */
  it('recognises a V3 envelope and refuses it by name', async () => {
    await expect(decodeSetupUri(asUri('%~something'), 'passphrase')).rejects.toMatchObject({
      reason: 'unsupported-format',
    });
  });

  it('refuses a malformed percent-encoding', async () => {
    await expect(decodeSetupUri(`${SETUP_URI_BASE}%zz`, 'passphrase')).rejects.toMatchObject({
      reason: 'malformed-payload',
    });
  });

  it('refuses an empty passphrase rather than deriving a key from one', async () => {
    await expect(decodeSetupUri(asUri(VECTOR_HKDF), '')).rejects.toThrow(SetupUriError);
  });

  it('refuses a truncated HKDF payload without hanging on its own header', async () => {
    await expect(decodeSetupUri(asUri('%$AAAA'), 'passphrase')).rejects.toMatchObject({
      reason: 'malformed-payload',
    });
  });

  it('refuses a payload that decrypts to valid JSON of the wrong shape', async () => {
    for (const notAnObject of ['null', '[1,2,3]', '"a string"', '42']) {
      const uri = SETUP_URI_BASE + encodeURIComponent(await encryptForFixture(notAnObject));
      await expect(decodeSetupUri(uri, LONG_PASSPHRASE)).rejects.toMatchObject({
        reason: 'malformed-payload',
      });
    }
  });

  /**
   * The decoded object is JSON.parse over attacker-controlled plaintext. A
   * literal `__proto__` key must stay an inert own property and never reach a
   * prototype chain.
   */
  it('cannot be used to pollute a prototype', async () => {
    const uri =
      SETUP_URI_BASE +
      encodeURIComponent(
        await encryptForFixture('{"__proto__":{"polluted":true},"couchDB_URI":"https://a.test"}'),
      );
    const { carryOver } = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(carryOver)).toBeNull();
  });

  it('refuses a short URI passphrase on encode', async () => {
    await expect(encodeSetupUri(BLOCK, 'short')).rejects.toMatchObject({
      reason: 'unrepresentable',
    });
    const exactly = 'x'.repeat(MIN_SETUP_URI_PASSPHRASE_LENGTH);
    await expect(encodeSetupUri(BLOCK, exactly)).resolves.toContain(SETUP_URI_BASE);
  });

  it('produces a different ciphertext every time for the same input', async () => {
    const a = await encodeSetupUri(BLOCK, LONG_PASSPHRASE);
    const b = await encodeSetupUri(BLOCK, LONG_PASSPHRASE);
    expect(a).not.toBe(b);
    // ...and both still decode to the same thing.
    expect((await decodeSetupUri(a, LONG_PASSPHRASE)).block).toEqual(
      (await decodeSetupUri(b, LONG_PASSPHRASE)).block,
    );
  });
});

describe('remotes we cannot drive', () => {
  /**
   * We have one backend. A URI describing S3 or P2P decodes and applies fine and
   * would then sync nothing while reporting itself configured, which is exactly
   * the silent failure the project exists to rule out.
   */
  it('names an S3/MinIO remote as unsupported', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE, { remoteType: 'MINIO' });
    const decoded = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(unsupportedRemoteReason(decoded)).toMatch(/only supports CouchDB/);
  });

  it('names a P2P remote as unsupported', async () => {
    const uri = await encodeSetupUri(BLOCK, LONG_PASSPHRASE, { P2P_Enabled: true });
    const decoded = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(unsupportedRemoteReason(decoded)).toMatch(/peer-to-peer/);
  });

  it('rejects a URI with no CouchDB URL at all', async () => {
    const uri = await encodeSetupUri({ ...BLOCK, uri: '' }, LONG_PASSPHRASE);
    const decoded = await decodeSetupUri(uri, LONG_PASSPHRASE);
    expect(unsupportedRemoteReason(decoded)).toMatch(/no CouchDB URL/);
  });

  it('accepts an explicit CouchDB remoteType and a plain one', async () => {
    for (const carry of [{}, { remoteType: 'couchdb' }, { remoteType: 'CouchDB' }]) {
      const decoded = await decodeSetupUri(
        await encodeSetupUri(BLOCK, LONG_PASSPHRASE, carry),
        LONG_PASSPHRASE,
      );
      expect(unsupportedRemoteReason(decoded)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Decrypt a URI we produced and return the RAW payload object.
 *
 * Deliberately not `decodeSetupUri`: the assertions above are about the exact
 * key names on the wire, and checking those through our own projection would be
 * circular. This reads the JSON the receiving plugin would actually see.
 */
async function decryptForInspection(uri: string, passphrase: string): Promise<Record<string, unknown>> {
  const envelope = decodeURIComponent(uri.substring(SETUP_URI_BASE.length));
  const { webcrypto } = await import('node:crypto');
  const body = new Uint8Array(Buffer.from(envelope.substring(2), 'base64'));
  const pbkdf2Salt = body.subarray(0, 32);
  const iv = body.subarray(32, 44);
  const hkdfSalt = body.subarray(44, 76);
  const ciphertext = body.subarray(76);
  const material = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const master = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: pbkdf2Salt, iterations: 310_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const hkdfKey = await webcrypto.subtle.importKey(
    'raw',
    await webcrypto.subtle.exportKey('raw', master),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', salt: hkdfSalt, info: new Uint8Array(), hash: 'SHA-256' },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(plain))) as Record<string, unknown>;
}

/**
 * Encrypt arbitrary text to a `%$` envelope, so the malformed-payload cases can
 * feed the decoder something that decrypts cleanly but is not a settings object.
 */
async function encryptForFixture(plaintext: string): Promise<string> {
  const { webcrypto } = await import('node:crypto');
  const pbkdf2Salt = webcrypto.getRandomValues(new Uint8Array(32));
  const hkdfSalt = webcrypto.getRandomValues(new Uint8Array(32));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(LONG_PASSPHRASE),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const master = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: pbkdf2Salt, iterations: 310_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const hkdfKey = await webcrypto.subtle.importKey(
    'raw',
    await webcrypto.subtle.exportKey('raw', master),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', salt: hkdfSalt, info: new Uint8Array(), hash: 'SHA-256' },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const all = new Uint8Array(32 + 12 + 32 + ct.length);
  all.set(pbkdf2Salt, 0);
  all.set(iv, 32);
  all.set(hkdfSalt, 44);
  all.set(ct, 76);
  return '%$' + Buffer.from(all).toString('base64');
}
