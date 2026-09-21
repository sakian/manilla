import { db } from '../../db/client.ts';
import { listAccountCategories } from '../../src/accounts/groups.ts';
import { attention } from '../../src/notices/notices.ts';
import { requireUser } from '../auth.ts';
import { Notices } from '../Notices.tsx';
import AccountManager from './AccountManager.tsx';

/**
 * Accounts, and nothing else (FR-1, FR-3).
 *
 * Transactions belong to an account, so they are on the account's own page - the
 * same way an envelope's history is on the envelope's. This screen answers "what
 * have I got and what is in it".
 */

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  await requireUser();
  const connection = db();

  const [categories, report] = await Promise.all([
    listAccountCategories(connection, { includeArchived: true }),
    attention(connection),
  ]);

  return <AccountManager categories={categories} notices={<Notices report={report} />} />;
}
