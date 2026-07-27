/**
 * Config shapes, the one payload type the two LiveSync peers exchange, and the
 * logging seam they share.
 *
 * Adapted from the reference bridge's `types.ts`
 * (reference/livesync-bridge/types.ts), narrowed to the topology this project
 * actually needs: exactly ONE storage peer (the WebObsidian vault) paired with
 * exactly ONE CouchDB peer. Four things the bridge carries are deliberately
 * absent, and their absence is the point:
 *
 *  - `group` and the N-peer `Config.peers` array. The bridge fans a change out
 *    to every other peer in the same group. With one pair there is nothing to
 *    fan out to, so `Hub.dispatch()` collapses into a single function call and
 *    the group key would only be dead weight that later invites a second writer
 *    over one vault (KICKOFF section 5.3 rules that out explicitly).
 *  - `processor: { cmd, args }`, the bridge's post-write shell hook. That is a
 *    remote-code-execution surface driven by settings JSON in a web server that
 *    is reachable over HTTP and whose settings are editable through the API. The
 *    bridge is a single-user daemon on a trusted host; WebObsidian is not, so
 *    the hook does not come across.
 *  - `useChokidar`. The bridge chooses between `Deno.watchFs` and chokidar at
 *    runtime, and only its chokidar branch carries the `isChanged()` gate that
 *    stops an unchanged file from being re-pushed. There is no choice to make
 *    here: WebObsidian already owns one chokidar watcher over the vault
 *    (`server/src/index.ts`) and the storage peer is driven from that watcher's
 *    existing fanout instead of starting a second one.
 *
 * Redaction lives here too, next to the config that carries the credentials,
 * because a CouchDB URL is `https://user:password@host` and every log line and
 * every API error in this subsystem has to pass through `redactUrlCreds` before
 * it leaves the process. Making the peer logger the redacting one means a peer
 * cannot leak a password by forgetting to call it.
 */
import type { DirectFileManipulatorOptions } from 'livesync-engine';
import { redactUrlCreds } from '../../lib/redact.js';

/** Which side of the pair a peer is. Mirrors the bridge's `PeerConf.type`. */
export type LiveSyncPeerType = 'storage' | 'couchdb';

/**
 * One file's content plus the metadata LiveSync stores alongside it.
 *
 * `data` is `string[]` for text (the engine stores and returns text as an array
 * of chunks) and `Uint8Array` for everything else. Keeping the union rather than
 * normalising to bytes is not laziness: `isPlainText()` decides which of the
 * engine's two document types a file becomes, and a text file round-tripped
 * through a byte array would lose that distinction and be re-chunked as binary.
 */
export interface FileData {
    ctime: number;
    mtime: number;
    size: number;
    data: string[] | Uint8Array;
    deleted?: boolean;
}

/**
 * Hand a change to the other peer. `false` means "deleted".
 *
 * The contract differs from the bridge's `DispatchFun` in one load-bearing way:
 * the return value and a thrown error mean DIFFERENT things, and callers depend
 * on the difference.
 *
 *  - Resolving `true` means the change was applied on the far side.
 *  - Resolving `false` means it was legitimately skipped (an echo of a write
 *    that peer just made, or content that is already byte-identical there).
 *    Skipped still counts as PROCESSED.
 *  - THROWING means the change was not delivered and the far side is not in a
 *    state where retrying now would help (CouchDB is down, the local write
 *    failed).
 *
 * Both peers use that distinction to decide whether it is safe to advance their
 * "we are caught up to here" markers: the storage peer only records a file's
 * mtime/size baseline after a non-throwing dispatch, and the CouchDB peer only
 * advances its changes-feed checkpoint after a non-throwing one. The bridge's
 * Hub discarded the return value entirely, so a push that failed because CouchDB
 * was unreachable still marked the file as synced and the change was lost until
 * the file happened to be edited again.
 */
export type DispatchFn = (path: string, data: FileData | false) => Promise<boolean>;

