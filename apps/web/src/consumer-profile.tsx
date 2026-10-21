import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, ShieldCheck, ArrowRight, Mail, LockKeyhole } from 'lucide-react';
import { ConsumerFields } from './consumer-fields.js';
import { consumerRequest, profileDraft, profilePayload, type ConsumerProfile } from './consumer-api.js';

export function ConsumerProfileForm({
  profile,
  csrf,
  onSaved,
  go,
}: {
  profile: ConsumerProfile;
  csrf: string;
  onSaved: () => Promise<void>;
  go: (path: string) => void;
}) {
  const [draft, setDraft] = useState<any>(() => profileDraft(profile)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const set = (key: string, value: string) => {
    setDraft({ ...draft, [key]: value });
    setSaved(false);
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await consumerRequest(
        'profile',
        'PATCH',
        {
          ...profilePayload({
            ...draft,
            nationality: draft.nationality || null,
            phone: String(draft.phone ?? '').replace(/[\s()-]/g, ''),
          }),
          profile_version: profile.profile_version,
        },
        csrf,
      );
      await onSaved();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="fin-profile-banner">
        <div className="fin-avatar large">
          {(profile.first_name?.[0] ?? 'M') + (profile.last_name?.[0] ?? '')}
        </div>
        <div>
          <h2>
            {profile.first_name
              ? `${profile.first_name} ${profile.last_name}`
              : 'Your personal account'}
          </h2>
          <p>{profile.username ? `@${profile.username}` : 'Choose your username below'}</p>
        </div>
        <span className={`fin-status ${profile.identity_status === 'Approved' ? 'verified' : ''}`}>
          <ShieldCheck size={14} />
          {profile.identity_status === 'Approved' ? 'Identity verified' : 'Identity not verified'}
        </span>
      </div>
      <div className="fin-account-grid">
        <form className="fin-panel" onSubmit={save}>
          <div className="fin-section-head">
            <h2>Personal information</h2>
            <span>Private to you</span>
          </div>
          {profile.identity_locked && (
            <div className="fin-notice">
              Your identity details are protected during and after verification. Contact support if
              they need correcting.
            </div>
          )}
          <ConsumerFields
            value={draft}
            set={set}
            section="identity"
            locked={profile.identity_locked}
          />
          <h3>Residential address</h3>
          <ConsumerFields
            value={draft}
            set={set}
            section="address"
            locked={profile.identity_locked}
          />
          <label>
            Display currency
            <select
              value={draft.display_currency}
              onChange={(e) => set('display_currency', e.target.value)}
            >
              {['USD', 'NGN', 'GHS', 'EUR', 'GBP'].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <p className="fin-small">Your display preference does not convert or move money.</p>
          {error && (
            <div className="fin-error" role="alert">
              {error}
            </div>
          )}
          {saved && (
            <div className="fin-success" role="status">
              <CheckCircle2 size={16} /> Profile saved.
            </div>
          )}
          <button className="fin-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
        <aside className="fin-stack">
          <section className="fin-panel">
            <Mail size={23} />
            <h2>Email address</h2>
            <p className="fin-break">{profile.email ?? 'No email linked'}</p>
            <span className="fin-status">
              {profile.email_verified_at ? 'Verified' : 'Not verified'}
            </span>
            <button className="fin-link-row" onClick={() => go('/personal/security')}>
              Email & security <ArrowRight size={16} />
            </button>
          </section>
          <section className="fin-panel">
            <ShieldCheck size={23} />
            <h2>Identity check</h2>
            <p>Complete your identity check before using available payment services.</p>
            <button className="fin-link-row" onClick={() => go('/personal/identity')}>
              Manage verification <ArrowRight size={16} />
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}
export function ConsumerSecurity({
  profile,
  csrf,
  onSaved,
}: {
  profile: ConsumerProfile;
  csrf: string;
  onSaved: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [challenge, setChallenge] = useState(''),
    [code, setCode] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  useEffect(() => {
    void consumerRequest('registration/config')
      .then((value) => setEmailEnabled(value.email_verification_available))
      .catch(() => {});
  }, []);
  async function change(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await consumerRequest(
        'profile/password',
        'POST',
        { current_password: current, password },
        csrf,
      );
      setPassword('');
      setCurrent('');
      await onSaved();
      setNotice('Password updated. Other sessions have been signed out.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setError('');
    try {
      if (challenge) {
        await consumerRequest('auth/verify', 'POST', { challenge_id: challenge, code });
        setChallenge('');
        await onSaved();
        setNotice('Email verified.');
      } else {
        const result = await consumerRequest('auth/start', 'POST', { email: profile.email });
        setChallenge(result.challenge_id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fin-security">
      <section className="fin-panel">
        <Mail size={24} />
        <h2>Email verification</h2>
        <p className="fin-break">{profile.email ?? 'No email linked'}</p>
        <p>
          {profile.email_verified_at
            ? 'Your email is verified.'
            : 'Verify ownership of your email before making payments.'}
        </p>
        {!emailEnabled && (
          <p className="fin-small">
            Email delivery is being configured. Password sign-in remains available.
          </p>
        )}
        {challenge && (
          <label>
            Six-digit code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>
        )}
        <button
          className="fin-secondary"
          disabled={busy || !profile.email || !emailEnabled || (!!challenge && code.length !== 6)}
          onClick={verify}
        >
          {challenge ? 'Verify email' : 'Send verification code'}
        </button>
      </section>
      <form className="fin-panel" onSubmit={change}>
        <LockKeyhole size={24} />
        <h2>{profile.has_password ? 'Change password' : 'Set your password'}</h2>
        {profile.has_password && (
          <label>
            Current password
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              maxLength={128}
            />
          </label>
        )}
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <p className="fin-small">
          Use at least 12 characters. A fresh email code can also authorize a password reset.
        </p>
        <button className="fin-primary" disabled={busy}>
          Update password
        </button>
      </form>
      {error && (
        <div className="fin-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="fin-success" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
