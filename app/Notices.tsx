/**
 * What the screen needs to tell you, in one place at the top.
 *
 * These were scattered: a row of callout tiles, a warning banner under them, and
 * a sentence at the foot of the page about whether the books balanced. Three
 * places to look for "is anything wrong", none of which said so in the same
 * voice.
 *
 * Ordered by how much it matters, not by where the number came from: something
 * genuinely broken, then something overdrawn, then something to get on with. A
 * quiet screen shows nothing at all, which is the point - an empty notices area
 * means there is nothing to do.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

export type Notice = {
  /** `bad` is broken, `warn` needs a decision, `info` is worth knowing. */
  kind: 'bad' | 'warn' | 'info';
  text: ReactNode;
  /** Where the thing being described can be dealt with. */
  href?: string;
};

const RANK: Record<Notice['kind'], number> = { bad: 0, warn: 1, info: 2 };

export function Notices({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null;

  const ordered = [...notices].sort((left, right) => RANK[left.kind] - RANK[right.kind]);

  return (
    <ul className="notices">
      {ordered.map((notice, at) => (
        <li key={at} className={`notice ${notice.kind}`}>
          {notice.href ? <Link href={notice.href}>{notice.text}</Link> : notice.text}
        </li>
      ))}
    </ul>
  );
}
