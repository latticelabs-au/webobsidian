import { useEffect, useState } from 'react';
import { api, consumeSsoError, ssoErrorMessage, SSO_LOGIN_PATH } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';

/**
 * Unlock screen. There is deliberately no "first run / set a master password"
 * mode here any more.
 *
 * It used to branch on `api.authStatus().passwordSet` and, when that was false,
 * POST to /auth/setup: an unauthenticated endpoint that set the owner password
 * and returned a session. The server side of that has been removed (see
 * server/src/routes/auth.ts), so the branch was not just dead, it was the client
 * half of an account-takeover primitive waiting to be re-enabled. A fresh
 * install already has a working password (the default), logs in with it, and is
 * then forced through ForceChangePassword, so nothing is lost by dropping it.
 *
 * It DOES still call /auth/status, for the one bit that route now carries:
 * whether single sign-on is available (FR-15). That has to be asked before
 * anyone has authenticated, which is why the endpoint is unauthenticated and why
 * it answers a bare boolean and nothing about which provider or who it would let
 * in.
 */
export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const setMustChangePassword = useStore((s) => s.setMustChangePassword);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  /**
   * The reason the LAST SSO attempt failed, if this page load is the landing
   * spot of one.
   *
   * `consumeSsoError()` reads `?sso_error=<code>` off the URL and strips it, so
   * a reload does not resurrect a stale failure. It is memoised in lib/api.ts,
   * which is what makes it safe to call from a render body under StrictMode's
   * double invocation, and it hands back a CODE from a closed set; only
   * `ssoErrorMessage` ever turns that into text, so a value someone typed into
   * their own address bar can never be reflected onto the page.
   */
  const [ssoErr, setSsoErr] = useState(() => {
    const code = consumeSsoError();
    return code ? ssoErrorMessage(code) : '';
  });

  useEffect(() => {
    let alive = true;
    api
      .authStatus()
      .then((r) => {
        if (alive) setSsoEnabled(Boolean(r.ssoEnabled));
      })
      // A failed status call means no SSO button. Failing closed is right: the
      // button is useless if the server cannot answer at all, and the password
      // form below still works, so this must not surface as an error the user
      // cannot act on.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    // The previous SSO failure is about an attempt the user has now abandoned in
    // favour of the password form. Leaving it on screen next to a fresh password
    // error would show two contradictory reasons for one blank login box.
    setSsoErr('');
    setBusy(true);
    try {
      const r = await api.login(password);
      setMustChangePassword(Boolean(r.mustChangePassword));
      onAuthed();
    } catch (e: any) {
      setErr(e.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Start the OIDC flow.
   *
   * `location.assign` and nothing else. Not `api.*`: its fetch wrapper throws on
   * any non-2xx and would follow the 302 internally, so the IdP's login page
   * would arrive as an XHR body the user never sees. Not a form posting to the
   * IdP either: the CSP in server/src/index.ts sets `formAction: 'self'` and
   * `connectSrc: 'self'`, so both browser-side routes to a third-party origin
   * are refused. CSP governs neither a top-level navigation nor the server's
   * 302, which is exactly why the endpoint being navigated to is ours.
   *
   * There is no `busy` state and no optimistic UI here, deliberately: the next
   * thing that happens is the document being replaced, so anything rendered
   * after this call is either never painted or is the ghost of a navigation that
   * failed, which would leave a permanently disabled button behind.
   */
  const signInWithSso = () => {
    window.location.assign(SSO_LOGIN_PATH);
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          <Icon name="gem" size={40} />
        </div>
        <h1>WebObsidian</h1>
        <p>Enter your password to unlock</p>
        <div className="err">{err || ssoErr}</div>
        <input
          className="text-input"
          type="password"
          placeholder="Password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn" type="submit" disabled={busy}>
          Unlock
        </button>
        {ssoEnabled && (
          <>
            <div
              style={{
                color: 'var(--text-faint)',
                fontSize: 12,
                textAlign: 'center',
                margin: '12px 0 10px',
              }}
            >
              or
            </div>
            {/*
              type="button" is not cosmetic. This button lives inside the
              password form (the card IS the form, and that is where the styling
              hangs), and a button in a form defaults to type="submit": without
              it, pressing this would run the password login with an empty box,
              spend a rate-limit attempt on a guaranteed 401, and only then
              navigate.
            */}
            <button className="btn secondary" type="button" onClick={signInWithSso}>
              Sign in with SSO
            </button>
          </>
        )}
      </form>
    </div>
  );
}
