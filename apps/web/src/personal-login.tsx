import React, { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, LockKeyhole, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { ConsumerRequestError, consumerRequest, emptyProfile, profilePayload } from './consumer-api.js';
import { MicrosendrAuth } from './auth-shell.js';
import type { AuthConfig } from './microsendr-auth.js';
import { ConsumerFields } from './consumer-fields.js';

export function PersonalLogin({
  brand,
  go,
  onComplete,
  notice: signInNotice = '',
}: {
  brand: React.ReactNode;
  go: (path: string) => void;
  notice?: string;
  onComplete: (session: any, newAccount?: boolean) => void | Promise<void>;
}) {
  const [legacyConfig, setLegacyConfig] = useState<AuthConfig>();
  const [restoring, setRestoring] = useState(false);
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [show, setShow] = useState(false);
  const [details, setDetails] = useState<any>({ ...emptyProfile });
  const [emailEnabled, setEmailEnabled] = useState(false),
    [challenge, setChallenge] = useState(''),
    [code, setCode] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    document.title =
      mode === 'register' ? 'Create your account | Microsendr' : 'Sign in | Microsendr';
  }, [mode]);
  useEffect(() => {
    void consumerRequest('registration/config')
      .then((data) => setEmailEnabled(data.email_verification_available))
      .catch(() => {});
  }, []);
  const switchMode = (next: typeof mode) => {
    setMode(next);
    setRestoring(false);
    setStep(0);
    setError('');
    setPassword('');
    setChallenge('');
    setCode('');
    setNotice('');
  };
  // auth/start answers the same way whether or not an account exists, so the copy stays neutral.
  async function sendRecoveryCode() {
    const result = await consumerRequest('auth/start', 'POST', { email });
    setChallenge(result.challenge_id);
    setCode('');
    setNotice(
      `If ${email.trim()} belongs to a Microsendr account, a six-digit code is on its way. Codes only work for existing accounts.`,
    );
  }
  async function resendCode() {
    setError('');
    setBusy(true);
    try {
      await sendRecoveryCode();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  function useDifferentEmail() {
    setChallenge('');
    setCode('');
    setNotice('');
    setError('');
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && step < 2) {
      setStep(step + 1);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'recover') {
        if (challenge) {
          let session;
          try {
            session = await consumerRequest('auth/verify', 'POST', {
              challenge_id: challenge,
              code,
            });
          } catch (cause) {
            if (cause instanceof ConsumerRequestError && cause.code === 'invalid_code')
              throw new Error(
                'That code didn’t work. Check the latest code we sent, or request a new one. Recovery only works for an existing Microsendr account.',
              );
            throw cause;
          }
          await onComplete(session);
          go('/personal/security');
        } else {
          await sendRecoveryCode();
        }
      } else {
        const session = await consumerRequest(
          mode === 'register' ? 'auth/register' : 'auth/password',
          'POST',
          mode === 'register'
            ? {
                ...profilePayload({
                  ...details,
                  nationality: details.nationality || null,
                  phone: details.phone.replace(/[\s()-]/g, ''),
                }),
                email,
                password,
              }
            : { email, password },
        );
        setPassword('');
        await onComplete(session, mode === 'register');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fin-auth">
      <header className="fin-auth-header">
        <button className="fin-brand" onClick={() => go('/')}>
          {brand}
        </button>
        <button className="fin-text" onClick={() => go('/')}>
          <ArrowLeft size={16} /> Back to home
        </button>
      </header>
      <div className="fin-auth-layout">
        <aside className="fin-auth-story">
          <span className="fin-kicker">A LITTLE MORE FREEDOM</span>
          <h2>
            Your money.
            <br />
            On your terms.
          </h2>
          <p>One account. A clearer way to move forward.</p>
          <div className="fin-auth-art" aria-hidden="true">
            <div className="fin-art-orbit" />
            <div className="fin-art-card">
              <span>microsendr</span>
              <b>
                Made for
                <br />
                your next move.
              </b>
              <div>
                <span>PERSONAL ACCOUNT</span>
                <ArrowRight size={26} />
              </div>
            </div>
            <div className="fin-art-chip">
              <ShieldCheck size={20} /> Your account. Your control.
            </div>
          </div>
          <span className="fin-auth-foot">
            <LockKeyhole size={16} /> Your details stay private.
          </span>
        </aside>
        <main className="fin-auth-panel">
          <div className="fin-auth-form">
            <span className="fin-kicker">MICROSENDR PERSONAL</span>
            <h1>
              {mode === 'login'
                ? 'Welcome back.'
                : mode === 'recover'
                  ? 'Let’s get you back in.'
                  : step === 0
                    ? 'Make your next move.'
                    : step === 1
                      ? 'A little about you.'
                      : 'Where do you live?'}
            </h1>
            <p>
              {mode === 'login'
                ? 'Sign in to your account.'
                : mode === 'recover'
                  ? challenge
                    ? 'Enter the six-digit code sent to your email.'
                    : 'Use a verified email code to recover your account.'
                  : step === 0
                    ? 'Create your Microsendr account.'
                    : step === 1
                      ? 'Use the details on your identity document.'
                      : 'Your address helps us keep your account up to date.'}
            </p>
            {mode === 'register' && (
              <ol className="fin-steps">
                {['Account', 'Personal details', 'Address'].map((label, i) => (
                  <li
                    key={label}
                    className={i <= step ? 'active' : ''}
                    aria-current={i === step ? 'step' : undefined}
                  >
                    <span>{i < step ? <Check size={12} /> : i + 1}</span>
                    {label}
                  </li>
                ))}
              </ol>
            )}
            {error && (
              <div className="fin-error" role="alert">
                {error}
              </div>
            )}
            {signInNotice && mode === 'login' && (
              <div className="fin-notice" role="status">
                {signInNotice}
              </div>
            )}
            {restoring ? (
              <>
                <p>
                  Confirm ownership of your previous account, then choose a Microsendr password.
                </p>
                <MicrosendrAuth
                  restoreExisting
                  config={legacyConfig}
                  onComplete={async (session) => {
                    await onComplete(session);
                    go('/personal/security');
                  }}
                />
              </>
            ) : (
              <form onSubmit={submit}>
                {(mode !== 'register' || step === 0) && (
                  <>
                    {!challenge && (
                      <label>
                        Email address
                        <input
                          type="email"
                          autoComplete="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          required
                          maxLength={254}
                          placeholder="you@example.com"
                        />
                      </label>
                    )}
                    {mode !== 'recover' && (
                      <label>
                        Password
                        <div className="fin-password">
                          <input
                            type={show ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                            minLength={mode === 'register' ? 12 : 1}
                            maxLength={128}
                            required
                            placeholder={
                              mode === 'register' ? 'At least 12 characters' : 'Enter your password'
                            }
                          />
                          <button
                            type="button"
                            onClick={() => setShow(!show)}
                            aria-label={show ? 'Hide password' : 'Show password'}
                          >
                            {show ? <EyeOff size={18} /> : <Eye size={18} />}
                          </button>
                        </div>
                      </label>
                    )}
                    {mode === 'login' && (
                      <button
                        type="button"
                        className="fin-text fin-forgot"
                        onClick={() => switchMode('recover')}
                      >
                        Forgot password or upgrading an existing account?
                      </button>
                    )}
                    {mode === 'recover' && challenge && (
                      <>
                        {notice && (
                          <div className="fin-notice" role="status">
                            {notice}
                          </div>
                        )}
                        <label>
                          Verification code
                          <input
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            inputMode="numeric"
                            pattern="[0-9]{6}"
                            minLength={6}
                            maxLength={6}
                            autoComplete="one-time-code"
                            required
                          />
                        </label>
                        <div className="fin-code-actions">
                          <button
                            type="button"
                            className="fin-text"
                            onClick={() => void resendCode()}
                            disabled={busy}
                          >
                            Resend code
                          </button>
                          <button
                            type="button"
                            className="fin-text"
                            onClick={useDifferentEmail}
                            disabled={busy}
                          >
                            Use a different email
                          </button>
                        </div>
                      </>
                    )}
                    {mode === 'recover' && !emailEnabled && (
                      <div className="fin-notice">
                        Email recovery is currently unavailable. If you already have a password,
                        return to sign in.
                      </div>
                    )}
                  </>
                )}
                {mode === 'register' && step > 0 && (
                  <ConsumerFields
                    value={details}
                    set={(key, value) => setDetails({ ...details, [key]: value })}
                    section={step === 1 ? 'identity' : 'address'}
                  />
                )}
                {mode === 'register' && step === 2 && (
                  <p className="fin-small">
                    You can verify your identity after creating your account, or return to it later.
                    Your phone number is not verified by completing this form.
                  </p>
                )}
                <div className="fin-form-actions">
                  {mode === 'register' && step > 0 && (
                    <button
                      type="button"
                      className="fin-secondary"
                      onClick={() => {
                        setStep(step - 1);
                        setError('');
                      }}
                      disabled={busy}
                    >
                      Back
                    </button>
                  )}
                  <button
                    className="fin-primary"
                    disabled={busy || (mode === 'recover' && !emailEnabled)}
                  >
                    {busy
                      ? 'Please wait…'
                      : mode === 'login'
                        ? 'Sign in'
                        : mode === 'recover'
                          ? challenge
                            ? 'Verify code'
                            : 'Send verification code'
                          : step < 2
                            ? 'Continue'
                            : 'Create account'}
                    <ArrowRight size={17} />
                  </button>
                </div>
              </form>
            )}
            {mode === 'recover' && !restoring && (
              <button
                className="fin-text"
                style={{ marginTop: 20 }}
                onClick={async () => {
                  setError('');
                  try {
                    const config = await consumerRequest<AuthConfig>('auth/legacy-config');
                    if (!config.enabled)
                      throw new Error('Previous account recovery is temporarily unavailable.');
                    setLegacyConfig(config);
                    setRestoring(true);
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                }}
              >
                Restore a previous email-code account
              </button>
            )}
            <div className="fin-auth-switch">
              {mode === 'login' ? (
                <>
                  New to Microsendr?{' '}
                  <button onClick={() => switchMode('register')}>Create an account</button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button onClick={() => switchMode('login')}>Sign in</button>
                </>
              )}
            </div>
          </div>
        </main>
      </div>
      <footer className="fin-auth-footer">
        © {new Date().getFullYear()} Microsendr <span>Made for your everyday.</span>
      </footer>
    </div>
  );
}
