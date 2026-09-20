import { redirect } from 'next/navigation';

/**
 * The envelope list lives on the home screen now (#3), which is where the
 * balances were already being shown. This keeps old links and bookmarks working
 * rather than turning them into a 404.
 */
export default function EnvelopesPage() {
  redirect('/');
}
