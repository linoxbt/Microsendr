import { Moon, Sun } from 'lucide-react';
import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/dm-sans';
// Stylesheet order matches the original cascade; Personal JS is lazy-loaded below and
// brings the app stylesheet (consumer.css) with it, so the landing page never loads it.
import './base.css';
import { LandingPage } from './landing.js';
import './personal.css';
import './roots.css';
import { RootsMark, RootsWordmark } from './roots-logo.js';

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
        <RootsMark />
      </span>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('roots-theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [path, go] = usePath();
  const [personalAuthenticated, setPersonalAuthenticated] = useState(false);
  useEffect(() => {
    const active = path.startsWith('/personal') && personalAuthenticated ? theme : 'light';
    document.documentElement.dataset.theme = active;
    // The phone's status and address bar follow the app's theme, not only the system's.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]'))
      meta.setAttribute('content', active === 'dark' ? '#172d40' : '#f7f3e9');
    try {
      localStorage.setItem('roots-theme', theme);
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
      {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
      <span className="theme-toggle-label">{theme === 'dark' ? 'Light' : 'Dark'} theme</span>
    </button>
  );
  if (path.startsWith('/personal'))
    return (
      <Suspense fallback={<Loading />}>
        <PersonalPage
          go={go}
          path={path}
          brand={<RootsWordmark />}
          themeToggle={themeToggle}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          onAuthChange={setPersonalAuthenticated}
        />
      </Suspense>
    );
  return <LandingPage brand={<RootsWordmark />} go={go} />;
}
createRoot(document.getElementById('root')!).render(<App />);
