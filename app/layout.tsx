import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'Manilla',
  description: 'Envelope budgeting',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <h1 className="wordmark">Manilla</h1>
            <nav className="nav">
              <Link href="/">Dashboard</Link>
              <Link href="/review">Review</Link>
              <Link href="/accounts">Accounts</Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
