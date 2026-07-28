# DRAFT: not filed

> **Status: DRAFT. This has not been submitted to `vrtmrz/livesync-commonlib` or anywhere else.**
>
> A human must review this before it is filed. Two things specifically need a human pass:
>
> 1. **Confirm the defect still exists on current `main`.** This was written offline against the
>    pinned commit `8ed9bcd` only. See "Has this already been fixed?" below.
> 2. **Confirm the tone and the claims.** This is a report from a downstream user whose project is
>    built on this engine. It should read as a contribution, not a complaint.
>
> Intended target: an issue on `vrtmrz/livesync-commonlib`. Everything below the line is the report
> body; the DRAFT header is not part of it.

---

## Summary

`ChunkManager._enqueueWaiting` gives a second waiter for the same chunk id the first waiter's **raw**
promise, without the `withTimeout` wrapper the first waiter got. When the first waiter times out, its
timeout handler deletes the shared `waitingMap` entry, which removes the only route by which that
promise could ever be resolved. The second waiter then waits forever. Because the read is gathered
with `Promise.all`, one such waiter hangs the whole chunk read, and therefore `getDBEntryFromMeta`,
and therefore `DirectFileManipulator.getByMeta`, silently and with no log line at any level.

## Version

- Repository: `vrtmrz/livesync-commonlib`
- Commit: `8ed9bcda25e5a6b6386c662e98050214b4b7b1cb` (`8ed9bcd`)
- File: `src/managers/ChunkManager.ts`
- Found via: a Node port that drives `DirectFileManipulatorV2` outside Obsidian, in the style of
  `livesync-bridge`. The engine source is vendored unmodified at that commit, so the line numbers
  below should match the repository exactly.

## Has this already been fixed?

**Unknown, and this must be checked before the issue is filed.** This analysis was done offline
against a vendored copy of `8ed9bcd` with no access to the repository's current state. If `main` has
since reworked `_enqueueWaiting`, this report is stale and should be discarded rather than filed.
Nothing here should be read as a claim about current `main`.

## Mechanism

### 1. The join path skips the timeout wrapper

`src/managers/ChunkManager.ts`, lines 216 to 233:

```ts
216    _enqueueWaiting(id: DocumentID, timeout: number): Promise<EntryLeaf | false> {
217        const previous = this.waitingMap.get(id);
218        if (previous) {
219            // If already waiting for this ID, do not overwrite
220            return previous.resolver.promise;
221        }
222        const resolver = promiseWithResolver<EntryLeaf | false>();
223        this.waitingMap.set(id, { resolver });
224        // Set timeout and wait for the promise to resolve
225        return withTimeout(resolver.promise, timeout, () => {
226            const current = this.waitingMap.get(id);
227            if (current && current.resolver === resolver) {
228                // If still waiting for this ID, delete it
229                this.waitingMap.delete(id);
230            }
231            return false; // Return false if timed out
232        });
233    }
```

Line 220 returns `previous.resolver.promise` directly. Line 225 returns
`withTimeout(resolver.promise, ...)`. The `timeout` argument is simply discarded on the line 220
path. The first caller for a given id is protected by a timeout; every subsequent caller is not.

### 2. The timeout deletes the entry that the second waiter depends on

Lines 226 to 230 are the deletion. The identity guard (`current.resolver === resolver`) is correct
in itself, and it is there to avoid deleting a newer entry installed by a later read. But in the
common case it matches, and the entry is removed.

That removal is fatal for the joined waiter, because the map entry is the **only** handle anyone
holds on that resolver. Both places that could resolve it look the resolver up by id first:

Lines 235 to 249:

```ts
235    onChunkArrived(doc: EntryLeaf, deleted: boolean = false): void {
236        const id = doc._id;
237        if (this.waitingMap.has(id)) {
238            const queue = this.waitingMap.get(id)!;
239            this.waitingMap.delete(id);
```

Lines 264 to 271:

