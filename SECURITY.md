# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately:

- Use **GitHub Security Advisories** ("Report a vulnerability" on the Security tab), or
- Email the maintainer: **xnohat@gmail.com**

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept if possible).
- Affected version / commit.

You can expect an initial acknowledgement within a few days. We'll work with you on a fix
and coordinate disclosure once a patch is available.

## Scope & hardening notes

WebObsidian is **self-hosted and single-user**. Operators are responsible for deploying it
safely. Key points:

- **Change the default password (`123456`)** immediately after first login.
- Master password is scrypt-hashed; the JWT secret is auto-generated.
- API keys are hashed at rest and scoped (`read` / `write` / `search`) with per-key rate
  limiting.
- File paths are guarded against traversal; the vault picker is confined to `ALLOWED_ROOTS`.
- Secrets (git token, API keys) live in `data/settings.json` on the server: mount `/data`
  as a private volume and keep it out of version control.
- Run behind a TLS-terminating reverse proxy (set `HTTP_BIND=127.0.0.1`) for any
  internet-facing deployment. `TRUST_PROXY` defaults to `true` so `X-Forwarded-Proto`
  is honoured (Secure cookies work) behind that proxy.
- **How rate limiting identifies a client, and what `TRUST_PROXY` does to it.** The
  login, share-unlock and failed-API-key limiters key on a network address, and they
  believe a forwarded one in exactly one case:
  - **`true` (the default), `false`, or any hop count including `1`:** the limiters
    key on the raw TCP socket address. It cannot be forged, so rotating
    `X-Forwarded-For` mints no buckets. A hop count is **not** a shortcut to
    per-client buckets: Express only counts hops for that form and never checks who
    the peer is, so the limiters do not use its answer and it behaves exactly like
    the default here.
  - **A subnet or preset list (`loopback`, `10.1.2.3/32`, ...):** the only form where
    Express tests the *address* of each hop and stops at the first one outside the
    list, so an entry a client wrote itself is discarded. The limiters use the
    resulting address, giving one bucket per client. It is self-validating: a direct
    connection from outside the list truncates back to the socket address, so naming
    the wrong range costs precision, not safety.

  **The cost of the default, stated plainly.** Behind a reverse proxy every visitor
  arrives from the proxy's own address, so all of them share one bucket. "10 login
  attempts per 15 minutes" is an instance-wide budget, and ten failed logins from a
  stranger do keep the owner out for the rest of the window. That is an availability
  cost, not a bypass, and it is bounded: refused attempts are not recorded, so the
  lockout always expires 15 minutes after the tenth accepted attempt however long
  someone keeps hammering.

  **The precondition on the subnet form.** The range must contain your proxies and
  nothing else. If it is broad enough to also cover real clients (a `/12` that
  happens to include the LAN behind the proxy), those clients' own `X-Forwarded-For`
  entries are believed and each can mint a fresh bucket per request, which is the
  bypass this setting exists to prevent. Name the narrowest range you can, a `/32`
  when the proxy has one fixed address. In Docker the peer is the proxy's address on
  the container network, so `loopback` is wrong there; read the real one off
  `docker network inspect`.

  **So: leaving `TRUST_PROXY` at `true` is safe.** On a single-user instance the
  shared bucket is a self-healing annoyance, not a breach. Move to the subnet form
  when you can name your proxy's address exactly. Do not adopt a broad range merely
  to get off the default, because a range containing clients is worse than the
  default. `HTTP_BIND=127.0.0.1` is worth setting either way, on its own merits.
- Have the reverse proxy pass the client's `Host` header through
  (`proxy_set_header Host $host;` in nginx, which is **not** the default), or set
  `PUBLIC_ORIGIN` to the origin(s) users type into the browser. The `/ws` upgrade
  checks the handshake's `Origin` against this deployment's own authority, and when
  the proxy rewrites `Host` to an internal address the server cannot verify that
  comparison: it allows the upgrade with a logged warning and falls back to the
  `SameSite` cookie attribute alone. See the README's reverse-proxy section for a
  full location block.

## Supported versions

This project is pre-1.0; security fixes are applied to the latest `main`. Please run a
recent build.
