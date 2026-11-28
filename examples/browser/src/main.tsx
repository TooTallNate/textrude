import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Cookie, Type } from 'lucide-react';
import './app.css';
import App from './App';
import StampApp from './StampApp';
import { cn } from './lib/utils';

type Mode = 'text' | 'stamp';

/** Text prints, or cookie stamps from an SVG (?mode=stamp). */
function Root() {
  const [mode, setMode] = useState<Mode>(() => (new URLSearchParams(location.search).get('mode') === 'stamp' ? 'stamp' : 'text'));
  const switchTo = (next: Mode) => {
    if (next === mode) return;
    const params = new URLSearchParams(location.search);
    if (next === 'stamp') params.set('mode', 'stamp');
    else params.delete('mode');
    // Each mode keeps its own settings in the hash; the other mode's wait in session storage.
    sessionStorage.setItem(`textrude-hash-${mode}`, location.hash);
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + (sessionStorage.getItem(`textrude-hash-${next}`) ?? ''));
    setMode(next);
  };
  const tabs = (
    <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-900 p-0.5" role="tablist">
      {(
        [
          ['text', 'Text', Type],
          ['stamp', 'Stamp', Cookie],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          title={value === 'text' ? 'Text and emoji to multi-color prints' : 'An SVG to a cookie stamp and cutter'}
          onClick={() => switchTo(value)}
          className={cn(
            'flex h-6.5 cursor-pointer items-center gap-1 rounded px-2 text-xs whitespace-nowrap transition-colors',
            mode === value ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200',
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
  return mode === 'stamp' ? <StampApp modeTabs={tabs} /> : <App modeTabs={tabs} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
