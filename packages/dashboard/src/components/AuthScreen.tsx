import { useState, type FormEvent } from 'react';
import { USE_EMULATORS } from '../firebase';

interface Props {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (email: string, password: string) => Promise<void>;
}

/** Email/password sign-in + sign-up. Surfaces Firebase auth errors inline. */
export function AuthScreen({ onSignIn, onSignUp }: Props) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState(USE_EMULATORS ? 'demo@demo.dev' : '');
  const [password, setPassword] = useState(USE_EMULATORS ? 'demo123' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await onSignIn(email, password);
      else await onSignUp(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>
          {mode === 'signin' ? 'Sign in' : 'Create account'}
        </h1>
        <p className="sub">
          Claude Session Dashboard
          {USE_EMULATORS ? ' · emulator mode' : ''}
        </p>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              className="input"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
          </button>
        </form>
        <div className="auth-toggle">
          {mode === 'signin' ? (
            <>
              No account?{' '}
              <button onClick={() => setMode('signup')} type="button">
                Create one
              </button>
            </>
          ) : (
            <>
              Have an account?{' '}
              <button onClick={() => setMode('signin')} type="button">
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
