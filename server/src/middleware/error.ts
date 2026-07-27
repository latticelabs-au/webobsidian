import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { redactUrlCreds } from '../lib/redact.js';

/** Wrap async route handlers so rejections hit the error middleware. */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/**
 * The subset of an error this middleware reads. Errors arrive here as `unknown`
 * (anything can be thrown), so every field is probed defensively rather than
 * assumed.
 *
 * `code`, `errno` and `syscall` are read for classification only, never
 * returned: they are the machine-readable stamp Node puts on a system-call or
 * internal failure, and their presence is the strongest available signal that
 * the accompanying message was written for whoever has the source open rather
 * than for the caller. See `isOperationalError()`.
 *
 * `expose` is honoured in ONE direction only: `expose === false` suppresses the
 * message. The previous revision honoured `expose === true` as the opt-in for a
 * 5xx whose text is meant for the user, which turned out to be the wrong
 * contract twice over. Nothing in this tree ever set it, so every user-meaningful
 * 5xx (git "No remote configured", vault "Invalid trash folder", every push/pull
 * failure) silently became "Internal Server Error" for the client: a regression
 * that was worse than the disclosure it was closing. And in the other direction
 * the flag is set by third-party libraries with their own meaning, so trusting
 * it as an exposure grant means trusting arbitrary throwables to opt themselves
 * into disclosure. Classification (below) decides exposure now; `expose: false`
 * survives as a deliberate hard veto for an error whose message must never leave
 * the process regardless of how it looks.
 */
interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  stack?: unknown;
  expose?: unknown;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
}

/** Read a usable HTTP status out of an unknown throwable, defaulting to 500. */
function readStatus(e: ErrorLike): number {
  // `statusCode` is also probed because body-parser / http-errors style errors
  // (e.g. a 413 from express.json's 32mb limit) set both, and older ones only set
  // one. Anything outside the HTTP range is treated as absent rather than
  // trusted, so a thrown object carrying `status: 0` or `status: 99999` cannot
  // make res.status() throw and turn a handled error into a crashed response.
  for (const candidate of [e.status, e.statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
      return candidate;
    }
  }
  return 500;
}

/**
 * Absolute filesystem paths, in the forms a Node error can carry them.
 *
 * Three alternatives, in order: a Windows drive path (`C:\Users\...`), a UNC
 * path (`\\server\share\...`), and a POSIX absolute path (`/home/...`).
 *
 * Both of the lookbehinds exist to keep this off URLs, which git errors quote
 * and which are among the most useful messages we surface; mangling them would
 * trade one usability bug for another.
 *
 *  - The drive-letter branch rejects a letter preceded by a word character,
 *    because otherwise the `s:` of `https://github.com/u/r.git` reads as a drive
 *    letter and the whole URL is eaten. This is not hypothetical: it was the
 *    first thing that broke when this was tested against real git output.
 *  - The POSIX branch rejects a slash preceded by a word character, `:` or `/`,
 *    so that in `https://github.com/u/r.git` the slash after `https:` is
 *    preceded by `:`, the second by `/`, and the one before `u` by `m`, and none
 *    of them starts a match. Relative paths (`notes/a.md`) are untouched by the
 *    same rule: the leading slash is what makes a path a disclosure of server
 *    layout.
 *
 * `)` and `]` terminate a match so that a path quoted inside brackets, which is
 * how Node formats `ERR_FS_CP_EINVAL`, does not swallow the closing delimiter
 * and leave unbalanced punctuation in the message.
 *
 * A Windows path containing spaces is truncated at the first space rather than
 * matched whole. That is deliberate: the drive letter and the user directory,
 * which is the part that discloses the OS account name, always sit before any
 * space, so the leaked remainder is a bare directory name with no context.
 */
const ABSOLUTE_PATH_RE = /(?<!\w)[A-Za-z]:[\\/][^\s'"<>|?*)\]\r\n]*|\\\\[^\s'"<>|?*)\]\r\n]+|(?<![\w:/])\/(?:[^\s'"<>|?*)\]\r\n/]+\/?)+/g;

/**
 * Cap on the message we hand back. simple-git in particular echoes whole
 * multi-line command transcripts, and an error body is not a place to stream an
 * unbounded amount of anything.
 */
const MAX_CLIENT_MESSAGE = 2000;

/**
 * Everything that leaves the process towards a client goes through here.
 *
 * This runs on 4xx as well as 5xx, which closes a disclosure path the previous
 * revision left open: it reasoned that "4xx are deliberate, every one of them is
 * raised by our own code", which stopped being true the moment `readStatus`
 * started honouring `statusCode`. Third-party errors carry a 4xx status AND the
 * original filesystem message, and the live case is `res.sendFile` in
 * `index.ts`: a missing SPA build makes `send` throw a 404 whose message is
 * `ENOENT: no such file or directory, stat '<abs path to server/public>'`.
 * Stripping absolute paths regardless of status means the class is closed once,
 * at the boundary, rather than per status band.
 */
