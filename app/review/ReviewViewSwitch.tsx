'use client';

/**
 * For me or All (RQ-7): what was handed to you, or everything waiting.
 *
 * In the address rather than kept here, so the list is loaded for the view
 * chosen, back goes to the other one, and a notification can open either.
 */

import { useRouter } from 'next/navigation';

export default function ReviewViewSwitch({
  view,
  mine,
  all,
}: {
  view: 'all' | 'mine';
  mine: number;
  all: number;
}) {
  const router = useRouter();
  const options = [
    ['mine', `For me (${mine.toLocaleString()})`],
    ['all', `All (${all.toLocaleString()})`],
  ] as const;
  return (
    <div className="segmented review-view" role="group" aria-label="Which transactions to show">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={view === value ? 'active' : ''}
          aria-pressed={view === value}
          onClick={() => router.push(`/review?view=${value}`)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
