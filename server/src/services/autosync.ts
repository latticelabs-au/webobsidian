import { getSettings } from './settings.js';
import { sync } from './git.js';
import { disconnect as liveSyncDisconnect, isRunning as liveSyncIsRunning, sync as liveSync } from './livesync.js';
import { redactUrlCreds } from '../lib/redact.js';

/**
 * Periodic auto-sync when enabled in settings (PRD FR-4).
 *
 * Two schedulers, one per backend, because the two have genuinely different
 * timing needs and sharing a timer would compromise both.
 *
 * The git side is untouched: a 30-second tick whose effective interval is
 * clamped by `Math.max(git.intervalSec, 60)`. The only change on that path is
 * the one-line backend gate in `tick()`, which is KICKOFF acceptance criterion 7
 * ("git behaviour is unchanged when sync.backend != 'livesync'") read literally.
 *
 * The LiveSync side gets its own self-scheduling timer instead of riding the
 * 30-second tick, because `livesync.intervalSec` is validated down to 1 second
 * and a 30-second tick can only ever honour multiples of 30. Self-scheduling
 * (setTimeout that re-arms after the work finishes) rather than setInterval, for
 * the reason the reference bridge's heartbeat gives: a pass that runs longer
 * than the interval must not overlap the next one.
 *
 * The two are mutually exclusive at runtime, enforced here as well as in the
 * settings schema, because two writers over one vault with different conflict
 * models is the one failure this project cannot repair after the fact.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

/** Let the server finish booting before the first LiveSync pass connects out. */
const LIVESYNC_FIRST_DELAY_MS = 3_000;
/** How often to re-check settings while LiveSync is not the selected backend. */
const LIVESYNC_IDLE_DELAY_MS = 30_000;

let liveTimer: NodeJS.Timeout | null = null;
let liveRunning = false;

export function startAutoSync(): void {
  if (timer) clearInterval(timer);
  // Re-evaluate settings each tick so toggling takes effect without restart.
  timer = setInterval(tick, 30_000);
  scheduleLiveSyncTick(LIVESYNC_FIRST_DELAY_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  const s = await getSettings();
  /*
   * The backend gate, and the only change to the git path.
   *
   * `sync.backend` is authoritative: the legacy `git.enabled` / `git.autoSync`
   * flags keep their exact meaning, and are deliberately NOT rewritten when an
   * operator selects LiveSync (silently clearing someone's git configuration on
   * a backend switch would be a surprise that does not survive switching back).
   * So the flags can perfectly well still say "yes" while LiveSync owns the
   * vault, and this line is what stops git from committing and pushing
   * underneath it. Every other value of `sync.backend`, including 'none', leaves
   * the behaviour below byte-for-byte as it was.
   */
  if (s.sync.backend === 'livesync') return;
  if (!s.git.enabled || !s.git.autoSync || !s.git.remote) return;
  const intervalMs = Math.max(s.git.intervalSec, 60) * 1000;
  const last = lastRun ?? 0;
  if (Date.now() - last < intervalMs) return;
  running = true;
  try {
    const res = await sync();
    lastRun = Date.now();
    if (res.ok) console.log('[autosync] ok:', res.log.join(' | '));
    else console.warn('[autosync] not-ok:', res.log.join(' | '));
  } catch (e: any) {
    console.warn('[autosync] failed:', e.message);
  } finally {
    running = false;
  }
}

let lastRun: number | null = null;

/** Arm the next LiveSync pass. Never more than one timer outstanding. */
function scheduleLiveSyncTick(delayMs: number): void {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveTimer = null;
    void liveSyncTick();
  }, delayMs);
  // A pending sync tick must never be the reason the process stays alive: the
  // LiveSync engine already leaves handles behind that stop the loop draining
  // on its own (see services/livesync.ts's shutdown path), so this one at least
  // does not add to the problem.
  liveTimer.unref?.();
}

async function liveSyncTick(): Promise<void> {
  let delayMs = LIVESYNC_IDLE_DELAY_MS;
  try {
    const s = await getSettings();
    if (s.sync.backend !== 'livesync') {
      /*
       * Not our vault right now. If a pair is still up from a previous
       * selection, take it down here rather than leaving it replicating: an
       * operator who switches to git (or to 'none') has said that this vault has
       * a different writer now, and a LiveSync peer that kept its changes feed
       * attached would keep applying remote writes underneath it.
       */
      if (liveSyncIsRunning()) await liveSyncDisconnect();
      return;
    }
    // Honour the configured interval exactly; the schema already floors it at 1.
    delayMs = Math.max(1, s.livesync.intervalSec) * 1000;
    // Belt to the self-scheduling braces: startAutoSync() being called twice
    // would otherwise let a second tick overlap a pass that is still running.
    // The service's own lock would serialise them anyway, but queueing passes
    // behind each other is not the same thing as skipping a redundant one.
    if (liveRunning) return;
    liveRunning = true;
    try {
      // `periodic`: in live mode the vault watcher has already pushed every
      // change, so this pass may relax its full reconciliation walk to a safety
      // net rather than doing one `stat` per vault file every intervalSec. A
      // manual sync from a route passes nothing and always reconciles.
      const res = await liveSync({ periodic: true });
      if (res.ok) console.log('[autosync] livesync ok:', res.log.join(' | '));
      else console.warn('[autosync] livesync not-ok:', res.log.join(' | '));
    } finally {
      liveRunning = false;
    }
  } catch (e: unknown) {
    // Redacted: a CouchDB URL carries user:password, and an error escaping the
    // service unrendered is exactly how a credential reaches a log file.
    const message = e instanceof Error ? e.message : String(e);
    console.warn('[autosync] livesync failed:', redactUrlCreds(message));
  } finally {
    // Always re-arm, including after a failure: a backend that stops ticking
    // because one pass threw is the silent failure this whole subsystem exists
    // to avoid.
    scheduleLiveSyncTick(delayMs);
  }
}
