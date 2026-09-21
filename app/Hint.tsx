'use client';

/**
 * An explanation you can ask for.
 *
 * Every screen had a paragraph under its heading explaining what the screen was.
 * That is worth reading once. After that it is furniture between you and the
 * numbers, on every visit, and on a phone it pushed the first envelope below the
 * fold. So the prose moves behind a marker you can press.
 *
 * A real `<button>` with `aria-expanded`, not a hover tooltip: hover does not
 * exist on a phone, and a tooltip cannot be read by anything that is not a mouse.
 * The text is in the markup either way, so it is searchable and reachable.
 */

import { useState, type ReactNode } from 'react';

export function Hint({ children, label }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);

  return (
    // Inside a <summary>, a click anywhere here would also open or close the
    // disclosure it heads. Nothing else in a hint has a default worth keeping,
    // except a link someone put in the explanation.
    <span
      className="hint"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest('a')) event.preventDefault();
      }}
    >
      <button
        type="button"
        className="hint-toggle"
        aria-expanded={open}
        aria-label={label ?? 'Explain this screen'}
        title={label ?? 'Explain this screen'}
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open && <span className="hint-body muted">{children}</span>}
    </span>
  );
}
