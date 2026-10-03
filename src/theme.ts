/**
 * Light or dark, chosen per device (#45).
 *
 * The stylesheet has always drawn both themes and followed the system's choice,
 * with a `data-theme` attribute on <html> to override it either way - but
 * nothing set the attribute. This is the choice that does: kept in a cookie,
 * not the database, because a phone at night and a laptop in the morning want
 * different answers and neither should change the other. A cookie rather than
 * local storage so the server can draw the page in the chosen theme to begin
 * with, instead of flashing the system's one first.
 */

export const THEME_COOKIE = 'manilla-theme';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Long enough to outlive any session; browsers cap a cookie at 400 days anyway. */
export const THEME_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/** What the cookie says, or "system" for anything missing or not a choice. */
export function themeFrom(value: string | undefined | null): ThemeChoice {
  return (THEME_CHOICES as readonly string[]).includes(value ?? '') ? (value as ThemeChoice) : 'system';
}

/** The paper colour of each theme, for the browser's own chrome around the page. */
export const THEME_COLORS = { light: '#fbfaf8', dark: '#16150f' } as const;

/**
 * The `<meta name="theme-color">` entries for a choice. Following the system
 * needs one per scheme; a forced theme needs one colour whatever the system says,
 * or a phone in dark mode shows a black status bar above a light page.
 */
export function themeColorFor(choice: ThemeChoice): { media?: string; color: string }[] {
  if (choice === 'system') {
    return [
      { media: '(prefers-color-scheme: light)', color: THEME_COLORS.light },
      { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.dark },
    ];
  }
  return [{ color: THEME_COLORS[choice] }];
}

/** The cookie as the browser sets it: the whole site, sent only to this site. */
export function themeCookie(choice: ThemeChoice, secure: boolean): string {
  const parts = [`${THEME_COOKIE}=${choice}`, 'Path=/', 'SameSite=Lax'];
  parts.push(choice === 'system' ? 'Max-Age=0' : `Max-Age=${THEME_COOKIE_MAX_AGE}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
