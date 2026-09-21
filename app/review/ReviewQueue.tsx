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
 * on it (0.95, where measurement put the line). Below that the row starts empty,
 * because a pre-filled guess reads as an answer and an unsure guess should not -
 * the guess is still there, at the top of the picker, where it is offered rather
 * than assumed.
 *
 * One control per card decides everything: pressing the envelope opens a picker
 * that also holds "not spending", because "which envelope" and "no envelope at
 * all" are the same question. Word-links beside it were a second way to do what
 * the picker does.
 *
 * The bulk "confirm the confident ones" button is gone. It settled about a sixth
 * of a queue without anybody looking, which is a strange thing to offer on a
 * screen whose whole purpose is looking.
 */

import { Fragment, useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { EnvelopeOption, QueueRow, TransferCandidate } from '../../src/queue/queue.ts';
import { BAND_THRESHOLDS } from '../../src/categorize/pipeline.ts';
import { markAsTransferAction, pairTransferAction, saveReviewAction } from '../actions.ts';
import { formatMoney } from '../../src/money.ts';
import { useOverlay } from '../useOverlay.ts';

function longDate(date: string): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [year, month, day] = date.split('-');
  return `${names[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/**
 * How sure the pipeline is: one word and a number.
 *
 * One word because it is read at a glance down a column, and a column of phrases
 * is a paragraph. The number stays beside it because the two say different things
 * - the word is whether to trust it, the number is how close to the line it sits.
 * "Likely 62" and "likely 94" both mean look, but not equally hard.
 */
function confidenceOf(row: QueueRow): { label: string; tone: string; detail: string } {
  if (row.confidence === null || !row.envelopeId) {
    return { label: 'unknown', tone: 'none', detail: '' };
  }
  // A rule is a standing instruction you wrote, not a guess anybody made, so it
  // is not given a percentage to argue with.
  if (row.layer === 'rule') return { label: 'rule', tone: 'high', detail: '' };

  const percent = `${Math.round(row.confidence * 100)}%`;
  if (row.confidence >= BAND_THRESHOLDS.high) return { label: 'sure', tone: 'high', detail: percent };
  if (row.confidence >= BAND_THRESHOLDS.medium) {
    return { label: 'likely', tone: 'medium', detail: percent };
  }
  return { label: 'guess', tone: 'low', detail: percent };
}

type Decision = {
  /** Null means undecided; a row cannot be confirmed without one. */
  envelopeId: string | null;
  confirmed: boolean;
  createRule: boolean;
};

/** Whether the bank's text carries anything the cleaned-up name dropped. */
function saysMore(row: QueueRow): boolean {
  const squeeze = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return squeeze(row.payeeRaw) !== squeeze(row.payeeDisplay);
}

export default function ReviewQueue({
  rows,
  envelopes,
  transfers,
  accounts,
}: {
  rows: QueueRow[];
  envelopes: EnvelopeOption[];
  /** Rows that look like half of a transfer, found rather than declared. */
  transfers: TransferCandidate[];
  accounts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Everything decided this sitting, held here until Save. */
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          // Anything proposed at all is filled in. The reason for holding back
          // was that an unsure guess reads as an answer - but the card says how
          // sure it is right beside the name, so it reads as what it is, and
          // starting from a guess beats starting from nothing on every row.
          envelopeId: row.envelopeId,
          confirmed: false,
          createRule: false,
        },
      ]),
    ),
  );

  /**
   * Which row's picker is open lives in the URL, so back closes it. The
   * navigation is shallow, so a sitting's worth of staged decisions is not
   * disturbed by opening one (see `useOverlay`).
   */
  const overlay = useOverlay('pick', ['to']);
  const picking = useMemo(
    () => rows.find((row) => row.id === overlay.value) ?? null,
    [overlay.value, rows],
  );
  /** The picker shows envelopes first, and the account list once "not spending". */
  const pickingTransfer = searchParams.get('to') === 'account';
  const [transferRule, setTransferRule] = useState(true);

  const transferFor = useMemo(
    () => new Map(transfers.map((candidate) => [candidate.transactionId, candidate])),
    [transfers],
  );

  /** How many are waiting in each account, for its heading. */
  const perAccount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
    return counts;
  }, [rows]);

  const envelopeById = useMemo(
    () => new Map(envelopes.map((envelope) => [envelope.id, envelope])),
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

  const openPicker = useCallback(
    (row: QueueRow) => {
      overlay.open(row.id);
    },
    [overlay],
  );

  const closePicker = overlay.close;

  /** Choosing an envelope is a decision, so it confirms the row as well. */
  const choose = useCallback(
    (id: string, envelopeId: string, createRule = false) => {
      set(id, { envelopeId, confirmed: true, createRule });
      closePicker();
    },
    [closePicker, set],
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

  /** Join two rows that already exist, rather than writing a third (FR-5). */
  const pairTransfer = useCallback(
    (candidate: TransferCandidate) => {
      setError(null);
      startTransition(async () => {
        const result = await pairTransferAction(candidate.transactionId, candidate.otherId);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        closePicker();
        setNote(`Paired with the matching row in ${candidate.accountName}.`);
        router.refresh();
      });
    },
    [closePicker, router],
  );

  const markTransfer = useCallback(
    (row: QueueRow, toAccountId: string, createRule: boolean) => {
      setError(null);
      startTransition(async () => {
        const result = await markAsTransferAction(row.id, toAccountId, { createRule });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        closePicker();
        setNote('Recorded as a transfer between your accounts.');
        router.refresh();
      });
    },
    [closePicker, router],
  );

  /** The row's own suggestion, shown at the top of its picker. */
  const suggested = useMemo(
    () =>
      picking?.envelopeId
        ? (envelopes.find((envelope) => envelope.id === picking.envelopeId) ?? null)
        : null,
    [envelopes, picking],
  );

  /** Every envelope under its own heading, in the order the envelopes screen uses. */
  const grouped = useMemo(() => {
    const groups: { name: string; envelopes: EnvelopeOption[] }[] = [];
    for (const envelope of envelopes) {
      const last = groups.at(-1);
      if (last && last.name === envelope.groupName) last.envelopes.push(envelope);
      else groups.push({ name: envelope.groupName, envelopes: [envelope] });
    }
    return groups;
  }, [envelopes]);

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

      {rows.map((row, at) => {
        const decision = decisionFor(row.id);
        const confidence = confidenceOf(row);
        const chosen = decision.envelopeId;
        /** Filled in by the pipeline rather than chosen here: this is the row a press settles. */
        const prefilled = row.envelopeId !== null;

        // A heading wherever the account changes: the rows arrive grouped by
        // account, and one statement's charges read best together.
        const firstOfAccount = at === 0 || rows[at - 1]!.accountId !== row.accountId;

        return (
          <Fragment key={row.id}>
            {firstOfAccount && (
              <div className="queue-account">
                <span>{row.accountName}</span>
                <span className="muted">{perAccount.get(row.accountId)}</span>
              </div>
            )}
            <div className={`queue-row${decision.confirmed ? ' decided' : ''}`}>
              <span className="queue-payee">
                {row.payeeDisplay}
                {row.memo && <span className="muted"> · {row.memo}</span>}
                {/* Beside what the transaction says it is, because that is what the
                    confidence is *about* - down in the meta line it read as one
                    more fact about the row rather than a judgement of the guess. */}
                <span className={`band ${confidence.tone}`} title={row.reason ?? undefined}>
                  {confidence.label}
                  {confidence.detail && ` ${confidence.detail}`}
                </span>
                {/* The bank's own words, whole. The cleaned name is right for
                    matching and wrong for deciding: it drops everything after a
                    "*" as a reference code, so GOOGLE*YOUTUBEPREMIUM and
                    GOOGLE*CLOUD both read "Google". */}
                {saysMore(row) && <span className="queue-raw">{row.payeeRaw}</span>}
                {transferFor.get(row.id) && <span className="band medium">transfer?</span>}
              </span>

              <span className={`money ${row.amountCents < 0 ? 'neg' : 'pos'}`}>
                {formatMoney(row.amountCents, { sign: 'incoming' })}
              </span>

              <span className="muted queue-meta">
                <span>{longDate(row.date)}</span>
                {row.ageDays > 14 && <span className="tag warn">{row.ageDays} days</span>}
              </span>

              <span className="queue-choice">
                {/* Everything this row can become is behind this one control. */}
                <button
                  className={`envelope-pick${chosen ? ' chosen' : ''}`}
                  onClick={() => openPicker(row)}
                  disabled={pending}
                >
                  {/* With its category: "Insurance" alone could be the car's or the
                      house's, and the queue is where that gets settled. */}
                  {chosen ? (
                    <>
                      <span className="envelope-pick-group">
                        {envelopeById.get(chosen)?.groupName}
                      </span>{' '}
                      {envelopeById.get(chosen)?.name}
                    </>
                  ) : (
                    'Choose an envelope'
                  )}
                </button>

                {/* Choosing is itself a decision, so it confirms; a row filled in
                    by the pipeline has not been decided by anyone yet, and that is
                    the one a press settles. Unconfirming empties it again rather
                    than leaving a figure nobody has agreed to sitting there. */}
                {(prefilled || decision.confirmed) && chosen && (
                  <button
                    className={decision.confirmed ? 'link-button' : 'primary confirm'}
                    onClick={() =>
                      set(
                        row.id,
                        decision.confirmed
                          ? { confirmed: false, envelopeId: row.envelopeId, createRule: false }
                          : { confirmed: true },
                      )
                    }
                    disabled={pending}
                  >
                    {decision.confirmed ? 'Unconfirm' : 'Confirm'}
                  </button>
                )}
              </span>
            </div>
          </Fragment>
        );
      })}

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

      {picking && (
        <div className="picker-backdrop" onClick={closePicker}>
          <div className="picker" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{picking.payeeDisplay}</strong>
              <span className={`money ${picking.amountCents < 0 ? 'neg' : 'pos'}`}>
                {formatMoney(picking.amountCents, { sign: 'incoming' })}
              </span>
            </div>

            {pickingTransfer ? (
              <>
                <div className="dialog-body">
                  <p className="muted">
                    {picking.amountCents < 0
                      ? 'Which of your accounts did it go to?'
                      : 'Which of your accounts did it come from?'}{' '}
                    Money moving between your own accounts is neither spending nor income, so no
                    envelope changes. This is written straight away rather than waiting for Save,
                    because it writes both halves.
                  </p>
                  <div className="picker-list">
                    {accounts
                      .filter((account) => account.name !== picking.accountName)
                      .map((account) => (
                        <button
                          key={account.id}
                          className="picker-option"
                          onClick={() => markTransfer(picking, account.id, transferRule)}
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
                    Always treat <strong>{picking.payeeDisplay}</strong> on {picking.accountName} as
                    a transfer
                  </span>
                </label>
                <div className="picker-foot dialog-foot">
                  <button
                    onClick={() => picking && overlay.open(picking.id)}
                    disabled={pending}
                  >
                    Back to envelopes
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="picker-list">
                  {/* The guess, offered at the top rather than assumed into the
                      row, and named as a guess. */}
                  {suggested && (
                    <button
                      className="picker-option suggested"
                      onClick={(event) => choose(picking.id, suggested.id, event.shiftKey)}
                    >
                      <span className="picker-name">{suggested.name}</span>
                      <span className="muted picker-group">suggested · {suggested.groupName}</span>
                    </button>
                  )}

                  {/* The other half, when one turned up. One press rather than
                      "not spending" then picking the account it obviously is. */}
                  {transferFor.get(picking.id) && (
                    <button
                      className="picker-option suggested"
                      onClick={() => pairTransfer(transferFor.get(picking.id)!)}
                      disabled={pending}
                    >
                      <span className="picker-name">
                        Transfer to {transferFor.get(picking.id)!.accountName}
                      </span>
                      <span className="muted picker-group">
                        matches {transferFor.get(picking.id)!.otherDate}
                      </span>
                    </button>
                  )}

                  {/* "No envelope at all" is the same question as "which one". */}
                  <button
                    className="picker-option"
                    onClick={() => picking && overlay.open(picking.id, { to: 'account' })}
                    disabled={pending}
                  >
                    <span className="picker-name">Not spending</span>
                    <span className="muted picker-group">a transfer between my own accounts</span>
                  </button>

                  {/*
                    Grouped under their own headings and nothing else. There was a
                    filter box here, which is a way of coping with a list you
                    cannot read; fifty envelopes under nine headings can be read,
                    and scanning beats typing when you do not know the exact name.
                  */}
                  {grouped.map((group) => (
                    <div key={group.name} className="picker-group-block">
                      <div className="picker-group-head">{group.name}</div>
                      {group.envelopes.map((envelope) => (
                        <button
                          key={envelope.id}
                          className={`picker-option${
                            envelope.id === decisionFor(picking.id).envelopeId ? ' active' : ''
                          }`}
                          onClick={(event) => choose(picking.id, envelope.id, event.shiftKey)}
                        >
                          <span className="picker-name">{envelope.name}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>

                <div className="picker-foot muted">
                  Hold <kbd>shift</kbd> while choosing to always use it for this payee
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
