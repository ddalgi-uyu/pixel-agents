import { useSyncExternalStore } from 'react';

/** Supported UI languages. */
export type Lang = 'en' | 'zh-TW';
export const LANGS: { code: Lang; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'zh-TW', label: '繁中' },
];

const KEY = 'pixelAgentsLang';

// Translations for the LAN-multiplayer UI (expand as more of the app is covered).
const STR: Record<string, Record<Lang, string>> = {
  whoAreYou: { en: 'Who are you?', 'zh-TW': '你是誰？' },
  pickYourCharacter: {
    en: 'Pick your character — the agent that is you in this office.',
    'zh-TW': '選擇你的角色 — 代表你在這間辦公室的 agent。',
  },
  sayAs: { en: 'Say something as', 'zh-TW': '以此身分發言' }, // + name …
  say: { en: 'Say', 'zh-TW': '發送' },
  changeCharacter: { en: 'Change which character is you', 'zh-TW': '更換你的角色' },
  language: { en: 'Language', 'zh-TW': '語言' },
  skip: { en: 'Skip', 'zh-TW': '略過' },
  noAgentsYet: {
    en: 'No working sessions yet — run `claude` on your machine and it will appear here.',
    'zh-TW': '目前沒有進行中的 session — 在你的電腦執行 `claude`，它就會出現在這裡。',
  },
  pickLater: { en: 'Pick your character', 'zh-TW': '選擇你的角色' },
};

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'zh-TW') return saved;
    if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) {
      return 'zh-TW';
    }
  } catch {
    /* no localStorage */
  }
  return 'en';
}

let current: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

export function t(key: string): string {
  return STR[key]?.[current] ?? STR[key]?.en ?? key;
}

/** Re-render a component when the language changes; returns the `t` function. */
export function useT(): (key: string) => string {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLang,
  );
  return t;
}
