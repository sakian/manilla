import type { ReactNode } from 'react';
import Link from 'next/link';
import { currentSession } from './auth.ts';
import { signOutAction } from './login/actions.ts';
import './globals.css';

export const metadata = {
  title: 'Manilla',
  description: 'Envelope budgeting',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The navigation is only useful once you are in, and the sign-in page has no
  // use for it at all.
  const session = await currentSession();

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <h1 className="wordmark">Manilla</h1>
            {session && (
              <>
                <nav className="nav">
                  <Link href="/">Dashboard</Link>
                  <Link href="/review">Review</Link>
                  <Link href="/budget">Budget</Link>
                  <Link href="/envelopes">Envelopes</Link>
                  <Link href="/accounts">Accounts</Link>
                </nav>
                <form action={signOutAction} className="topbar-end">
                  <Link href="/settings" className="muted">
                    {session.userName}
                  </Link>
                  <button type="submit" className="link-button">
                    Sign out
                  </button>
                </form>
              </>
            )}
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
