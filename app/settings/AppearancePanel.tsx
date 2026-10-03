'use client';

/**
 * Light, dark, or whatever the system says, for this device only (#45).
 *
 * The choice is a cookie the browser keeps, so it needs no server action: it is
 * written here, shown at once by setting the attribute the stylesheet already
 * keys on, and the refresh is only so the server-drawn parts - the browser's
 * own chrome colour - catch up.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { THEME_CHOICES, themeCookie, type ThemeChoice } from '../../src/theme.ts';

const LABELS: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export default function AppearancePanel({ current }: { current: ThemeChoice }) {
  const router = useRouter();
  const [choice, setChoice] = useState(current);

  const choose = (next: ThemeChoice) => {
    setChoice(next);
    document.cookie = themeCookie(next, window.location.protocol === 'https:');
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    router.refresh();
  };

  return (
    <section className="panel">
      <h3>Appearance</h3>
      <p className="muted">
        For this device only, so a phone can stay dark while a laptop follows the daylight.
      </p>
      <div className="segmented theme-choice" role="group" aria-label="Theme">
        {THEME_CHOICES.map((option) => (
          <button
            key={option}
            type="button"
            className={choice === option ? 'active' : ''}
            aria-pressed={choice === option}
            onClick={() => choose(option)}
          >
            {LABELS[option]}
          </button>
        ))}
      </div>
    </section>
  );
}
