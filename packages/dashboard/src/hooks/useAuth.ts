import { useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  linkWithPopup,
  linkWithCredential,
  updatePassword,
  EmailAuthProvider,
  GoogleAuthProvider,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from '../firebase';

export interface AuthState {
  user: User | null;
  /** True until the first onAuthStateChanged fires (avoids auth-screen flash). */
  initializing: boolean;
}

const googleProvider = new GoogleAuthProvider();

/** Does the current user already have Google linked? */
export function hasGoogle(user: User | null): boolean {
  return !!user?.providerData.some((p) => p.providerId === 'google.com');
}

/** Subscribes to the Firebase auth session and exposes sign-in helpers. */
export function useAuth(): AuthState & {
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  linkGoogle: () => Promise<void>;
  setAgentPassword: (newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setInitializing(false);
    });
    return unsub;
  }, []);

  return {
    user,
    initializing,
    signIn: async (email, password) => {
      await signInWithEmailAndPassword(auth, email, password);
    },
    signUp: async (email, password) => {
      await createUserWithEmailAndPassword(auth, email, password);
    },
    signInWithGoogle: async () => {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (err: any) {
        // The email already has a password account. Firebase won't auto-merge
        // providers — the user must sign in with their password once, then link
        // Google (so both providers share ONE uid, the one the agent writes to).
        if (err?.code === 'auth/account-exists-with-different-credential') {
          throw new Error(
            'This email already has a password login. Sign in with your password, ' +
              'then click “Link Google account” so Google uses the same account.',
          );
        }
        throw err;
      }
    },
    // Attach Google to the currently signed-in (password) account → same uid.
    linkGoogle: async () => {
      if (!auth.currentUser) throw new Error('Sign in first, then link Google.');
      await linkWithPopup(auth.currentUser, googleProvider);
    },
    // Give the currently signed-in account a password (for the headless agent).
    // If the account has no password provider (e.g. it's Google-only because a
    // Google sign-in overwrote an unverified password account), link one; if it
    // already has one, update it. Either way the agent can then sign in with
    // email + this password as the SAME uid this user is signed in as.
    setAgentPassword: async (newPassword: string) => {
      const u = auth.currentUser;
      if (!u || !u.email) throw new Error('Sign in (e.g. with Google) first.');
      const cred = EmailAuthProvider.credential(u.email, newPassword);
      try {
        await linkWithCredential(u, cred);
      } catch (err: any) {
        if (err?.code === 'auth/provider-already-linked' || err?.code === 'auth/email-already-in-use') {
          await updatePassword(u, newPassword); // password provider exists → just set it
        } else {
          throw err;
        }
      }
    },
    logout: async () => {
      await signOut(auth);
    },
  };
}
