import Link from 'next/link';
import type { ReactNode } from 'react';
import { settingsGroup, type SettingsSlug } from './groups.ts';

/** A group's heading, with the way back to the menu above it. */
export default function SettingsHead({ slug, status }: { slug: SettingsSlug; status?: ReactNode }) {
  return (
    <div className="page-head">
      <Link href="/settings" className="settings-back">
        ‹ Settings
      </Link>
      <h2>{settingsGroup(slug).title}</h2>
      {status && <p className="muted page-status">{status}</p>}
    </div>
  );
}
