import React, { useEffect, useState } from 'react';
import type { AuthConfig, AuthProps } from './microsendr-auth.js';
const Auth = React.lazy(() => import('./microsendr-auth.js').then(module => ({ default: module.MicrosendrAuth })));
const SharedAuth = React.lazy(() => import('./microsendr-auth.js').then(module => ({ default: module.MicrosendrAuthForm })));
export function MicrosendrAuth(props: AuthProps & { config?: AuthConfig; sharedProvider?: boolean }) {
  const [fetchedConfig, setFetchedConfig] = useState<AuthConfig>();
  useEffect(() => {
    if (props.config) return;
    void fetch(props.mode === 'personal' ? '/personal/api/auth/config' : '/console/auth/config').then(response => response.json()).then(setFetchedConfig).catch(() => setFetchedConfig({ enabled: false }));
  }, [props.mode, props.config]);
  const config = props.config ?? fetchedConfig;
  if (!config) return <p className="personal-muted">Loading sign-in…</p>;
  if (!config.enabled || !config.app_id) return <div className="ms-auth-form ms-auth-unavailable" role="status">
    <label>Email address<input type="email" placeholder="you@example.com" disabled /></label>
    <button className="personal-primary" disabled>Continue with email</button>
    <p>Sign-in is being set up. Please check back soon.</p>
  </div>;
  return <React.Suspense fallback={<p className="personal-muted">Loading sign-in…</p>}>{props.sharedProvider ? <SharedAuth {...props}/> : <Auth {...props} config={config}/>}</React.Suspense>;
}
