'use client';

/**
 * The one way to choose an envelope for a transaction: a box to narrow it, a row
 * of category names to jump by, and every envelope under its heading (RQ-3).
 * The review queue's picker and each part of a split, there and in the
 * transaction dialog, are all this list, so it reads and types the same
 * wherever a transaction is given an envelope.
 *
 * The filter box was taken out once, on the grounds that fifty envelopes under
 * nine headings can be read and scanning beats typing when you do not know the
 * exact name. Use said otherwise (issue #32): scrolling to find the one you know
 * is slow. So both ways are here, and neither hides the other - the list is whole
 * until you type, and the categories are jumped to rather than folded away, since
 * folding them would make every choice two presses and require knowing which
 * category an envelope lives in, which is the same thing typing asks.
 *
 * Mounted afresh for each row, so every opening starts with an empty box.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EnvelopeOption } from '../src/queue/queue.ts';
import { narrowEnvelopes } from '../src/queue/narrow.ts';

export default function EnvelopeChoices({
  envelopes,
  activeId,
  onChoose,
  children,
}: {
  envelopes: EnvelopeOption[];
  /** The envelope the row has now, marked in the list. */
  activeId: string | null;
  onChoose: (envelopeId: string, createRule: boolean) => void;
  /** What sits above the envelopes - the suggestion and "not spending" - and stays put while typing. */
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  /** Which match Enter takes; none until something is typed or an arrow pressed. */
  const [cursor, setCursor] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => narrowEnvelopes(envelopes, query), [envelopes, query]);
  const matches = useMemo(() => groups.flatMap((group) => group.envelopes), [groups]);
  const narrowed = query.trim() !== '';
  const highlighted = cursor === null ? null : (matches[cursor]?.id ?? null);

  // Focused straight away only where there is a keyboard to type with. On a
  // phone it would raise the keyboard over half a list that is quicker to tap.
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector('.picker-option.cursor')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const jumpTo = (index: number) => {
    const list = listRef.current;
    const block = list?.querySelector(`[data-group="${index}"]`);
    if (!list || !block) return;
    list.scrollTo({
      top: list.scrollTop + block.getBoundingClientRect().top - list.getBoundingClientRect().top,
      behavior: 'smooth',
    });
  };

  return (
    <>
      <div className="picker-find">
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Find an envelope"
          aria-label="Find an envelope"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="go"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(event.target.value.trim() ? 0 : null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((current) =>
                current === null ? 0 : Math.min(current + 1, matches.length - 1),
              );
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((current) => (current === null ? 0 : Math.max(current - 1, 0)));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (highlighted) onChoose(highlighted, event.shiftKey);
            } else if (event.key === 'Escape' && query) {
              // Escape empties the box first and closes the picker second; the
              // overlay listens on the window, so stopping here keeps it open.
              event.stopPropagation();
              setQuery('');
              setCursor(null);
            }
          }}
        />
        {!narrowed && groups.length > 1 && (
          <div className="picker-jumps">
            {groups.map((group, index) => (
              <button key={group.name} className="picker-jump" onClick={() => jumpTo(index)}>
                {group.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="picker-list" ref={listRef}>
        {children}

        {groups.map((group, index) => (
          <div key={group.name} className="picker-group-block" data-group={index}>
            <div className="picker-group-head">{group.name}</div>
            {group.envelopes.map((envelope) => (
              <button
                key={envelope.id}
                className={`picker-option${envelope.id === activeId ? ' active' : ''}${
                  envelope.id === highlighted ? ' cursor' : ''
                }`}
                onClick={(event) => onChoose(envelope.id, event.shiftKey)}
              >
                <span className="picker-name">{envelope.name}</span>
              </button>
            ))}
          </div>
        ))}

        {narrowed && matches.length === 0 && (
          <p className="muted picker-none">No envelope matches “{query.trim()}”.</p>
        )}
      </div>
    </>
  );
}
