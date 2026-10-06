import 'server-only';

/**
 * Tell the rest of the household what a server action just changed (see
 * src/push/edits.ts). Called once the change is written, and sent after the
 * answer, so a slow push service never holds up the screen.
 */

import { after } from 'next/server';
import { homeDb } from '../db/client.ts';
import { allLedgers, currentLedger } from './ledger.ts';
import { tellAboutEdit, type EditNotice } from '../src/push/edits.ts';

export async function tellOthers(
  session: { userId: string; userName: string },
  ...notices: EditNotice[]
): Promise<void> {
  const worth = notices.filter((notice) => notice.count > 0);
  if (worth.length === 0) return;
  // Read now, while the request is still here; `after` runs once it is gone.
  const [ledgers, open] = await Promise.all([allLedgers(), currentLedger()]);
  const ledger = ledgers.length > 1 ? { key: open.key, name: open.name } : undefined;
  after(async () => {
    for (const notice of worth) {
      const { sent } = await tellAboutEdit(homeDb(), {
        actor: { id: session.userId, name: session.userName },
        notice,
        ...(ledger ? { ledger } : {}),
      });
      await sent;
    }
  });
}
