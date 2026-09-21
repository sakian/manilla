import { redirect } from 'next/navigation';

/**
 * An account's transactions are the transactions screen with that account
 * filtered, so this is that link (#unified transaction view). Kept so a bookmark
 * of an account page still lands somewhere useful.
 */
export default async function AccountPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  redirect(`/transactions?account=${id}`);
}