/** The filesystem side of the pair: the WebObsidian vault. */
export interface LiveSyncStorageConf {
    /** Label used in logs and in the health report. */
    name: string;
    /**
     * Vault-relative prefix this peer owns, POSIX-style, `''` for the whole
     * vault. Note that changing it invalidates every persisted file-stat
     * baseline (see `LiveSyncStateStore`), because those are recorded per
     * namespace and the namespace embeds this value.
     */
    baseDir: string;
    /**
     * Walk the tree at startup and push anything whose mtime/size differs from
     * the recorded baseline, plus (unlike the bridge) delete anything that
     * disappeared while we were down. Defaults to enabled at the call site.
     */
    scanOfflineChanges?: boolean;
    /**
     * Trailing debounce applied per path before a local change is read and
     * pushed. Defaults to 300ms, matching the `awaitWriteFinish.stabilityThreshold`
     * that `index.ts`'s watcher already applies, so an editor's write-truncate-write
     * sequence collapses into one push.
     */
    debounceMs?: number;
}

/**
 * The CouchDB side of the pair.
 *
 * Extends the engine's own options type so the whole object can be handed to
 * `new DirectFileManipulator(...)` unchanged, exactly as the bridge does.
 */
export interface LiveSyncCouchDBConf extends DirectFileManipulatorOptions {
    /** Label used in logs and in the health report. */
    name: string;
    /** Remote-side path prefix, `''` for the whole database. */
    baseDir: string;
    /**
     * Adopt chunking/encryption settings from the remote's milestone document
     * rather than insisting on the local ones. Recommended: it is how a peer
     * joins an existing cluster without the operator transcribing every tweak.
     */
    useRemoteTweaks?: boolean;
    /**
     * Glob patterns for `i:`-prefixed internal files (`.obsidian/**` and
     * friends) to replicate.
     *
     * MUST be empty here, and `validateCouchDBConf()` rejects a non-empty value
     * as a configuration error. Three independent reasons, any one of which is
     * sufficient:
     *
     *  1. The bridge's implementation is broken in a way that produces divergent
     *     duplicates rather than a visible failure: it strips `baseDir` from the
     *     path BEFORE the `i:` prefix is accounted for (so `i:.obsidian/app.json`
     *     under baseDir `i:` loses the wrong leading characters and the filename
     *     is mangled), and it never re-adds the `i:` prefix on the outbound side,
     *     so a file received as internal is pushed back as an ordinary note at a
     *     mangled path.
     *  2. WebObsidian's vault layer refuses these paths outright. `resolveInVault`
     *     denies every dot-prefixed segment, and `.git`/`.obsidian` are denied in
     *     every mode as PROTECTED_DIRS, because `services/plugins.ts` serves
     *     `.obsidian/plugins/<id>/main.js` to the SPA to execute and
     *     `services/git.ts` runs git against `.git`. Writing an internal file
     *     received from a remote peer is remote code execution in every browser
     *     that opens the vault. Bypassing that guard for remote input would be
     *     the single worst decision available in this subsystem, so we do not.
     *  3. `index.ts`'s watcher ignores `.obsidian` deliberately (desktop Obsidian
     *     rewrites its workspace files constantly and floods the server), so even
     *     if the write were permitted the outbound half could never observe it.
     *     One-directional replication of a directory the operator cannot see is
     *     worse than no replication of it.
     *
     * The field is kept, rather than dropped, so that the rejection is explicit:
     * an operator porting a bridge config gets a clear error instead of silently
     * losing a feature they thought they had configured.
     */
    includeInternal?: string[];
}

// --- Logging -----------------------------------------------------------------

export type LiveSyncLogLevel = 'debug' | 'info' | 'notice' | 'error';

/**
 * Every line either peer emits goes through one of these. The signature takes a
 * pre-rendered string on purpose: an `unknown` payload would eventually be an
 * Error whose message embeds the CouchDB URL, and the redaction below would not
 * see it.
 */
export type LiveSyncLogger = (message: string, level?: LiveSyncLogLevel) => void;

/**
 * Render an unknown thrown value as a string with any URL credentials stripped.
 *
 * Use this on EVERY error before it reaches a log line or an API response.
 * CouchDB URLs carry `user:password`, PouchDB embeds the request URL in its
 * error messages, and `redactUrlCreds` is the same helper `services/git.ts`
 * applies to git errors for the same reason (a PAT baked into a remote URL).
 */
