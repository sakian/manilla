import { homeDb } from '../../../db/client.ts';
import { requireUser } from '../../auth.ts';
import { listMembers, listPendingInvites } from '../../../src/auth/invites.ts';
import { recentActivity } from '../../../src/auth/activity.ts';
import SettingsHead from '../SettingsHead.tsx';
import People from '../People.tsx';
import SignInActivity from '../SignInActivity.tsx';

export const dynamic = 'force-dynamic';

/** Who can sign in, and every change to that. */
export default async function HouseholdSettings() {
  const session = await requireUser();
  const [members, invites, activity] = await Promise.all([
    listMembers(homeDb()),
    listPendingInvites(homeDb()),
    recentActivity(homeDb()),
  ]);

  return (
    <>
      <SettingsHead slug="household" />
      <People members={members} invites={invites} currentUserId={session.userId} />
      <SignInActivity events={activity} />
    </>
  );
}