```ts
264    onMissingChunkRemote(id: DocumentID): void {
265        // Handle the case where the chunk is not found remotely
266        if (this.waitingMap.has(id)) {
267            const queue = this.waitingMap.get(id)!;
268            this.waitingMap.delete(id);
269            queue.resolver.resolve(false); // Return false if the chunk is not found
270        }
271    }
```

After line 229 has run, `this.waitingMap.has(id)` is false, so neither handler can reach the
resolver. If the chunk arrives afterwards, `onChunkArrived` falls into the else branch and logs
nothing (line 247 is a commented-out `Logger` call). Nothing else in the file holds a reference to
that resolver.

This is worth stating precisely, because it is the part that makes the bug permanent rather than
merely slow: after the deletion, the second waiter's promise is not late, it is **unreachable**. It
cannot resolve and it cannot reject, at any duration, for the lifetime of the process.

`destroy()` does not help either, lines 293 to 298:

```ts
293    destroy(): void {
294        this.abort.abort(); // Abort any ongoing requests
295        this.changeHandler(); // Remove change handler
296        this.caches.clear(); // Clear cache
297        this.waitingMap.clear(); // Clear pending queue
298    }
```

`clear()` drops the entries without resolving them, so tearing the manager down does not release an
already-hung awaiter either.

### 3. One hung waiter hangs the whole read

Lines 359 to 383, `_waitForArrival`:

```ts
367            const tasks = [...readIds].map((id) => {
368                // Add to the pending map
369                return this._enqueueWaiting(id, timeout);
370            });
...
374            const results = await Promise.all(tasks);
```

`Promise.all` never settles if any member never settles, so a single joined-and-orphaned chunk id
stalls the entire `read()` call, not just that one chunk.

### 4. A second, milder asymmetry in the same lines

Independently of the hang: on the line 220 path the caller's own `timeout` argument is ignored
entirely. `EntryManager.getDBEntryFromMeta` picks between three different values at
`src/managers/EntryManager/EntryManager.ts` lines 259 to 265:

```ts
259                const timeout = waitForReady
260                    ? isChunksCorrectedIncrementally
261                        ? LEAF_WAIT_TIMEOUT
262                        : LEAF_WAIT_TIMEOUT_SEQUENTIAL_REPLICATOR
263                    : isNetworkEnabled
264                      ? LEAF_WAIT_ONLY_REMOTE
265                      : 0;
```

`LEAF_WAIT_TIMEOUT` is 30000 and `LEAF_WAIT_ONLY_REMOTE` is 5000 (`src/common/types.ts` lines 39 to
41). So a read that asked for a 5 second bound can inherit a 30 second one purely because another
read got to the same chunk id first. This is much less serious than the hang, but it has the same
cause and the same fix, so it is mentioned here rather than filed separately.

## Blast radius, stated honestly

**This is not reachable in a healthy, fully replicated database.** `_enqueueWaiting` is only reached
after the chunk has missed the cache and missed the local database (`read` at lines 415 to 426,
`readSingle` at lines 300 to 335). If every chunk is present locally, none of this executes. A
maintainer will work that out immediately, so it should be said up front: this needs a chunk that is
absent at read time.

That said, "absent at read time" is a **designed** state, not only a corrupted one. With on-demand
chunk fetching enabled, metadata legitimately arrives ahead of its leaves and the wait path is the
normal mechanism for closing that gap. So the wait path itself is routine. What is not routine is two
waiters on the same id.

Reaching the hang needs all four of these together:

1. **A chunk missing locally at read time.** Routine with on-demand chunks; otherwise it means a
   degraded or partially replicated database.
2. **Two overlapping reads that both want that same chunk id.** Within a single `read()` call the ids
   are de-duplicated by the `Set` at line 408, so this requires two concurrent `read()` calls. Two
   documents sharing a chunk is not exotic under content-addressed chunking: identical frontmatter,
   repeated boilerplate, near-empty files, and copied notes all produce shared leaves. In
   `DirectFileManipulatorV2.beginWatch` the `change` listener is `async` and the PouchDB changes
   emitter does not await it, so concurrent in-flight `getByMeta` calls are the normal case whenever
   more than one document arrives in a burst.
