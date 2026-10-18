import { useEffect, useState } from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';

type Kyc = {
  email_verified: boolean;
  status: string;
  url: string | null;
  updated_at: string | null;
  configured: boolean;
};
const message: Record<string, string> = {
  'Not Started': 'Identity verification has not started.',
  'In Progress': 'Continue your identity check.',
  'Awaiting User': 'Your identity check needs more information.',
  'In Review': 'Your documents are being reviewed.',
  Approved: 'Your identity has been verified.',
  Declined: 'Identity check declined. Contact support if you believe this is an error.',
  Resubmitted: 'Please complete the requested verification steps.',
  Abandoned: 'Your previous check was not completed.',
  Expired: 'Your previous check expired.',
  'Kyc Expired': 'Your identity check expired. Start a new one.',
};

export function PersonalKyc({ csrf }: { csrf?: string }) {
  const [kyc, setKyc] = useState<Kyc>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    const response = await fetch('/personal/api/kyc', { credentials: 'include' });
    if (!response.ok) throw new Error('Verification status is unavailable');
    setKyc(await response.json());
  }
  useEffect(() => {
    void refresh().catch((cause) => setError(cause.message));
    const timer = setInterval(() => void refresh().catch(() => undefined), 15000);
    return () => clearInterval(timer);
  }, []);
  async function start() {
    setBusy(true);
    setError('');
    try {
      let url = kyc?.url;
      if (!url) {
        const response = await fetch('/personal/api/kyc/session', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-kora-csrf': csrf ?? '' },
          body: JSON.stringify({ consent: true }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? 'Verification could not start');
        url = body.url;
      }
      const { DiditSdk } = await import('@didit-protocol/sdk-web');
      DiditSdk.shared.onComplete = () => {
        // The signed webhook, never this client callback, decides the status.
        void refresh().catch(() => undefined);
      };
      DiditSdk.shared.startVerification({ url: url! });
      void refresh().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification could not start');
    } finally {
      setBusy(false);
    }
  }
  const canStart =
    !!kyc?.configured &&
    !!kyc.email_verified &&
    !['Approved', 'Declined', 'In Review', 'creating'].includes(kyc.status);
  return (
    <section className="personal-card personal-kyc">
      <div className="personal-kyc-title">
        <ShieldCheck size={21} />
        <h2>Identity verification</h2>
      </div>
      <p>
        {!kyc?.configured
          ? 'Identity verification is being set up.'
          : (message[kyc.status] ?? 'Verification status: ' + kyc.status)}
      </p>
      {kyc?.configured && !kyc.email_verified && (
        <p>Verify your email in Account → Security before starting your identity check.</p>
      )}
      <small>
        Verification is provided by Didit. Payment availability depends on your account and
        location.
      </small>
      {canStart && (
        <>
          <label className="personal-kyc-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I agree to share my identity document and selfie with Didit for verification. See{' '}
              <a href="https://didit.me/privacy-policy" target="_blank" rel="noreferrer">
                Didit’s privacy policy
              </a>
              .
            </span>
          </label>
          <button
            type="button"
            className="personal-primary"
            disabled={!consent || busy}
            onClick={() => void start()}
          >
            {busy ? 'Opening…' : kyc?.url ? 'Continue verification' : 'Verify identity'}{' '}
            <ArrowRight size={17} />
          </button>
        </>
      )}
      {error && (
        <p className="personal-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
