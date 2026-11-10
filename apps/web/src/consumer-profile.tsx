import { useEffect, useState, type FormEvent } from 'react';
import { ShieldCheck, ChevronRight, Mail, LockKeyhole, AtSign } from 'lucide-react';
import { useToast } from './toast.js';
import { ConsumerFields } from './consumer-fields.js';
import { PaymentSecurity } from './payment-security.js';
import { consumerRequest, countries, profileDraft, profilePayload, type ConsumerProfile } from './consumer-api.js';

const countryName = (code: unknown) => countries.find(([value]) => value === code)?.[1] ?? (code ? String(code) : '—');
const shown = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : String(value));
type Row = [label: string, value: string];

/** One part of the profile: read-only rows, edited and saved on its own. */
function ProfileSection({ title, section, rows, profile, csrf, onSaved, note }: {
  title: string; section: 'identity' | 'address'; rows: Row[]; profile: ConsumerProfile; csrf: string;
  onSaved: () => Promise<void>; note?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>(() => profileDraft(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  useEffect(() => { if (!editing) setDraft(profileDraft(profile)); }, [profile, editing]);
  const set = (key: string, value: string) => setDraft({ ...draft, [key]: value });
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      // The other sections' values come from the saved profile, so saving one never changes another.
      await consumerRequest('profile', 'PATCH', {
        ...profilePayload({ ...draft, nationality: draft.nationality || null, phone: String(draft.phone ?? '').replace(/[\s()-]/g, '') }),
        profile_version: profile.profile_version,
      }, csrf);
      await onSaved();
      setEditing(false);
      toast('Profile saved.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="fin-panel fin-settings-section" aria-label={title}>
    <div className="fin-settings-head">
      <h2>{title}</h2>
      {note && <span className="fin-settings-note"><LockKeyhole size={13} /> {note}</span>}
      {!editing && <button className="fin-secondary" type="button" onClick={() => setEditing(true)}>Edit</button>}
    </div>
    {editing ? <form onSubmit={save} className="fin-settings-form">
      <ConsumerFields value={draft} set={set} section={section} locked={profile.identity_locked} />
      {error && <div className="fin-error" role="alert">{error}</div>}
      <div className="fin-form-actions">
        <button className="fin-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button className="fin-text" type="button" onClick={() => { setEditing(false); setError(''); }} disabled={busy}>Cancel</button>
      </div>
    </form> : <dl className="fin-settings-rows">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>}
  </section>;
}

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
  const [currency, setCurrency] = useState(profile.display_currency ?? 'USD');
  const [error, setError] = useState('');
  const toast = useToast();
  async function saveCurrency(next: string) {
    const previous = currency;
    setCurrency(next); setError('');
    try {
      await consumerRequest('profile', 'PATCH', {
        ...profilePayload({ ...profileDraft(profile), display_currency: next }), profile_version: profile.profile_version,
      }, csrf);
      await onSaved();
      toast('Preference saved.');
    } catch (e) { setCurrency(previous); setError((e as Error).message); }
  }
  const locked = profile.identity_locked ? 'Locked after verification' : undefined;
  const dob = profile.date_of_birth
    ? new Date(`${profile.date_of_birth}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  return (
    <>
      <div className="fin-profile-banner">
        <div className="fin-avatar large">
          {(profile.first_name?.[0] ?? 'R') + (profile.last_name?.[0] ?? '')}
        </div>
        <div>
          <h2>{profile.first_name ? `${profile.first_name} ${profile.last_name}` : 'Your account'}</h2>
          <p>{profile.username ? `@${profile.username}` : 'No username yet'}</p>
        </div>
        <span className={`fin-status ${profile.identity_status === 'Approved' ? 'verified' : ''}`}>
          <ShieldCheck size={14} />
          {profile.identity_status === 'Approved' ? 'Verified' : 'Not verified'}
        </span>
      </div>
      <div className="fin-settings">
        <ProfileSection title="Profile" section="identity" profile={profile} csrf={csrf} onSaved={onSaved} note={locked} rows={[
          ['Name', `${shown(profile.first_name)} ${profile.last_name ?? ''}`.trim()],
          ['Username', profile.username ? `@${profile.username}` : '—'],
          ['Phone', shown(profile.phone)],
          ['Date of birth', dob],
          ['Country', countryName(profile.residence_country)],
        ]} />
        <ProfileSection title="Address & details" section="address" profile={profile} csrf={csrf} onSaved={onSaved} note={locked} rows={[
          ['Address', [profile.address_line1, profile.address_line2].filter(Boolean).join(', ') || '—'],
          ['City', [profile.city, profile.region, profile.postal_code].filter(Boolean).join(', ') || '—'],
          ['Occupation', shown(profile.occupation)],
          ['Nationality', profile.nationality ? countryName(profile.nationality) : '—'],
        ]} />
        <section className="fin-panel fin-settings-section" aria-label="Preferences">
          <div className="fin-settings-head"><h2>Preferences</h2></div>
          <label className="fin-settings-inline">Display currency
            <select value={currency} onChange={(e) => void saveCurrency(e.target.value)}>
              {['USD', 'NGN', 'GHS', 'EUR', 'GBP'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          {error && <div className="fin-error" role="alert">{error}</div>}
        </section>
        <section className="fin-panel fin-settings-section" aria-label="Sign-in and verification">
          <div className="fin-settings-head"><h2>Sign-in & verification</h2></div>
          <button className="fin-settings-link" onClick={() => go('/personal/security')}>
            <Mail size={18} /><span><b>Email</b><small>{profile.email ?? 'No email linked'}</small></span>
            <em className={`fin-status ${profile.email_verified_at ? 'verified' : ''}`}>{profile.email_verified_at ? 'Verified' : 'Not verified'}</em>
            <ChevronRight size={16} />
          </button>
          <button className="fin-settings-link" onClick={() => go('/personal/identity')}>
            <ShieldCheck size={18} /><span><b>Identity</b><small>Didit verification</small></span>
            <em className={`fin-status ${profile.identity_status === 'Approved' ? 'verified' : ''}`}>{profile.identity_status === 'Approved' ? 'Verified' : 'Not verified'}</em>
            <ChevronRight size={16} />
          </button>
          <button className="fin-settings-link" onClick={() => go('/personal/security')}>
            <LockKeyhole size={18} /><span><b>Password, PIN & passkeys</b><small>How you sign in and approve payments</small></span>
            <ChevronRight size={16} />
          </button>
        </section>
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
      <PaymentSecurity csrf={csrf} hasPassword={!!profile.has_password} />
      <PaymentSettings csrf={csrf} />
      <section className="fin-panel">
        <Mail size={24} />
        <h2>Email verification</h2>
        <p className="fin-break">{profile.email ?? 'No email linked'}</p>
        <span className={`fin-status ${profile.email_verified_at ? 'verified' : ''}`}>
          {profile.email_verified_at ? 'Verified' : 'Not verified'}
        </span>
        {!emailEnabled && !profile.email_verified_at && <p className="fin-small">Email codes are not available yet.</p>}
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
        {!profile.email_verified_at && <button
          className="fin-secondary"
          disabled={busy || !profile.email || !emailEnabled || (!!challenge && code.length !== 6)}
          onClick={verify}
        >
          {challenge ? 'Verify email' : 'Send verification code'}
        </button>}
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
        <p className="fin-small">At least 12 characters.</p>
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

type PaymentSettingsState = { username: string | null; payable_by_username: boolean; receiving_address: string | null };

/** Opt-in to being paid by @username. Off by default: a username reveals no wallet without consent. */
function PaymentSettings({ csrf }: { csrf: string }) {
  const [settings, setSettings] = useState<PaymentSettingsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void consumerRequest<PaymentSettingsState>('payment-settings').then(setSettings).catch((e) => setError((e as Error).message));
  }, []);
  async function toggle(next: boolean) {
    const previous = settings;
    // Reflect the choice at once; roll back if the server refuses it.
    if (previous) setSettings({ ...previous, payable_by_username: next });
    setBusy(true);
    setError('');
    try {
      setSettings(await consumerRequest<PaymentSettingsState>('payment-settings', 'POST', { payable_by_username: next }, csrf));
    } catch (e) {
      setSettings(previous);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="fin-panel fin-payment-settings" aria-label="Payments by username">
      <div className="fin-security-row fin-security-row-first">
        <AtSign size={20} />
        <div>
          <b>Get paid by username</b>
          <small>
            {!settings ? 'Loading…' : !settings.username ? 'Choose a username in your profile first'
              : settings.payable_by_username
                ? settings.receiving_address
                  ? `@${settings.username} · to ${settings.receiving_address.slice(0, 6)}…${settings.receiving_address.slice(-4)}`
                  : 'Link a QIE wallet to receive'
                : `People can't pay @${settings.username} yet`}
          </small>
        </div>
        {settings && <label className="fin-switch">
          <input type="checkbox" aria-label="Get paid by username" checked={settings.payable_by_username} disabled={busy || !settings.username}
            onChange={(e) => void toggle(e.target.checked)} />
        </label>}
      </div>
      {error && <p className="fin-error" role="alert">{error}</p>}
    </section>
  );
}
