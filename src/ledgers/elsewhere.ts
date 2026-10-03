/**
 * Whether a bank account already belongs to another ledger (LG-4).
 *
 * A statement names its account by number, and each ledger remembers which of
 * its accounts a number maps to (FR-7). With two ledgers, the likeliest mistake
 * is importing one ledger's statement while the other is open - the number is
 * unknown here, so the import screen would ask which account it is, and
 * whatever was picked would record the money in the wrong books. Asking the
 * other ledgers first turns that into a sentence saying where it belongs.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts } from '../../db/schema.ts';
import type { Ledger } from './config.ts';

export type MappedElsewhere = { ledger: Ledger; accountName: string };

export async function mappedElsewhere(
  ledgers: Ledger[],
  current: Ledger,
  externalAccountId: string,
  connectionFor: (database: string) => Database,
): Promise<MappedElsewhere[]> {
  const found: MappedElsewhere[] = [];
  for (const ledger of ledgers) {
    if (ledger.key === current.key) continue;
    const [account] = await connectionFor(ledger.database)
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.externalAccountId, externalAccountId))
      .limit(1);
    if (account) found.push({ ledger, accountName: account.name });
  }
  return found;
}
