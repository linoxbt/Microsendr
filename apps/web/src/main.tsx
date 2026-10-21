import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/dm-sans';
// Stylesheet order matches the original cascade; Personal JS is lazy-loaded below.
import './base.css';
import { LandingPage } from './landing.js';
import './personal.css';
import './consumer.css';
import './microsendr.css';
import { MicrosendrMark, MicrosendrWordmark } from './microsendr-logo.js';

const PersonalPage = lazy(() =>
  import('./personal.js').then((module) => ({ default: module.PersonalPage })),
);

// Retired Business console, developer and sandbox paths all land on Personal sign-in.
const legacyPath = /^\/(?:business|app|connect|login|docs|ramp|sandbox)(?:\/|$)/;
function normalise(value: string) {
  if (legacyPath.test(value)) return '/personal/login';
  if (value === '/' || value === '/personal' || value.startsWith('/personal/')) return value;
  return '/';
}
function usePath() {
  const [path, setPath] = useState(() => normalise(location.pathname));
  useEffect(() => {
    if (normalise(location.pathname) !== location.pathname)
      history.replaceState(null, '', normalise(location.pathname));
    const change = () => {
      const next = normalise(location.pathname);
      if (next !== location.pathname) history.replaceState(null, '', next);
      setPath(next);
    };
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  const go = useCallback((next: string) => {
    const destination = normalise(next);
    history.pushState(null, '', destination);
    setPath(destination);
    window.scrollTo(0, 0);
  }, []);
  return [path, go] as const;
}

function Loading() {
  return (
    <div className="personal-loading" role="status" aria-label="Loading account">
      <span className="personal-loading-mark">
        <MicrosendrMark />
      </span>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('microsendr-theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [path, go] = usePath();
  const [personalAuthenticated, setPersonalAuthenticated] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme =
      path.startsWith('/personal') && personalAuthenticated ? theme : 'light';
    try {
      localStorage.setItem('microsendr-theme', theme);
    } catch {
      /* storage can be unavailable */
    }
  }, [theme, path, personalAuthenticated]);
  const themeToggle = (
    <button
      className="theme-toggle"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? 'Light' : 'Dark'} theme
    </button>
  );
  if (path.startsWith('/personal'))
    return (
      <Suspense fallback={<Loading />}>
        <PersonalPage
          go={go}
          path={path}
          brand={<MicrosendrWordmark />}
          themeToggle={themeToggle}
          onAuthChange={setPersonalAuthenticated}
        />
      </Suspense>
    );
  return <LandingPage brand={<MicrosendrWordmark />} go={go} />;
}
createRoot(document.getElementById('root')!).render(<App />);
