/**
 * Which apps a history can be brought in from (MG-1).
 *
 * One entry today. It exists as a registry anyway for two reasons: the wizard can
 * say plainly what it understands instead of leaving the user to find out by
 * uploading, and the format-specific facts are named in one place rather than
 * being constants scattered through the reader.
 *
 * Nothing user-facing names an app except this table and the control that reads
 * it. The rest of Manilla - the notes written into envelope history, the wizard's
 * prose, the README - stays neutral, so adding a second format is a row here plus
 * a reader, not a pass over every string in the app.
 *
 * Adding one honestly means more than adding a row: `planMigration` reads rows in
 * the shape this format uses (a `Group:Name` envelope column, splits in a
 * `Details` column, transfers as two matched rows). A format that differs needs
 * its own reader feeding the same `MigrationPlan`. The seam is here; the work is
 * not pretended away.
 */

export const MIGRATION_SOURCES = [
  {
    id: 'goodbudget',
    /** Shown in the wizard, and the only place an app is named to the user. */
    label: 'GoodBudget',
    /** How to get the file, so nobody has to guess which export is the right one. */
    hint: 'Settings → Export, which emails you a CSV. Several files can go in at once if yours was split by date.',
    /**
     * The full export records each fill with no amount, so envelope balances
     * cannot be rebuilt from it. Exporting an envelope or a category on its own
     * writes every fill with its amount - the one place the app does.
     */
    fillsHint:
      'The full export leaves out what was put into each envelope. To bring that too, select each category (or envelope) in the app, choose Export CSV, and add those files alongside the full export - they can all go in together.',
    /**
     * What this format calls its unallocated pool. Income landing here is income
     * rather than spending, and it maps onto Manilla's own pool (FR-28).
     */
    poolEnvelope: '[Available]',
  },
] as const;

export type MigrationSourceId = (typeof MIGRATION_SOURCES)[number]['id'];
export type MigrationSource = (typeof MIGRATION_SOURCES)[number];

/** The one a wizard starts on. */
export const DEFAULT_SOURCE: MigrationSourceId = 'goodbudget';

export function isMigrationSource(value: string): value is MigrationSourceId {
  return MIGRATION_SOURCES.some((source) => source.id === value);
}

export function migrationSource(id: string): MigrationSource {
  const found = MIGRATION_SOURCES.find((source) => source.id === id);
  if (!found) {
    throw new Error(
      `Not an app Manilla can migrate from: ${id}. ` +
        `Supported: ${MIGRATION_SOURCES.map((source) => source.id).join(', ')}`,
    );
  }
  return found;
}
