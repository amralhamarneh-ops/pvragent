'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { createClient } from '../lib/supabase/client';

export type AuthFailureKind = 'not_configured' | 'invalid_credentials' | 'email_not_confirmed' | 'user_exists' | 'weak_password' | 'rate_limited' | 'network' | 'other';

export type SignUpOutcome =
  | { status: 'signed_in' }
  | { status: 'confirmation_required'; email: string };

export class AuthFailure extends Error {
  readonly kind: AuthFailureKind;
  constructor(kind: AuthFailureKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'AuthFailure';
  }
}

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** True when a session existed earlier in this page's life and has since ended without the user signing out. */
  sessionExpired: boolean;
  configured: boolean;
  signUp: (email: string, password: string, metadata?: { fullName?: string; avatarUrl?: string }) => Promise<SignUpOutcome>;
  signIn: (email: string, password: string) => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearExpired: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};

function classify(message: string, status?: number): AuthFailure {
  const m = message.toLowerCase();
  if (m.includes('email not confirmed') || m.includes('not confirmed')) return new AuthFailure('email_not_confirmed', 'Your email address has not been confirmed yet. Open the confirmation email we sent you, or request a new one below.');
  if (m.includes('invalid login credentials') || m.includes('invalid credentials')) return new AuthFailure('invalid_credentials', 'The email or password is not correct.');
  if (m.includes('already registered') || m.includes('already been registered') || m.includes('user already')) return new AuthFailure('user_exists', 'An account with this email already exists. Sign in instead, or reset your password.');
  if (m.includes('password') && (m.includes('weak') || m.includes('at least') || m.includes('short'))) return new AuthFailure('weak_password', message);
  if (status === 429 || m.includes('rate limit') || m.includes('too many')) return new AuthFailure('rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  if (m.includes('failed to fetch') || m.includes('network')) return new AuthFailure('network', 'Could not reach the sign-in service. Check your connection and try again.');
  return new AuthFailure('other', message || 'Sign-in failed.');
}

const NOT_CONFIGURED = 'Sign-in is not configured: NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.';

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    let hadSession = false;
    let signedOutByUser = false;
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      hadSession = !!s;
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT') {
        // A SIGNED_OUT the user did not ask for (refresh failed, token revoked) is an expired session.
        if (hadSession && !signedOutByUser) setSessionExpired(true);
        hadSession = false;
      } else if (s) {
        hadSession = true;
        signedOutByUser = false;
        setSessionExpired(false);
      }
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });
    (window as unknown as { __pvrUserSignOut?: () => void }).__pvrUserSignOut = () => { signedOutByUser = true; };
    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signUp: AuthContextValue['signUp'] = async (email, password, metadata = {}) => {
    if (!supabase) throw new AuthFailure('not_configured', NOT_CONFIGURED);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: metadata.fullName || '', avatar_url: metadata.avatarUrl || '' }, emailRedirectTo: `${window.location.origin}/sign-up-login-screen?confirmed=1` },
    });
    if (error) throw classify(error.message, error.status);
    // Supabase returns a user with no identities when the email already exists but is protected from enumeration.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw new AuthFailure('user_exists', 'An account with this email already exists. Sign in instead, or reset your password.');
    if (!data.session) return { status: 'confirmation_required', email };
    return { status: 'signed_in' };
  };

  const signIn: AuthContextValue['signIn'] = async (email, password) => {
    if (!supabase) throw new AuthFailure('not_configured', NOT_CONFIGURED);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw classify(error.message, error.status);
  };

  const resendConfirmation: AuthContextValue['resendConfirmation'] = async (email) => {
    if (!supabase) throw new AuthFailure('not_configured', NOT_CONFIGURED);
    const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${window.location.origin}/sign-up-login-screen?confirmed=1` } });
    if (error) throw classify(error.message, error.status);
  };

  const signOut: AuthContextValue['signOut'] = async () => {
    if (!supabase) return;
    (window as unknown as { __pvrUserSignOut?: () => void }).__pvrUserSignOut?.();
    const { error } = await supabase.auth.signOut();
    if (error) throw classify(error.message, error.status);
  };

  const value: AuthContextValue = {
    user,
    session,
    loading,
    sessionExpired,
    configured: !!supabase,
    signUp,
    signIn,
    resendConfirmation,
    signOut,
    clearExpired: () => setSessionExpired(false),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
