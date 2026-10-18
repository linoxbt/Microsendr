import React from 'react';
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import type { AuthConfig } from './microsendr-auth.js';
import { qieMainnet } from './qie-chain.js';
import { PersonalPrivySession } from './personal-context.js';

function SessionBridge({ children }: { children: React.ReactNode }) {
  const { logout } = usePrivy();
  return <PersonalPrivySession.Provider value={{ logout }}>{children}</PersonalPrivySession.Provider>;
}

export function PersonalProvider({ config, children }: { config: AuthConfig; children: React.ReactNode }) {
  if (!config.enabled || !config.app_id) return <>{children}</>;
  return <PrivyProvider appId={config.app_id} clientId={config.client_id ?? undefined} config={{
    loginMethods: ['email'],
    embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' }, solana: { createOnLogin: 'off' } },
    supportedChains: [qieMainnet], defaultChain: qieMainnet,
    appearance: { theme: 'light', accentColor: '#4682B4' },
  }}><SessionBridge>{children}</SessionBridge></PrivyProvider>;
}
