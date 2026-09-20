import { redirect } from 'next/navigation';

/**
 * Search lives on the screens that list transactions now (#13), not on its own
 * page. The account view with no account picked is every transaction, so that is
 * where this goes - carrying the filters, so a link saved from the old page still
 * shows what it showed.
 */
export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      if (item.trim()) query.append(key, item);
    }
  }

  const text = query.toString();
  redirect(text ? `/accounts?${text}` : '/accounts');
}
