'use client';

import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, Mail, ShieldCheck, KeyRound, Lock } from 'lucide-react';
import AppLogo from '@/components/ui/AppLogo';
import { AuthFailure, useAuth, type AuthFailureKind } from '@/contexts/AuthContext';

interface AuthValues {
  fullName: string;
  email: string;
  password: string;
  terms: boolean;
}

const inputBase =
  'w-full rounded-md border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30';

type Notice =
  | { kind: 'confirmation_required'; email: string }
  | { kind: 'failure'; failure: AuthFailureKind; message: string }
  | null;

function safeNext(): string {
  const next = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('next') : null;
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/new-pvr';
}

export default function AuthShell() {
  const router = useRouter();
  const { signIn, signUp, resendConfirmation, sessionExpired, clearExpired, configured, user, loading: authLoading } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirmedBanner, setConfirmedBanner] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendError, setResendError] = useState('');
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<AuthValues>();

  // Returning from the confirmation link: show success and ask the person to sign in.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('confirmed') === '1') setConfirmedBanner(true);
  }, []);

  // Already signed in (for example after the confirmation link signed them in): continue.
  useEffect(() => {
    if (!authLoading && user) router.replace(safeNext());
  }, [authLoading, user, router]);

  const onSubmit = async (values: AuthValues) => {
    setNotice(null);
    setResendState('idle');
    setLoading(true);
    try {
      if (mode === 'signup') {
        const out = await signUp(values.email.trim(), values.password, { fullName: values.fullName });
        if (out.status === 'confirmation_required') { setNotice({ kind: 'confirmation_required', email: values.email.trim() }); return; }
      } else {
        await signIn(values.email.trim(), values.password);
      }
      clearExpired();
      router.push(safeNext());
    } catch (e) {
      if (e instanceof AuthFailure) setNotice({ kind: 'failure', failure: e.kind, message: e.message });
      else setNotice({ kind: 'failure', failure: 'other', message: e instanceof Error ? e.message : 'Sign-in failed.' });
    } finally {
      setLoading(false);
    }
  };

  const resend = async (email: string) => {
    setResendState('sending');
    setResendError('');
    try {
      await resendConfirmation(email);
      setResendState('sent');
    } catch (e) {
      setResendState('error');
      setResendError(e instanceof Error ? e.message : 'Could not send the email.');
    }
  };

  const needsConfirmation = notice?.kind === 'confirmation_required' || (notice?.kind === 'failure' && notice.failure === 'email_not_confirmed');
  const confirmationEmail = notice?.kind === 'confirmation_required' ? notice.email : getValues('email');

  return (
    <div className="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-primary p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="drafting-grid pointer-events-none absolute inset-0 opacity-10" />
        <div className="relative flex items-center gap-2.5">
          <AppLogo size={44} />
          <span className="text-2xl font-bold tracking-tight">PVRAgent</span>
        </div>

        <div className="relative max-w-lg">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider opacity-70">Variation control for UAE developers</p>
          <h1 className="text-headline font-semibold tracking-tight">
            Price a change from your own BOQ, with every figure traced to its source cell.
          </h1>
          <ul className="mt-8 space-y-4 text-sm opacity-90">
            <li className="flex gap-3">
              <ShieldCheck size={18} className="mt-0.5 shrink-0" />
              Rates and quantities come only from the files you upload.
            </li>
            <li className="flex gap-3">
              <KeyRound size={18} className="mt-0.5 shrink-0" />
              Each case is private to the account that created it.
            </li>
            <li className="flex gap-3">
              <Lock size={18} className="mt-0.5 shrink-0" />
              Access is owner-only. Sharing a case with a project team is not available yet.
            </li>
          </ul>
        </div>

        <p className="relative text-xs opacity-60">Owner-only access · Original BOQ files kept in a private store</p>
      </section>

      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <AppLogo size={36} />
            <span className="text-xl font-bold tracking-tight text-foreground">PVRAgent</span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === 'login' ? 'Use the email and password for your account.' : 'You will be sent a confirmation email before you can sign in.'}
          </p>

          {!configured ? (
            <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Not configured: sign-in needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY. No account can be created or used until they are set.
            </p>
          ) : null}

          {sessionExpired ? (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
              <span><span className="font-semibold">Your session has expired or is no longer valid.</span> Sign in again to continue. Anything saved on the server is still there; anything held only in a browser tab may be lost.</span>
            </p>
          ) : null}

          {confirmedBanner && !needsConfirmation ? (
            <p role="status" className="mt-4 flex items-start gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-secondary-foreground">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span><span className="font-semibold">Email confirmed.</span> Sign in below to continue. If the link had expired or was already used, request a new confirmation email after trying to sign in.</span>
            </p>
          ) : null}

          {notice?.kind === 'confirmation_required' ? (
            <div role="status" className="mt-4 rounded-md border border-border bg-secondary px-4 py-3 text-sm text-secondary-foreground">
              <p className="flex items-center gap-2 font-semibold"><Mail size={16} aria-hidden />Check your email to finish creating your account</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>We sent a confirmation link to <span className="font-semibold">{notice.email}</span>.</li>
                <li>Open the email and select the link. Check your spam folder if you do not see it.</li>
                <li>Return here and sign in. You cannot sign in until the email is confirmed.</li>
              </ol>
            </div>
          ) : null}

          {notice?.kind === 'failure' ? (
            <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{notice.message}</p>
          ) : null}

          {needsConfirmation && confirmationEmail ? (
            <div className="mt-3 text-sm">
              <button type="button" onClick={() => void resend(confirmationEmail)} disabled={resendState === 'sending'} className="rounded-md border border-input bg-card px-3 py-1.5 font-medium text-foreground hover:bg-muted disabled:opacity-60">
                {resendState === 'sending' ? 'Sending…' : 'Send the confirmation email again'}
              </button>
              {resendState === 'sent' ? <p role="status" className="mt-2 text-muted-foreground">A new confirmation email was requested for {confirmationEmail}. The latest link is the one that works.</p> : null}
              {resendState === 'error' ? <p role="alert" className="mt-2 text-destructive">{resendError}</p> : null}
            </div>
          ) : null}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
            {mode === 'signup' ? (
              <div>
                <label htmlFor="fullName" className="mb-1.5 block text-sm font-semibold text-foreground">Full name</label>
                <input
                  id="fullName"
                  autoComplete="name"
                  className={`${inputBase} ${errors.fullName ? 'border-destructive' : 'border-input'}`}
                  {...register('fullName', { required: 'Enter your full name' })}
                />
                {errors.fullName ? <p className="mt-1 text-xs font-medium text-destructive">{errors.fullName.message}</p> : null}
              </div>
            ) : null}

            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-foreground">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className={`${inputBase} ${errors.email ? 'border-destructive' : 'border-input'}`}
                {...register('email', {
                  required: 'Enter your email',
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address' },
                })}
              />
              {errors.email ? <p className="mt-1 text-xs font-medium text-destructive">{errors.email.message}</p> : null}
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-semibold text-foreground">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className={`${inputBase} pr-10 ${errors.password ? 'border-destructive' : 'border-input'}`}
                  {...register('password', {
                    required: 'Enter your password',
                    minLength: { value: 8, message: 'Use at least 8 characters' },
                  })}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {errors.password ? <p className="mt-1 text-xs font-medium text-destructive">{errors.password.message}</p> : null}
              {mode === 'login' ? <p className="mt-1 text-xs text-muted-foreground">Password reset is not available yet. Contact the administrator of this workspace if you are locked out.</p> : null}
            </div>

            {mode === 'signup' ? (
              <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" {...register('terms', { required: 'Confirm to continue' })} />
                <span>I understand this account has owner-only access: only I can see the cases I create.</span>
              </label>
            ) : null}
            {errors.terms ? <p className="text-xs font-medium text-destructive">{errors.terms.message}</p> : null}

            <button
              type="submit"
              disabled={loading || !configured}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:opacity-90 active:scale-95 disabled:opacity-60"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : null}
              {loading ? (mode === 'login' ? 'Signing in' : 'Creating account') : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-muted-foreground">
            {mode === 'login' ? 'New to PVRAgent?' : 'Already have an account?'}{' '}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setNotice(null);
                setResendState('idle');
              }}
              className="font-semibold text-accent hover:underline"
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </div>
      </section>
    </div>);
}