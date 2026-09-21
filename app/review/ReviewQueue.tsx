'use client';

/**
 * The review queue (RQ-1 to RQ-6).
 *
 * Phase 0 measured that only about 16% of transactions can be auto-confirmed
 * safely and roughly 28% of suggestions need correcting, so nearly everything
 * passes under your eye. This screen is therefore the most important one in the
 * app, and going down a list quickly is what it is for.
 *
 * It stages rather than commits. You work down the list marking rows, nothing is
 * written until Save, and a sitting you abandon halfway leaves the ledger exactly
 * as it was. The previous version confirmed each row the moment you touched it,
 * which meant changing your mind about the fourth after seeing the ninth was an
 * edit rather than a decision.
 *
 * A suggestion is only *pre-filled* when the pipeline is confident enough to bet
 * on it (0.95, where measurement put the line). Below that the row starts empty
 * and the suggestion is offered as something to tap - a pre-filled guess reads as
 * an answer, and an unsure guess should not.
 *
 * The bulk "confirm the confident ones" button is gone. It settled about a sixth
 * of a queue without anybody looking, which is a strange thing to offer on a
 * screen whose whole purpose is looking.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { EnvelopeOption, QueueRow } from '../../src/queue/queue.ts';
import { BAND_THRESHOLDS } from '../../src/categorize/pipeline.ts';
import { markAsTransferAction, saveReviewAction } from '../actions.ts';

function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

function longDate(date: string): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, day] = date.split('-');
  return `${names[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/**
 * How sure the pipeline is, in words rather than a bare number.
 *
 * The percentage is kept beside the word because the two say different things: the
 * word is whether to trust it at a glance, the number is how close to the line it
 * sits. "Likely 62%" and "likely 94%" both mean look, but not equally hard.
 */
function confidenceOf(row: QueueRow): { label: string; tone: string; detail: string } | null {
  if (row.confidence === null || !row.envelopeId) {
    return { label: 'no idea', tone: 'none', detail: 'nothing to suggest' };
  }
  const percent = `${Math.round(row.confidence * 100)}%`;
  if (row.confidence >= BAND_THRESHOLDS.high) {
    return { label: 'sure', tone: 'high', detail: percent };
  }
  if (row.confidence >= BAND_THRESHOLDS.medium) {
    return { label: 'likely', tone: 'medium', detail: percent };
  }
  return { label: 'a guess', tone: 'low', detail: percent };
}

type Decision = {
  /** Null means undecided; a row cannot be confirmed without one. */
  envelopeId: string | null;
  confirmed: boolean;
  createRule: boolean;
};

