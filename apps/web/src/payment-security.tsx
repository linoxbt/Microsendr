import { useEffect, useState, type FormEvent } from 'react';
import { Fingerprint, KeyRound, Trash2 } from 'lucide-react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { consumerRequest } from './consumer-api.js';
import { useToast } from './toast.js';

export type PaymentAuthStatus = {
  pin_set: boolean;
  pin_locked_until: string | null;
  passkeys: { id: string; label: string; created_at: string; last_used_at: string | null }[];
};
export const passkeysSupported = () =>
  typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn();

function deviceLabel() {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'This device';
  return `${device} passkey`;
}

/** Security: the payment PIN and passkeys that approve sends from the account wallet. */
export function PaymentSecurity({ csrf, hasPassword }: { csrf: string; hasPassword: boolean }) {
  const [status, setStatus] = useState<PaymentAuthStatus>();
  const [mode, setMode] = useState<'pin' | 'passkey' | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const load = () => consumerRequest<PaymentAuthStatus>('payment-auth').then(setStatus).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, []);
  const close = () => { setMode(null); setPin(''); setConfirmPin(''); setPassword(''); };

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const savePin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (pin !== confirmPin) throw new Error('The PINs do not match.');
      await consumerRequest('payment-auth/pin', 'POST', { pin, ...(hasPassword ? { password } : {}) }, csrf);
      close(); toast('Payment PIN saved.'); await load();
    });
  };
  const addPasskey = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { challenge_id, options } = await consumerRequest<{ challenge_id: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>(
        'payment-auth/passkeys/options', 'POST', hasPassword ? { password } : {}, csrf);
      const response = await startRegistration({ optionsJSON: options }).catch(() => {
        throw new Error('The passkey was not created. Try again.');
      });
      await consumerRequest('payment-auth/passkeys', 'POST', { challenge_id, response, label: deviceLabel() }, csrf);
      close(); toast('Passkey added.'); await load();
    });
  };
  const remove = (passkeyId: string) => void run(async () => {
    await consumerRequest(`payment-auth/passkeys/${passkeyId}`, 'DELETE', undefined, csrf);
    await load();
  });
  const passwordField = hasPassword && <label>Password
    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
  </label>;
  const digits = (value: string) => value.replace(/\D/g, '').slice(0, 6);

  return <section className="fin-panel fin-payment-security" aria-label="Payment approval">
    <h2>Approve payments</h2>
    <div className="fin-security-row">
      <KeyRound size={20} />
      <div><b>Payment PIN</b><small>{status?.pin_set ? 'On' : 'Not set'}</small></div>
      {mode !== 'pin' && <button className="fin-secondary" type="button" onClick={() => setMode('pin')} disabled={!status}>
        {status?.pin_set ? 'Change' : 'Set PIN'}
      </button>}
    </div>
    {mode === 'pin' && <form className="fin-security-form" onSubmit={savePin}>
      <label>New PIN<input className="fin-pin-input" type="password" inputMode="numeric" autoComplete="off" value={pin}
        onChange={(e) => setPin(digits(e.target.value))} pattern="[0-9]{6}" maxLength={6} required /></label>
      <label>Confirm PIN<input className="fin-pin-input" type="password" inputMode="numeric" autoComplete="off" value={confirmPin}
        onChange={(e) => setConfirmPin(digits(e.target.value))} pattern="[0-9]{6}" maxLength={6} required /></label>
      {passwordField}
      <div className="fin-form-actions">
        <button className="fin-primary" disabled={busy || pin.length !== 6}>Save PIN</button>
        <button className="fin-text" type="button" onClick={close}>Cancel</button>
      </div>
    </form>}
    {passkeysSupported() && <>
      <div className="fin-security-row">
        <Fingerprint size={20} />
        <div><b>Passkeys</b><small>{status?.passkeys.length ? `${status.passkeys.length} added` : 'Face ID, fingerprint or screen lock'}</small></div>
        {mode !== 'passkey' && <button className="fin-secondary" type="button" onClick={() => setMode('passkey')} disabled={!status}>Add</button>}
      </div>
      {mode === 'passkey' && <form className="fin-security-form" onSubmit={addPasskey}>
        {passwordField}
        <div className="fin-form-actions">
          <button className="fin-primary" disabled={busy}>{busy ? 'Waiting for passkey…' : 'Create passkey'}</button>
          <button className="fin-text" type="button" onClick={close}>Cancel</button>
        </div>
      </form>}
      {!!status?.passkeys.length && <ul className="fin-passkeys">
        {status.passkeys.map((key) => <li key={key.id}>
          <span><b>{key.label}</b><small>Added {new Date(key.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</small></span>
          <button className="fin-text" type="button" aria-label={`Remove ${key.label}`} onClick={() => remove(key.id)} disabled={busy}><Trash2 size={16} /></button>
        </li>)}
      </ul>}
    </>}
    {error && <p className="fin-error" role="alert">{error}</p>}
  </section>;
}