function sanitiseForClient(message: string): string {
  const redacted = redactUrlCreds(message).replace(ABSOLUTE_PATH_RE, '<path>');
  return redacted.length > MAX_CLIENT_MESSAGE ? `${redacted.slice(0, MAX_CLIENT_MESSAGE)}...` : redacted;
}

/**
 * Is this an OPERATIONAL failure (something went wrong out in the world and the
 * message describes it in terms the caller can act on), or a raw runtime error
 * (a programmer mistake, or a system call that failed, whose message is written
 * for a developer and embeds server internals)?
 *
 * This is the distinction the previous revision tried to draw with an `expose`
 * flag and could not, because the flag was never set. The classification below
 * needs no cooperation from the throw site, which is what makes it work for the
 * errors that actually exist: `throw new Error('No remote configured')` in
 * services/git.ts, a simple-git `GitError` carrying "remote rejected" or
 * "authentication failed", and `Object.assign(new Error('Invalid trash folder'),
 * { status: 500 })` in services/vault.ts all classify as operational and reach
 * the user again, while the two confirmed disclosure cases stay suppressed:
 * ERR_FS_CP_EINVAL from POST /api/files/copy and EISDIR from GET /api/v1/notes/
 * both carry Node's system-error stamp.
 *
 * The screen is a list of disqualifiers rather than an allowlist, and it is
 * ordered so that no positive signal can override a disqualifier. That closes
 * the hole a plain `expose === true` opt-in would leave, where a third-party
 * error could grant itself disclosure.
 */
function isOperationalError(err: unknown, e: ErrorLike): boolean {
  // A non-Error throwable (a string, a plain object, a rejected promise with a
  // number) has no message contract at all. `String(err)` on one of those is
  // developer text at best and '[object Object]' at worst.
  if (!(err instanceof Error)) return false;
  // An explicit veto from the throw site always wins. http-errors sets
  // `expose = status < 500`, so honouring `false` also keeps every http-errors
  // 5xx opaque, which is the direction to err in.
  if (e.expose === false) return false;
  // The built-in error subclasses are, by construction, bugs in our code rather
  // than conditions in the world. Their messages quote identifiers and internal
  // shapes ("Cannot read properties of undefined (reading 'vaultPath')") and
  // tell a caller nothing they can act on.
  if (
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof SyntaxError ||
    err instanceof ReferenceError ||
    err instanceof EvalError ||
    err instanceof URIError
  ) {
    return false;
  }
  // Node stamps every failed system call with errno/syscall and every internal
  // failure with an ERR_-prefixed code. These are the errors whose messages
  // embed absolute paths, addresses and ports. sanitiseForClient() would strip
  // the paths, but the remaining text is still a developer diagnostic and a
  // filesystem oracle by omission, so they are suppressed outright.
  if (typeof e.errno === 'number' || typeof e.syscall === 'string') return false;
  if (typeof e.code === 'string' && /^(?:ERR_[A-Z0-9_]+|E[A-Z]{2,})$/.test(e.code)) return false;
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e: ErrorLike = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  const status = readStatus(e);
  // Redact any URL-embedded credentials (e.g. a Git PAT baked into an
  // authenticated remote URL) before this message hits the client OR the logs.
  const detail = redactUrlCreds(typeof e.message === 'string' && e.message ? e.message : 'Internal Server Error');
  const stack = typeof e.stack === 'string' ? `\n${redactUrlCreds(e.stack)}` : '';

  // An error raised after the response has already begun (a throw inside a
  // stream pipeline, a second call to next(err)) cannot be turned into a JSON
  // body: res.status() would throw ERR_HTTP_HEADERS_SENT out of the error
  // handler itself, which lands in the process-wide uncaughtException handler in
  // index.ts. That handler logs and returns, so the socket is never closed and
  // the client waits on a half-written response until it times out. Destroy the
  // socket instead, which is what Express's own finalhandler does: a truncated
  // response is an honest signal that something failed mid-flight.
  if (res.headersSent) {
    console.error('[error] raised after the response had started', detail, stack);
    res.destroy();
    return;
  }

  if (status < 500) {
    // 4xx are the caller's problem to fix, so the message is returned. It is
    // still sanitised: see sanitiseForClient() for the third-party 4xx that made
    // "our own code wrote this" untrue.
    res.status(status).json({ error: sanitiseForClient(detail) });
    return;
  }

  // Every 5xx is logged, whether or not its message is surfaced. The previous
  // revision returned from the expose branch before reaching the log, so the one
  // class of 5xx someone had deliberately marked as important was the one class
  // that never appeared in the server log. The correlation id goes to both
  // places so an operator can tie a user's screenshot to a log line.
  const errorId = randomBytes(6).toString('hex');
  console.error(`[error] ${errorId}`, detail, stack);

  if (isOperationalError(err, e)) {
    res.status(status).json({ error: sanitiseForClient(detail), errorId });
    return;
  }

  // Raw runtime error: the client gets a fixed string plus the correlation id,
  // which keeps the failure diagnosable ("give me the id from the error you
  // saw") without turning the API into a filesystem oracle for any authenticated
  // client, or on the public share routes for anyone at all.
  res.status(status).json({ error: 'Internal Server Error', errorId });
}
