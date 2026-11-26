import { useCallback, useState } from 'react';

import { useT } from '../i18n.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';

const MAX_LEN = 200;

/**
 * A little chat box (standalone browser only): type a line and it pops as a
 * speech bubble above YOUR character. "You" is chosen once via the WhoAreYou
 * picker (App owns `meId`); the ⟳ button re-opens it.
 */
export function SpeechBar({
  meId,
  getOfficeState,
  onChangeCharacter,
}: {
  meId: number | null;
  getOfficeState: () => OfficeState;
  onChangeCharacter: () => void;
}): React.JSX.Element | null {
  const t = useT();
  const [text, setText] = useState('');

  const say = useCallback(() => {
    const t = text.trim();
    if (!t || meId === null) return;
    transport.send({ type: 'agentSay', id: meId, text: t.slice(0, MAX_LEN) });
    setText('');
  }, [text, meId]);

  if (!isBrowserRuntime || meId === null) return null;

  const myName = getOfficeState().characters.get(meId)?.directoryName ?? `Agent ${meId}`;
  const btn: React.CSSProperties = {
    background: 'var(--color-accent)',
    color: 'var(--color-text-on-accent)',
    border: '2px solid var(--color-border)',
    borderRadius: 0,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 13,
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 12,
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        background: 'var(--color-panel)',
        border: '2px solid var(--color-border)',
        boxShadow: '2px 2px 0px var(--color-bg-dark)',
        padding: 6,
      }}
    >
      <input
        value={text}
        maxLength={MAX_LEN}
        placeholder={`${t('sayAs')} ${myName}…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') say();
        }}
        style={{
          width: 260,
          background: 'var(--color-bg-dark)',
          color: 'var(--color-text)',
          border: '2px solid var(--color-border)',
          borderRadius: 0,
          padding: '4px 8px',
          fontSize: 13,
        }}
      />
      <button style={btn} onClick={say}>
        {t('say')}
      </button>
      <button
        style={{ ...btn, background: 'var(--color-btn-bg)', color: 'var(--color-text)' }}
        title={t('changeCharacter')}
        onClick={onChangeCharacter}
      >
        ⟳
      </button>
    </div>
  );
}
