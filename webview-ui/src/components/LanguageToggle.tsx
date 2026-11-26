import { getLang, LANGS, setLang, useT } from '../i18n.js';
import { isBrowserRuntime } from '../runtime.js';

/** A small EN / 繁中 language switcher (standalone browser). */
export function LanguageToggle(): React.JSX.Element | null {
  useT(); // re-render when the language changes
  if (!isBrowserRuntime) return null;
  const cur = getLang();
  return (
    <div
      style={{
        position: 'fixed',
        top: 108, // below the zoom +/- buttons (top-left stack)
        left: 10,
        zIndex: 60,
        display: 'flex',
        border: '2px solid var(--color-border)',
        boxShadow: '2px 2px 0px var(--color-bg-dark)',
      }}
    >
      {LANGS.map((l) => (
        <button
          key={l.code}
          onClick={() => setLang(l.code)}
          style={{
            background: l.code === cur ? 'var(--color-accent)' : 'var(--color-panel)',
            color: l.code === cur ? 'var(--color-text-on-accent)' : 'var(--color-text)',
            border: 'none',
            borderRadius: 0,
            padding: '3px 9px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
