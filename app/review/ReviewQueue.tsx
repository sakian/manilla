'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { EnvelopeOption, QueueRow } from '../../src/queue/queue.ts';
import { confirmAction, confirmHighConfidenceAction, recategorizeAction } from '../actions.ts';

function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

function formatDate(date: string): string {
  const [, month, day] = date.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(month) - 1]} ${Number(day)}`;
}

export default function ReviewQueue({
  rows,
  envelopes,
  highCount,
}: {
  rows: QueueRow[];
  envelopes: EnvelopeOption[];
  highCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [cursor, setCursor] = useState(0);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  const [pickCursor, setPickCursor] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  const current = rows[cursor];

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return envelopes;
    // Match on the envelope name first, then the group, so typing "gas" finds
    // Vehicle:Gas without having to remember the group.
    return envelopes.filter(
      (option) =>
        option.name.toLowerCase().includes(needle) ||
        option.groupName.toLowerCase().includes(needle),
    );
  }, [envelopes, filter]);

  const closePicker = useCallback(() => {
    setPicking(false);
    setFilter('');
    setPickCursor(0);
  }, []);

  const confirmOne = useCallback(
    (row: QueueRow) => {
      if (!row.envelopeId) {
        setNote('That row has no envelope yet - choose one first.');
        return;
      }
      startTransition(async () => {
        await confirmAction([row.id]);
        setNote(null);
        router.refresh();
      });
    },
    [router],
  );

  const choose = useCallback(
    (row: QueueRow, envelopeId: string, createRule: boolean) => {
      startTransition(async () => {
        await recategorizeAction(row.id, envelopeId, { createRule });
        closePicker();
        setNote(null);
        router.refresh();
      });
    },
    [router, closePicker],
  );

  const confirmHigh = useCallback(() => {
    startTransition(async () => {
      const { confirmed } = await confirmHighConfidenceAction();
      setNote(
        confirmed === 0
          ? 'Nothing was confident enough to confirm automatically.'
          : `Confirmed ${confirmed} high-confidence ${confirmed === 1 ? 'row' : 'rows'}.`,
      );
      router.refresh();
    });
  }, [router]);

  // Keyboard driving. The queue is the screen the user spends most time in, so
  // the whole loop is reachable without the mouse (RQ-3).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (picking) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closePicker();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPickCursor((index) => Math.min(index + 1, matches.length - 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setPickCursor((index) => Math.max(index - 1, 0));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const option = matches[pickCursor];
          if (option && current) choose(current, option.id, event.shiftKey);
        }
        return;
      }

      // Ignore typing in any other field.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault();
          setCursor((index) => Math.min(index + 1, rows.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          event.preventDefault();
          setCursor((index) => Math.max(index - 1, 0));
          break;
        case 'Enter':
          event.preventDefault();
          if (current) confirmOne(current);
          break;
        case 'e':
          event.preventDefault();
          if (current) {
            setPicking(true);
            setPickCursor(0);
          }
          break;
        case 'a':
          event.preventDefault();
          confirmHigh();
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, matches, pickCursor, current, rows.length, choose, confirmOne, confirmHigh, closePicker]);

  useEffect(() => {
    if (picking) filterRef.current?.focus();
  }, [picking]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>Nothing waiting for review.</p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Import a statement and anything new will appear here.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="queue-toolbar">
        <div className="muted">
          {rows.length} awaiting review
          {highCount > 0 && <> · {highCount} confident enough to confirm in one go</>}
        </div>
        <div className="queue-actions">
          <button onClick={confirmHigh} disabled={pending || highCount === 0}>
            Confirm {highCount} confident <kbd>a</kbd>
          </button>
          <button
            className="primary"
            onClick={() => current && confirmOne(current)}
            disabled={pending || !current}
          >
            Confirm <kbd>↵</kbd>
          </button>
        </div>
      </div>

      {note && <p className="queue-note">{note}</p>}

      <div className="queue" role="list">
        {rows.map((row, index) => {
          const active = index === cursor;
          return (
            <div
              key={row.id}
              role="listitem"
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              className={`queue-row${active ? ' active' : ''}`}
              onClick={() => setCursor(index)}
            >
              <div className="queue-date muted">{formatDate(row.date)}</div>

              <div className="queue-payee">
                <div className="queue-name">{row.payeeDisplay}</div>
                <div className="queue-sub muted">
                  {row.accountName}
                  {row.ageDays >= 7 && <> · waiting {row.ageDays} days</>}
                </div>
              </div>

              <div className={`money queue-amount ${row.amountCents < 0 ? 'neg' : 'pos'}`}>
                {formatMoney(row.amountCents)}
              </div>

              <div className="queue-envelope">
                {row.envelopeName ? (
                  <span className={`chip band-${row.band ?? 'low'}`}>{row.envelopeName}</span>
                ) : (
                  <span className="chip none">Uncategorized</span>
                )}
                {row.reason && <div className="queue-sub muted">{row.reason}</div>}
              </div>

              <div className="queue-row-actions">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setCursor(index);
                    setPicking(true);
                    setPickCursor(0);
                  }}
                >
                  Change <kbd>e</kbd>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {picking && current && (
        <div className="picker-backdrop" onClick={closePicker}>
          <div className="picker" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{current.payeeDisplay}</strong>
              <span className={`money ${current.amountCents < 0 ? 'neg' : 'pos'}`}>
                {formatMoney(current.amountCents)}
              </span>
            </div>
            <input
              ref={filterRef}
              value={filter}
              placeholder="Type to filter envelopes"
              onChange={(event) => {
                setFilter(event.target.value);
                setPickCursor(0);
              }}
            />
            <div className="picker-list">
              {matches.length === 0 && <div className="muted picker-empty">No envelope matches.</div>}
              {matches.map((option, index) => (
                <button
                  key={option.id}
                  className={`picker-option${index === pickCursor ? ' active' : ''}`}
                  onMouseEnter={() => setPickCursor(index)}
                  onClick={(event) => choose(current, option.id, event.shiftKey)}
                >
                  <span className="muted">{option.groupName}</span>
                  <span>{option.name}</span>
                </button>
              ))}
            </div>
            <div className="picker-foot muted">
              <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>↵</kbd> choose · <kbd>shift</kbd>+<kbd>↵</kbd>{' '}
              choose and always use it for this payee · <kbd>esc</kbd> cancel
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