export default function ReviewQueue({
  rows,
  envelopes,
  accounts,
}: {
  rows: QueueRow[];
  envelopes: EnvelopeOption[];
  accounts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Everything decided this sitting, held here until Save. */
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          // Pre-filled only where the pipeline would bet on it.
          envelopeId: row.band === 'high' && row.envelopeId ? row.envelopeId : null,
          confirmed: false,
          createRule: false,
        },
      ]),
    ),
  );

  const [picking, setPicking] = useState<QueueRow | null>(null);
  const [filter, setFilter] = useState('');
  const [pickCursor, setPickCursor] = useState(0);
  const [transferring, setTransferring] = useState<QueueRow | null>(null);
  const [transferRule, setTransferRule] = useState(true);
  const filterRef = useRef<HTMLInputElement>(null);

  const envelopeName = useMemo(
    () => new Map(envelopes.map((envelope) => [envelope.id, envelope.name])),
    [envelopes],
  );

  const decisionFor = useCallback(
    (id: string): Decision =>
      decisions[id] ?? { envelopeId: null, confirmed: false, createRule: false },
    [decisions],
  );

  const set = useCallback((id: string, patch: Partial<Decision>) => {
    setDecisions((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { envelopeId: null, confirmed: false, createRule: false }),
        ...patch,
      },
    }));
  }, []);

  /** Choosing an envelope is a decision, so it confirms the row as well. */
  const choose = useCallback(
    (id: string, envelopeId: string, createRule = false) => {
      set(id, { envelopeId, confirmed: true, createRule });
      setPicking(null);
      setFilter('');
    },
    [set],
  );

  const ready = useMemo(
    () =>
      rows.filter((row) => {
        const decision = decisionFor(row.id);
        return decision.confirmed && decision.envelopeId !== null;
      }),
    [decisionFor, rows],
  );

  const save = useCallback(() => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await saveReviewAction(
        ready.map((row) => {
          const decision = decisionFor(row.id);
          return {
            transactionId: row.id,
            envelopeId: decision.envelopeId!,
            ...(decision.createRule ? { createRule: true } : {}),
          };
        }),
      );

      if (result.failed.length > 0) {
        setError(
          `${result.failed.length} could not be saved: ${result.failed[0]!.error}` +
            (result.failed.length > 1 ? ' (and others)' : ''),
        );
      }
      setNote(
        result.confirmed === 0
          ? 'Nothing was ready to save.'
          : `Saved ${result.confirmed}. ${rows.length - result.confirmed} still waiting.`,
      );
      router.refresh();
    });
  }, [decisionFor, ready, router, rows.length]);

  const markTransfer = useCallback(
    (row: QueueRow, toAccountId: string, createRule: boolean) => {
      setError(null);
      startTransition(async () => {
        const result = await markAsTransferAction(row.id, toAccountId, { createRule });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setTransferring(null);
        setNote('Recorded as a transfer between your accounts.');
        router.refresh();
      });
    },
    [router],
  );

  // Escape closes whichever overlay is open. These are not routed, so the
  // history hook the dialogs use would be overkill for a list picker.
  useEffect(() => {
    if (!picking && !transferring) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPicking(null);
      setTransferring(null);
      setFilter('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking, transferring]);

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return envelopes;
    return envelopes.filter(
      (envelope) =>
        envelope.name.toLowerCase().includes(needle) ||
        envelope.groupName.toLowerCase().includes(needle),
    );
  }, [envelopes, filter]);

  // Rows come back newest first; the headings make the run of dates legible.
  const byDate = useMemo(() => {
    const groups: { date: string; rows: QueueRow[] }[] = [];
    for (const row of rows) {
      const last = groups.at(-1);
      if (last && last.date === row.date) last.rows.push(row);
      else groups.push({ date: row.date, rows: [row] });
    }
    return groups;
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>Nothing to review.</p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Everything imported has an envelope.
        </p>
      </div>
    );
  }

  return (
    <div className="queue">
      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {byDate.map((group) => (
        <div key={group.date} className="queue-day">
          <h3 className="queue-date-head">{longDate(group.date)}</h3>

          {group.rows.map((row) => {
            const decision = decisionFor(row.id);
            const confidence = confidenceOf(row);
            const chosen = decision.envelopeId;
            const suggestion =
              row.envelopeId && row.envelopeId !== chosen ? row.envelopeId : null;

            return (
              <div
                key={row.id}
                className={`queue-row${decision.confirmed ? ' decided' : ''}`}
              >
                <span className="queue-payee">
                  {row.payeeDisplay}
                  {row.memo && <span className="muted"> · {row.memo}</span>}
                </span>

                <span className={`money ${row.amountCents < 0 ? 'neg' : 'pos'}`}>
                  {formatMoney(row.amountCents)}
                </span>

                <span className="muted queue-meta">
                  {row.accountName}
                  {confidence && (
                    <span className={`band ${confidence.tone}`}>
                      {confidence.label} {confidence.detail}
                    </span>
                  )}
                  {row.ageDays > 14 && <span className="tag warn">{row.ageDays} days</span>}
                </span>

                <span className="queue-choice">
                  <button
                    className={`envelope-pick${chosen ? ' chosen' : ''}`}
                    onClick={() => {
                      setPicking(row);
                      setFilter('');
                      setPickCursor(0);
                      setTimeout(() => filterRef.current?.focus(), 0);
                    }}
                    disabled={pending}
                  >
                    {chosen ? envelopeName.get(chosen) : 'Choose an envelope'}
                  </button>

                  {/* The suggestion, when it was not sure enough to fill in. */}
                  {suggestion && !decision.confirmed && (
                    <button
                      className="link-button"
                      onClick={() => choose(row.id, suggestion)}
                      disabled={pending}
                      title={row.reason ?? undefined}
                    >
                      use {envelopeName.get(suggestion)}
                    </button>
                  )}

                  <label className="queue-confirm">
                    <input
                      type="checkbox"
                      checked={decision.confirmed}
                      disabled={pending || chosen === null}
                      onChange={(event) => set(row.id, { confirmed: event.target.checked })}
                    />
                    <span>{decision.confirmed ? 'Confirmed' : 'Confirm'}</span>
                  </label>

                  <button
                    className="link-button"
                    onClick={() => setTransferring(row)}
                    disabled={pending}
                  >
                    not spending
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {/* Sticky, because the list is long and the decision to stop is made at the
          bottom of it as often as the top. */}
      <div className="queue-save">
        <span className="muted">
          {ready.length} of {rows.length} ready
        </span>
        <button className="primary" onClick={save} disabled={pending || ready.length === 0}>
          {pending ? 'Saving…' : `Save ${ready.length}`}
        </button>
      </div>

      {transferring && (
        <div className="picker-backdrop" onClick={() => setTransferring(null)}>
          <div className="picker dialog" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{transferring.payeeDisplay}</strong>
              <span className={`money ${transferring.amountCents < 0 ? 'neg' : 'pos'}`}>
                {formatMoney(transferring.amountCents)}
              </span>
            </div>
            <div className="dialog-body">
              <p className="muted">
                {transferring.amountCents < 0
                  ? 'Which account did it go to?'
                  : 'Which account did it come from?'}{' '}
                Money moving between your own accounts is neither spending nor income, so no
                envelope changes. This one is written straight away rather than waiting for Save,
                because it writes both halves.
              </p>
              <div className="picker-list">
                {accounts
                  .filter((account) => account.name !== transferring.accountName)
                  .map((account) => (
                    <button
                      key={account.id}
                      className="picker-option"
                      onClick={() => markTransfer(transferring, account.id, transferRule)}
                      disabled={pending}
                    >
                      <span>{account.name}</span>
                    </button>
                  ))}
              </div>
            </div>
            <label className="picker-rule">
              <input
                type="checkbox"
                checked={transferRule}
                onChange={(event) => setTransferRule(event.target.checked)}
              />
              <span>
                Always treat <strong>{transferring.payeeDisplay}</strong> on{' '}
                {transferring.accountName} as a transfer
              </span>
            </label>
            <div className="picker-foot dialog-foot">
              <button onClick={() => setTransferring(null)} disabled={pending}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <div
          className="picker-backdrop"
          onClick={() => {
            setPicking(null);
            setFilter('');
          }}
        >
          <div className="picker" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{picking.payeeDisplay}</strong>
              <span className={`money ${picking.amountCents < 0 ? 'neg' : 'pos'}`}>
                {formatMoney(picking.amountCents)}
              </span>
            </div>

            <input
              ref={filterRef}
              value={filter}
              placeholder="Type to narrow"
              onChange={(event) => {
                setFilter(event.target.value);
                setPickCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setPickCursor((at) => Math.min(at + 1, matches.length - 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setPickCursor((at) => Math.max(at - 1, 0));
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const picked = matches[pickCursor];
                  if (picked) choose(picking.id, picked.id, event.shiftKey);
                }
              }}
            />

            <div className="picker-list">
              {matches.length === 0 && (
                <div className="muted picker-empty">No envelope matches.</div>
              )}
              {matches.map((envelope, index) => (
                <button
                  key={envelope.id}
                  className={`picker-option${index === pickCursor ? ' active' : ''}`}
                  onClick={(event) => choose(picking.id, envelope.id, event.shiftKey)}
                  onMouseEnter={() => setPickCursor(index)}
                >
                  <span>{envelope.name}</span>
                  <span className="muted">{envelope.groupName}</span>
                </button>
              ))}
            </div>

            <div className="picker-foot muted">
              <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>↵</kbd> choose ·{' '}
              <kbd>shift</kbd>+<kbd>↵</kbd> choose and always use it for this payee ·{' '}
              <kbd>esc</kbd> cancel
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
