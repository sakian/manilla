/**
 * Settings, as a menu of a few groups rather than one page of fifteen panels:
 * on a phone the page had become a scroll to find anything.
 *
 * Grouped by who a setting is for, not by how it is built: what is yours on
 * this device, what the household shares, then the ledgers and what sorts
 * their transactions, then the data itself.
 */

export type SettingsGroup = { slug: string; title: string; summary: string };

export const SETTINGS_GROUPS = [
  { slug: 'you', title: 'You', summary: 'Notifications, appearance, passkeys and this session' },
  { slug: 'household', title: 'Household', summary: 'Who can sign in, and every change to that' },
  { slug: 'ledgers', title: 'Ledgers and banks', summary: 'Your ledgers, and the bank feeds into them' },
  { slug: 'sorting', title: 'Sorting transactions', summary: 'Rules, and categorizing with AI' },
  { slug: 'data', title: 'Your data', summary: 'Bring in a history, export or erase, and the version' },
] as const satisfies SettingsGroup[];

export type SettingsSlug = (typeof SETTINGS_GROUPS)[number]['slug'];

export function settingsGroup(slug: SettingsSlug): SettingsGroup {
  return SETTINGS_GROUPS.find((group) => group.slug === slug)!;
}
