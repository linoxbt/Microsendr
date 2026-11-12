import React, { useEffect, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import { consumerRequest } from './consumer-api.js';

export type Recipient = { address: string; label: string; username?: string };
export const recipientPattern = '(0x[a-fA-F0-9]{40}|@?[a-zA-Z][a-zA-Z0-9_]{2,23})';
const usernamePattern = /^@?[a-zA-Z][a-zA-Z0-9_]{2,23}$/;

/**
 * Resolves what the user typed into a send form: a 0x address as is, or an
 * @username through the opt-in Microsendr directory. The label tells the user who
 * they are paying before they confirm.
 */
export function useRecipient(value: string) {
  const [state, setState] = useState<{ recipient?: Recipient; error?: string; loading: boolean }>({ loading: false });
  useEffect(() => {
    const input = value.trim();
    if (!input) { setState({ loading: false }); return; }
    if (isAddress(input)) { setState({ loading: false, recipient: { address: getAddress(input), label: `${input.slice(0, 6)}…${input.slice(-4)}` } }); return; }
    if (!usernamePattern.test(input)) { setState({ loading: false }); return; }
    let active = true;
    setState({ loading: true });
    const timer = setTimeout(() => {
      consumerRequest<{ address: string; display_name: string; username: string }>(`recipients/${encodeURIComponent(input.replace(/^@/, '').toLowerCase())}`)
        .then((found) => { if (active) setState({ loading: false, recipient: { address: getAddress(found.address), label: `${found.display_name} (@${found.username})`, username: found.username } }); })
        .catch((cause) => {
          if (!active) return;
          const code = (cause as { code?: string }).code;
          const name = input.replace(/^@/, '').toLowerCase();
          setState({ loading: false, error: code === 'recipient_unavailable' || /No Microsendr user/.test((cause as Error).message)
            ? `@${name} can't receive by username yet.` : (cause as Error).message });
        });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [value]);
  return state;
}

export function RecipientStatus({ state }: { state: ReturnType<typeof useRecipient> }) {
  if (state.loading) return <p className="fin-recipient" role="status">Finding recipient…</p>;
  if (state.error) return <p className="fin-recipient fin-recipient-error" role="alert">{state.error}</p>;
  if (state.recipient?.username) return <p className="fin-recipient" role="status">Paying <b>{state.recipient.label}</b> at {state.recipient.address.slice(0, 8)}…{state.recipient.address.slice(-6)}</p>;
  return null;
}
