import { useT } from '../i18n.js';
import type { OfficeState } from '../office/engine/officeState.js';

/**
 * Startup picker (standalone browser): "Who are you?" — choose which agent /
 * character is you in this shared office. One person, one character, chosen at
 * the beginning. The choice is remembered per browser (localStorage, owned by App).
 */
export function WhoAreYou({
  agentIds,
  getOfficeState,
  onPick,
  onSkip,
}: {
  agentIds: number[];
  getOfficeState: () => OfficeState;
  onPick: (id: number) => void;
  onSkip: () => void;
}): React.JSX.Element | null {
  const t = useT();
  const label = (id: number): string =>
    getOfficeState().characters.get(id)?.directoryName ?? `Agent ${id}`;

  return (
    <div
      className="bg-black/60"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        className="border-2 p-5"
        style={{
          background: 'var(--color-panel)',
          borderColor: 'var(--color-border)',
          boxShadow: '2px 2px 0px var(--color-bg-dark)',
          width: 'min(560px, 92vw)', // responsive on narrow windows
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ color: 'var(--color-text)', fontSize: 18, marginBottom: 4 }}>
          {t('whoAreYou')}
        </div>
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 14 }}>
          {t('pickYourCharacter')}
        </div>
        {agentIds.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 13, marginBottom: 12 }}>
            {t('noAgentsYet')}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {agentIds.map((id) => (
            <button
              key={id}
              onClick={() => onPick(id)}
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-text-on-accent)',
                border: '2px solid var(--color-border)',
                borderRadius: 0,
                padding: '8px 14px',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              {label(id)}
            </button>
          ))}
          <button
            onClick={onSkip}
            style={{
              background: 'var(--color-btn-bg)',
              color: 'var(--color-text-muted)',
              border: '2px solid var(--color-border)',
              borderRadius: 0,
              padding: '8px 14px',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {t('skip')}
          </button>
        </div>
      </div>
    </div>
  );
}