export function describeError(e: unknown): string {
    if (e instanceof Error) {
        // `stack` already contains `message`, and the stack is what makes an
        // engine-internal failure diagnosable at all, so prefer it.
        return redactUrlCreds(e.stack ?? e.message);
    }
    return redactUrlCreds(String(e));
}

/**
 * The default sink: stdout/stderr with a peer tag, credentials stripped.
 *
 * Debug lines are dropped unless LIVESYNC_DEBUG=1. They are per-file and per
 * change, so at vault scale they are a denial of service against the operator's
 * own logs, but they are also the only way to see why a specific file did not
 * move, hence the switch rather than deletion.
 */
export function createPeerLogger(name: string): LiveSyncLogger {
    const debugEnabled = process.env.LIVESYNC_DEBUG === '1';
    return (message: string, level: LiveSyncLogLevel = 'info') => {
        if (level === 'debug' && !debugEnabled) return;
        const line = `[livesync:${name}] ${redactUrlCreds(message)}`;
        if (level === 'error') console.error(line);
        else if (level === 'notice') console.warn(line);
        else console.log(line);
    };
}

// --- Configuration validation ------------------------------------------------

/**
 * Reasons this CouchDB config can never work, as human-readable strings.
 *
 * These are FATAL: the peer refuses to start rather than entering its retry
 * loop, because none of them can be fixed by waiting. A config that retries
 * every 30 seconds forever while the storage side wedges behind an unresolved
 * "connected" promise is exactly the silent-failure mode KICKOFF section 7 calls
 * the most important thing to get right.
 *
 * Returned rather than thrown so a settings route can surface all of them at
 * once, and so the same rules can be applied at save time and at start time.
 * Every message passes through `redactUrlCreds`, since the natural way to write
 * "your URL is malformed" is to quote the URL.
 */
export function validateCouchDBConf(conf: LiveSyncCouchDBConf): string[] {
    const errors: string[] = [];

    if (!conf.url || !conf.url.trim()) {
        errors.push('CouchDB URL is required.');
    } else {
        let parsed: URL | undefined;
        try {
            parsed = new URL(conf.url);
        } catch {
            errors.push(`CouchDB URL is not a valid URL: ${redactUrlCreds(conf.url)}`);
        }
        if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            errors.push(`CouchDB URL must be http or https, got ${parsed.protocol.replace(':', '')}.`);
        }
    }

    if (!conf.database || !conf.database.trim()) {
        errors.push('CouchDB database name is required.');
    }

    /*
     * Obfuscation without encryption is worse than useless, and it looks like it
     * is working, which is why it has to be refused rather than warned about.
     *
     * `obfuscatePassphrase` makes every document id opaque (`f:<hash>`), so a
     * glance at the database shows no readable paths and the setup passes the
     * eyeball test that KICKOFF section 8 asks for. But the engine gates the
     * metadata scrub on `passphrase`: with encryption off, the document BODY
     * still carries `path`, `mtime` and `size` in plaintext. The operator has
     * hidden the ids, published the paths, and paid the cost of unreadable ids
     * (no way to grep the database, no way to hand-repair a document) for
     * nothing at all. Refuse it.
     */
    if (conf.obfuscatePassphrase && !conf.passphrase) {
        errors.push(
            'Path obfuscation requires an end-to-end encryption passphrase. ' +
                'Without one the document ids are opaque but the document bodies still ' +
                'contain the path, mtime and size in plaintext, which is strictly worse ' +
                'than not obfuscating at all.',
        );
    }

    if (conf.includeInternal && conf.includeInternal.length > 0) {
        errors.push(
            'includeInternal is not supported: WebObsidian refuses writes to dot-prefixed ' +
                'paths (.obsidian and .git are executed and read as this server\'s own ' +
                'configuration) and its vault watcher ignores them, so internal files could ' +
                'only ever replicate one way into a directory the operator cannot see.',
        );
    }

    return errors;
}
