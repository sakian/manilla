import type { ReactNode } from 'react';
import Link from 'next/link';
import { currentSession } from './auth.ts';
import { signOutAction } from './login/actions.ts';
import './globals.css';

export const metadata = {
  title: 'Manilla',
  description: 'Envelope budgeting',
};

/**
 * The browser chrome matches the paper the app is printed on, in whichever
 * theme is showing. Without this, adding Manilla to a phone's home screen gives
 * it a white status bar above a dark page.
 */
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf8' },
    { media: '(prefers-color-scheme: dark)', color: '#16150f' },
  ],
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
            <h1 className="wordmark">
              {/* Plain <img>: this is a fixed 26px mark from /public, so Next's
                  image pipeline has nothing to optimise and a layout shift to
                  avoid. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="" width={26} height={26} />
              Manilla
            </h1>
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
