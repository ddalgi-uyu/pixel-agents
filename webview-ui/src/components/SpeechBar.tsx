import { useCallback, useState } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import { isBrowserRuntime } from '../runtime.js';
import { transport } from '../transport/index.js';

const ME_KEY = 'pixelAgentsMeId';
const MAX_LEN = 200;

/**
 * A little chat box (standalone browser only): type a line and it pops as a
 * speech bubble above YOUR character. "You" is remembered in localStorage — set
 * it once by selecting your character (click it) and pressing the button.
 */
export function SpeechBar({
  focusedAgentId,
  getOfficeState,
}: {
  focusedAgentId: number | null;
  getOfficeState: () => OfficeState;
}): React.JSX.Element | null {
  const [meId, setMeId] = useState<number | null>(() => {
    const v = localStorage.getItem(ME_KEY);
    return v !== null && v !== '' ? Number(v) : null;
  });
  const [text, setText] = useState('');

  const nameOf = useCallback(
    (id: number | null): string | null => {
      if (id === null) return null;
      const ch = getOfficeState().characters.get(id);
      return ch ? (ch.directoryName ?? `Agent ${id}`) : null;
    },
    [getOfficeState],
  );

  const claim = useCallback((id: number) => {
    localStorage.setItem(ME_KEY, String(id));
    setMeId(id);
  }, []);

  const clearMe = useCallback(() => {
    localStorage.removeItem(ME_KEY);
    setMeId(null);
  }, []);

  const say = useCallback(() => {
    const t = text.trim();
    if (!t || meId === null) return;
    transport.send({ type: 'agentSay', id: meId, text: t.slice(0, MAX_LEN) });
    setText('');
  }, [text, meId]);

  if (!isBrowserRuntime) return null;

  const myName = nameOf(meId);
  const box: React.CSSProperties = {
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
    fontFamily: 'inherit',
  };
  const btn: React.CSSProperties = {
    background: 'var(--color-accent)',
    color: 'var(--color-text-on-accent)',
    border: '2px solid var(--color-border)',
    borderRadius: 0,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 13,
  };

  // Not claimed yet: prompt to pick your character.
  if (meId === null || myName === null) {
    const canClaim = focusedAgentId !== null;
    return (
      <div style={box}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
          {canClaim ? `Set ${nameOf(focusedAgentId)} as you?` : 'Click your character to type as them'}
        </span>
        <button
          style={{ ...btn, opacity: canClaim ? 1 : 0.5, cursor: canClaim ? 'pointer' : 'default' }}
          disabled={!canClaim}
          onClick={() => focusedAgentId !== null && claim(focusedAgentId)}
        >
          This is me
        </button>
      </div>
    );
  }

  return (
    <div style={box}>
      <input
        value={text}
        maxLength={MAX_LEN}
        placeholder={`Say something as ${myName}…`}
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
        Say
      </button>
      <button
        style={{ ...btn, background: 'var(--color-btn-bg)', color: 'var(--color-text)' }}
        title="Pick a different character"
        onClick={clearMe}
      >
        ⟳
      </button>
    </div>
  );
}
