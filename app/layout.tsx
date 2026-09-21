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
                {/*
                  Three places. Seven did not fit across a phone - the bar had no
                  wrap, so it pushed every page sideways - and most of them were
                  not destinations anyway. Import is a button where the statements
                  go, Review is reached from the notice that says there is
                  something to review, and Migrate lives in Settings because it
                  happens once.
                */}
                <nav className="nav">
                  <Link href="/">Envelopes</Link>
                  <Link href="/accounts">Accounts</Link>
                  <Link href="/transactions">Transactions</Link>
                  <Link href="/reports">Reports</Link>
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