3. **The shared wait failing to resolve.** Two paths where nothing ever resolves it:
   - `preventRemoteRequest: true`, which `EntryManager` sets from `!isNetworkEnabled` (line 273), so
     on-demand chunks disabled or `REMOTE_MINIO`. No event is emitted at all, so timeout is the only
     possible outcome by construction.
   - `ChunkFetcher.requestMissingChunks` failing before it can report. At
     `src/managers/ChunkFetcher.ts` line 94, `const chunks = await replicator.fetchRemoteChunks(requestIDs, false);`
     sits inside a `try { ... } finally { ... }` (lines 79 and 133) with **no `catch`**. If
     `fetchRemoteChunks` rejects, for example on a transient network failure, the rejection
     propagates out and `EVENT_MISSING_CHUNK_REMOTE` is never emitted for those ids. The early return
     at lines 89 to 92 when there is no active replicator does the same. In both cases the waiters
     are left to time out.
4. **The first waiter's timeout firing.** Which then deletes the entry and strands the second.

So: **the priority is genuinely lower than "any sync can hang"**. It needs a missing chunk plus a
fetch that does not report back. What raises it above its raw frequency is the failure mode. The
first waiter behaves correctly and gets `false`; the second produces no error, no rejection, no
event, and no log line at any level including `LOG_LEVEL_VERBOSE`. It is a permanent, silent,
per-document stall in a process that otherwise looks completely healthy.

### Public entry points that reach it

- `ChunkManager.read` (line 399) and `ChunkManager.readSingle` (line 300).
- `read` is reached from `EntryManager.getDBEntryFromMeta` (line 268), and therefore from
  `LiveSyncLocalDB.getDBEntryFromMeta` (line 481) and `getDBEntry`.
- Which is reached from `DirectFileManipulatorV2.getByMeta` (line 311), and therefore from `get`,
  `getById`, `_enumerate` / `enumerateAllNormalDocs`, `beginWatch` (line 459) and `followUpdates`
  (line 526).
- `readSingle` appears to have no internal caller at this commit; it is reachable as public API.
- `write` calls `read` at line 499 but passes `timeout: 0`, so it does not enqueue and is not
  affected.

## Observable symptom

In `src/API/DirectFileManipulatorV2.ts`, `beginWatch`'s change listener, lines 458 to 461:

