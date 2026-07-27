import { useState } from 'react';
import { api } from '../lib/api';
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
 */
export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const setMustChangePassword = useStore((s) => s.setMustChangePassword);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
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

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          <Icon name="gem" size={40} />
        </div>
        <h1>WebObsidian</h1>
        <p>Enter your password to unlock</p>
        <div className="err">{err}</div>
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
      </form>
    </div>
  );
}