```ts
458                Logger(`WATCH: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
459                const docX = await this.getByMeta(doc);
460                try {
461                    await callback(docX, change.seq);
```

Line 459 never returns. What the operator sees:

- `WATCH: PROCESSING: <path>` is logged, and `WATCH: PROCESS DONE` never follows.
- No exception, no `error` event on the changes feed, and therefore no reconnect.
- `this.watching` stays `true`, so any health check built on it reports healthy.
- Other documents continue to flow normally, because the emitter does not await the listener. Only
  the affected document is lost.
- Because `callback` is never invoked for that document, the host never sees that `change.seq`. A
  host that advances its replication checkpoint from later documents will move past it, so the
  document is not retried on restart either. The file is simply absent until a full rescan.

### One correction to how this is often described

It is tempting to blame line 459 sitting **above** the `try` on line 460. That is a real and separate
robustness issue, and it is worth fixing: `getByMeta` throws readily (`Corrupted document` at line
313, and every `return false` inside `EntryManager` funnels into it), and those throws currently
become unhandled rejections instead of being logged like a failed `callback` is.

But it is **not** the cause of this hang, and saying so would be wrong. A `try`/`catch` does not
catch a promise that never settles. Moving line 459 inside the `try` would change nothing about this
defect. The two failure modes look identical from the outside (a listener that never completes) but
they are different bugs, and only one of them is in `ChunkManager`.

## Minimal reproduction

**Constructed from reading the source. Not executed.** It is included because it isolates the claim,
not as evidence that it was observed running. It should be run before or during triage.

```ts
import { ChunkManager } from "./src/managers/ChunkManager.ts";

const missingId = "h:missing-chunk" as DocumentID;

// A database in which the chunk is simply absent: get() 404s and allDocs() reports it missing.
const database = {
    get: () => Promise.reject({ status: 404, error: "not_found" }),
    allDocs: ({ keys }: { keys: string[] }) =>
        Promise.resolve({ rows: keys.map((key) => ({ key, error: "not_found" })) }),
} as unknown as PouchDB.Database<EntryDoc>;

// A change manager that never delivers anything, so the chunk never arrives.
const changeManager = { addCallback: () => () => {} } as unknown as ChangeManager<EntryDoc>;

const cm = new ChunkManager({ database, changeManager });

// preventRemoteRequest keeps ChunkFetcher out of it, so timeout is the only outcome by design.
const opts = { skipCache: true, timeout: 1000, preventRemoteRequest: true };

const first = cm.read([missingId], opts);
const second = cm.read([missingId], opts);

console.log("first:", await first);   // [ false ] after roughly 1000ms. Correct behaviour.
console.log("second:", await second); // never prints. Process stays alive with an idle event loop.
```

Both calls traverse the same await points in the same order, so `first` reaches `_enqueueWaiting`
before `second` does, which is what puts `second` on the line 220 join path.

The same thing in two lines, if reaching into the private method during triage is acceptable:

```ts
const a = cm._enqueueWaiting(id, 1000); // resolves false at 1000ms, and deletes the map entry
const b = cm._enqueueWaiting(id, 1000); // returns a.resolver.promise raw; never settles
```

## Suggested fix

Give **every** waiter its own timeout wrapper over the shared promise, and retire the map entry only
when the last waiter has given up. This keeps the existing de-duplication (still one entry, still one
outstanding remote request per id) and keeps the existing identity guard's intent.

```ts
waitingMap = new Map<
    DocumentID,
    {
        resolver: PromiseWithResolvers<EntryLeaf | false>;
        waiters: number; // How many callers are currently bound to this resolver.
    }
>();

_enqueueWaiting(id: DocumentID, timeout: number): Promise<EntryLeaf | false> {
    let entry = this.waitingMap.get(id);
    if (!entry) {
        entry = { resolver: promiseWithResolver<EntryLeaf | false>(), waiters: 0 };
        this.waitingMap.set(id, entry);
    }
    const current = entry;
    current.waiters++;
    // Every waiter, including a late joiner, gets its own timeout over the SHARED
    // promise. Handing a joiner the raw promise leaves it with no route to
    // resolution at all once the first waiter's timeout retires the map entry,
    // because onChunkArrived and onMissingChunkRemote both look the resolver up
    // by id and can no longer find it.
    return withTimeout(current.resolver.promise, timeout, () => {
        current.waiters--;
        // Retire the entry only when the last waiter has given up, and only if it
        // is still this entry: a newer read may already have installed a fresh one.
        // This is the same protection the previous `current.resolver === resolver`
        // check provided.
        if (this.waitingMap.get(id) === current && current.waiters <= 0) {
            this.waitingMap.delete(id);
        }
        return false;
    });
}
```

With this, each waiter is bounded by the timeout it actually asked for, the chunk arriving still
resolves everyone at once through the shared resolver, and no promise is ever left orphaned.

### Two optional hardening changes, offered separately

Neither is required once the above is in place. Each independently shortens the failure, so they may
be worth taking anyway. They are listed apart from the fix so they can be declined without affecting
it.

1. **`ChunkManager.destroy()` (lines 293 to 298)** could resolve each outstanding resolver with
   `false` before clearing the map, so teardown releases any awaiter that is still bound. As written,
   `clear()` alone leaves them pending.
2. **`ChunkFetcher.requestMissingChunks` (line 94)** could wrap `fetchRemoteChunks` in a `catch` that
   emits `EVENT_MISSING_CHUNK_REMOTE` for the batch, matching what the two existing failure branches
   at lines 122 to 124 and 128 to 130 already do. Today a rejection there skips the notification
   entirely, so waiters can only fall back on the timeout. The unhandled rejection this produces is
   also invisible without a process-level handler, since the call site is
   `setTimeout(() => void this.requestMissingChunks(), 1)`.

## What has NOT been verified

Listed so nobody has to guess which parts are read from source and which parts were observed.

- **Not checked against current `main`.** This was written offline against `8ed9bcd`. If the code has
  changed, this report does not apply.
- **The reproduction above was not executed.** It was constructed by reading the source.
- **The exact interleaving was not caught in a debugger.** That two concurrent `read()` calls landed
  on the same chunk id is inferred from the async structure plus the observed symptom, not captured
  directly. The observation that led here was a `beginWatch` listener that never completed, with no
  throw and no log line at `LOG_LEVEL_VERBOSE`. The other two known ways for that listener to stop
  both produce a throw, which is what pointed at this path rather than at those. That is inference,
  not proof.
- **Frequency in the plugin's own usage is unknown.** This was found on the `DirectFileManipulator`
  path in a Node host. Whether the Obsidian plugin's local PouchDB usage hits the same interleaving
  at any meaningful rate has not been measured.
- **The `REMOTE_MINIO` and on-demand-chunks-disabled branches were read, not run.**
- **No claim that this is the only cause of the symptom.** It is one confirmed mechanism, and the
  symptom is generic enough that others may exist.

## A note of thanks

This was found while building a Node backend on top of `livesync-commonlib` for a self-hosted web
Obsidian client, driving `DirectFileManipulatorV2` in the style of `livesync-bridge`. The whole sync
capability of that project is your engine; nothing about it would exist otherwise, and the fact that
the engine turned out to be almost entirely runtime-agnostic is what made the port tractable at all.

The extensive `WHY` comments in `livesync-bridge`, particularly around startup ordering, echo
suppression, and the three-valued health model, saved a great deal of rediscovery and are the reason
this defect was narrowed down rather than written off as a transient. This report is offered in that
spirit. Please correct anything above that is wrong; the analysis is from a reader of the code, not
someone who knows its history.

---

## Repo-local note: outstanding upstream attribution gaps

Not part of the report. Recorded here because crediting this project properly and reporting bugs to
it are the same relationship, and it would be poor form to file the report while the credit is still
missing.

`docs/LIVESYNC_PARITY.md` section 6 and its "Appendix: upstream attribution audit" identified five
gaps. All five were re-checked against the working tree on the date this draft was written, and
**all five are still outstanding.** None of the section 6 fixes have been applied.

1. **`README.md` has no credit.** Zero matches for `vrtmrz`, `livesync-commonlib`, or
   `obsidian-livesync`. Ranked the most visible gap by the audit, and it still is.
2. **No `NOTICE` file.** The file does not exist. The only upstream copyright notice in the tree is
   at `server/vendor/livesync-engine/LICENSE`, which a distributor has to go looking for.
3. **`CHANGELOG.md` does not record the LiveSync backend** or the addition of vendored third-party
   code. Zero matches.
4. **`CONTRIBUTING.md` does not mention** that contributors are working on top of upstream licensed
   code, or that `server/vendor/livesync-engine/upstream/` must not be edited in place. Zero matches.
5. **The `Settings.tsx` LiveSync panel names "Self-hosted LiveSync" but does not link or credit
   vrtmrz.** No `vrtmrz` or "Powered by" string in the file. Conventional rather than legally
   required, but this feature exists entirely because of upstream work.

Also still zero-match, and flagged by the audit as secondary: `PRD.md`, `SECURITY.md`, and the
`Dockerfile` one-line distribution note.

MIT compliance for the vendored code itself is satisfied today by
`server/vendor/livesync-engine/LICENSE` plus the banner in `bundle/engine.js`. The gaps above are a
distribution-convenience gap and a courtesy gap, not a licence violation. That does not make them
fine to leave in place before filing an issue against the same project.

**Suggested ordering: apply at least gaps 1 and 2 before this report is submitted.**
