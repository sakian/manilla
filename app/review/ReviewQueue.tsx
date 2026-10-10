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
 * Every suggestion is filled in, whatever its confidence, with how sure it is
 * beside it, and waits for Confirm. What confidence decides is elsewhere:
 * whether the guess already counts in the envelope's balance (0.8 and up,
 * RQ-4), and whether the card says sure, likely or guess.
 *
 * One control per card decides everything: pressing the envelope opens a picker
 * that also holds "not spending", because "which envelope" and "no envelope at
 * all" are the same question. Word-links beside it were a second way to do what
 * the picker does.
 *
 * The bulk "confirm the confident ones" button is gone. It settled about a sixth
 * of a queue without anybody looking, which is a strange thing to offer on a
 * screen whose whole purpose is looking.
 *
 * What one person leaves for another is handed over from here (RQ-7): Hand
 * over turns each row into something to tick, starting with every row not
 * decided this sitting ticked, since "the rest are yours" is the usual end of a
 * first pass. That is written at once, unlike the envelopes, and tells the
 * person it went to. A note can go with it, and each handed row shows what
 * was said about it with a way to answer.
 */

import { Fragment, useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { EnvelopeOption, QueueRow, TransferCandidate } from '../../src/queue/queue.ts';
import { BAND_THRESHOLDS } from '../../src/categorize/pipeline.ts';
import { handOverAction, markAsTransferAction, pairTransferAction, saveReviewAction } from '../actions.ts';
import { Money } from '../Money.tsx';
import { useOverlay } from '../useOverlay.ts';
import EnvelopeChoices from '../EnvelopeChoices.tsx';
import { displayDate } from '../../src/budget/month.ts';
import { splitLines, type LineDraft } from '../../src/transactions/formLines.ts';
import SplitLines from '../SplitLines.tsx';
import { Thread, threadPrompt, type ThreadPeople } from '../Thread.tsx';
import type { Message } from '../../src/transactions/thread.ts';
import { NOTE_LIMIT } from '../../src/transactions/limits.ts';

/**
 * How sure the pipeline is: one word and a number.
 *
 * One word because it is read at a glance down a column, and a column of phrases
 * is a paragraph. The number stays beside it because the two say different things
 * - the word is whether to trust it, the number is how close to the line it sits.
 * "Likely 62" and "likely 94" both mean look, but not equally hard.
 */
export function confidenceOf(row: QueueRow): { label: string; tone: string; detail: string } {
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
  /** Null means undecided; a row cannot be confirmed without one, or a split. */
  envelopeId: string | null;
  /** Parts as typed, when the row is split rather than given one envelope (FR-4). */
  split: LineDraft[] | null;
  confirmed: boolean;
  createRule: boolean;
};

const UNDECIDED: Decision = { envelopeId: null, split: null, confirmed: false, createRule: false };

/** Whether the bank's text carries anything the cleaned-up name dropped. */
export function saysMore(row: QueueRow): boolean {
  const squeeze = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return squeeze(row.payeeRaw) !== squeeze(row.payeeDisplay);
}

export default function ReviewQueue({
  rows,
  envelopes,
  transfers,
  accounts,
  me,
  members,
  view,
}: {
  rows: QueueRow[];
  envelopes: EnvelopeOption[];
  /** Rows that look like half of a transfer, found rather than declared. */
  transfers: TransferCandidate[];
  accounts: { id: string; name: string }[];
  /** Who is reviewing, so a row handed to them says "for you". */
  me: string;
  /** Everyone in the household, to hand rows to and to name who rows are for (RQ-7). */
  members: { id: string; name: string }[];
  /** Everything waiting, or only what was handed to this person. */
  view: 'all' | 'mine';
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
          ...UNDECIDED,
          envelopeId: row.envelopeId,
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
  /** The picker shows envelopes first, then the account list for "not spending" or the parts of a split. */
  const pickingTransfer = searchParams.get('to') === 'account';
  const pickingSplit = searchParams.get('to') === 'split';
  const [transferRule, setTransferRule] = useState(true);

  const transferFor = useMemo(
    () => new Map(transfers.map((candidate) => [candidate.transactionId, candidate])),
    [transfers],
  );

  /**
   * Threads write on their own, straight away: they are not part of the
   * envelope decisions saved together at the bottom, and should not wait for
   * them. What was written here is kept locally rather than refetched, so
   * writing never disturbs a decision still being made further down.
   */
  const [threads, setThreads] = useState<Record<string, Message[]>>({});
  const [writingOn, setWritingOn] = useState<string | null>(null);
  const threadOf = (row: QueueRow) => threads[row.id] ?? row.messages;
  const setThreadOf = (row: QueueRow) => (update: (current: Message[]) => Message[]) =>
    setThreads((current) => ({ ...current, [row.id]: update(current[row.id] ?? row.messages) }));
  const peopleFor = (row: QueueRow): ThreadPeople => ({
    me,
    handedToId: row.handedToId,
    handedById: row.handedById,
    names,
  });

  /** Who else rows can be handed to. Nobody, in a household of one. */
  const others = useMemo(() => members.filter((member) => member.id !== me), [members, me]);
  const nameOf = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);
  const names = useMemo(() => Object.fromEntries(nameOf), [nameOf]);
  /** Ticking rows to hand over, when Hand over has been pressed. */
  const [handing, setHanding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [handTo, setHandTo] = useState<string>(others[0]?.id ?? '');
  const [handNote, setHandNote] = useState('');

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

  const decisionFor = useCallback((id: string): Decision => decisions[id] ?? UNDECIDED, [decisions]);

  const set = useCallback((id: string, patch: Partial<Decision>) => {
    setDecisions((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? UNDECIDED),
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
      set(id, { envelopeId, split: null, confirmed: true, createRule });
      closePicker();
    },
    [closePicker, set],
  );

  const ready = useMemo(
    () =>
      rows.filter((row) => {
        const decision = decisionFor(row.id);
        return decision.confirmed && (decision.envelopeId !== null || decision.split !== null);
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
          const lines = decision.split && splitLines(decision.split, row.amountCents);
          if (lines) return { transactionId: row.id, lines };
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
      // Rows someone else reviewed meanwhile have left the queue, so they are
      // neither saved nor still waiting.
      const elsewhere = result.failed.filter((row) => row.alreadyReviewed).length;
      setNote(
        result.confirmed > 0
          ? `Saved ${result.confirmed}. ${rows.length - result.confirmed - elsewhere} still waiting.`
          : result.failed.length === 0
            ? 'Nothing was ready to save.'
            : null,
      );
      router.refresh();
    });
  }, [decisionFor, ready, router, rows.length]);

  /** Start ticking, with everything not decided this sitting already ticked. */
  const startHanding = useCallback(() => {
    setError(null);
    setNote(null);
    setSelected(new Set(rows.filter((row) => !decisionFor(row.id).confirmed).map((row) => row.id)));
    setHanding(true);
  }, [decisionFor, rows]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handOver = useCallback(() => {
    if (!handTo || selected.size === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await handOverAction([...selected], handTo, handNote);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setHanding(false);
      setSelected(new Set());
      setHandNote('');
      setNote(
        result.handed === 0
          ? 'Those were reviewed meanwhile, so there was nothing to hand over.'
          : `Handed ${result.handed} to ${result.to}.`,
      );
      router.refresh();
    });
  }, [handNote, handTo, router, selected]);

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

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>
          {view === 'mine' ? 'Nothing handed to you.' : 'Nothing to review.'}
        </p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {view === 'mine'
            ? 'Anything else waiting is under All.'
            : 'Everything imported has an envelope.'}
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
        const split = decision.split;
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
                {handing && (
                  <input
                    type="checkbox"
                    className="queue-select"
                    checked={selected.has(row.id)}
                    onChange={() => toggleSelected(row.id)}
                    aria-label={`Hand over ${row.payeeDisplay}`}
                  />
                )}
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

              <Money cents={row.amountCents} sign="incoming" />

              <span className="muted queue-meta">
                <span>{displayDate(row.date)}</span>
                {row.ageDays > 14 && <span className="tag warn">{row.ageDays} days</span>}
                {/* In the full list, whose it is; in "for me" every row is. */}
                {view === 'all' && row.handedToId && (
                  <span className="tag">
                    for {row.handedToId === me ? 'you' : (nameOf.get(row.handedToId) ?? 'someone no longer a member')}
                  </span>
                )}
              </span>

              <span className="queue-choice">
                {/* Everything this row can become is behind this one control. */}
                <button
                  className={`envelope-pick${chosen || split ? ' chosen' : ''}`}
                  onClick={() => openPicker(row)}
                  disabled={pending}
                >
                  {/* With its category: "Insurance" alone could be the car's or the
                      house's, and the queue is where that gets settled. */}
                  {split ? (
                    <>
                      <span className="envelope-pick-group">split</span>{' '}
                      {split.map((line) => envelopeById.get(line.envelopeId)?.name).join(', ')}
                    </>
                  ) : chosen ? (
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
                {(prefilled || decision.confirmed) && (chosen || split) && (
                  <button
                    className={decision.confirmed ? 'link-button' : 'primary confirm'}
                    onClick={() =>
                      set(
                        row.id,
                        decision.confirmed
                          ? { ...UNDECIDED, envelopeId: row.envelopeId }
                          : { confirmed: true },
                      )
                    }
                    disabled={pending}
                  >
                    {decision.confirmed ? 'Unconfirm' : 'Confirm'}
                  </button>
                )}
                {writingOn !== row.id && (
                  <button className="link-button" onClick={() => setWritingOn(row.id)}>
                    {threadPrompt(threadOf(row), peopleFor(row))}
                  </button>
                )}
              </span>

              <Thread
                transactionId={row.id}
                messages={threadOf(row)}
                setMessages={setThreadOf(row)}
                people={peopleFor(row)}
                writing={writingOn === row.id}
                onDoneWriting={() => setWritingOn(null)}
              />
            </div>
          </Fragment>
        );
      })}

      {/* Sticky, because the list is long and the decision to stop is made at the
          bottom of it as often as the top. */}
      {handing ? (
        <div className="queue-save">
          {/* Two lines, so a question can be read back whole before it goes. */}
          <textarea
            className="hand-note"
            rows={2}
            value={handNote}
            maxLength={NOTE_LIMIT}
            placeholder={`Note for ${nameOf.get(handTo) ?? 'them'} (optional)`}
            aria-label="Note to go with them"
            onChange={(event) => setHandNote(event.target.value)}
            disabled={pending}
          />
          <span className="muted">{selected.size} selected</span>
          {/* Every undecided row starts ticked, which on a long list is many
              to untick one at a time when only a few are meant. */}
          <button
            className="link-button"
            onClick={() => setSelected(selected.size > 0 ? new Set() : new Set(rows.map((row) => row.id)))}
            disabled={pending}
          >
            {selected.size > 0 ? 'Clear' : 'Select all'}
          </button>
          <label className="hand-to">
            <span className="muted">to</span>
            <select value={handTo} onChange={(event) => setHandTo(event.target.value)} disabled={pending}>
              {others.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => setHanding(false)} disabled={pending}>
            Cancel
          </button>
          <button className="primary" onClick={handOver} disabled={pending || selected.size === 0}>
            {pending ? 'Handing over…' : `Hand over ${selected.size}`}
          </button>
        </div>
      ) : (
        <div className="queue-save">
          <span className="muted">
            {ready.length} of {rows.length} ready
          </span>
          {others.length > 0 && (
            <button onClick={startHanding} disabled={pending}>
              Hand over…
            </button>
          )}
          <button className="primary" onClick={save} disabled={pending || ready.length === 0}>
            {pending ? 'Saving…' : `Save ${ready.length}`}
          </button>
        </div>
      )}

      {picking && (
        <div className="picker-backdrop" onClick={closePicker}>
          <div
            className={`picker${pickingSplit ? ' dialog' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="picker-head">
              <strong>{picking.payeeDisplay}</strong>
              <Money cents={picking.amountCents} sign="incoming" />
            </div>

            {pickingSplit ? (
              <ReviewSplit
                key={picking.id}
                row={picking}
                envelopes={envelopes}
                decision={decisionFor(picking.id)}
                onBack={() => overlay.open(picking.id, {}, { replace: true })}
                onDone={(lines) => {
                  set(picking.id, { envelopeId: null, split: lines, confirmed: true, createRule: false });
                  closePicker();
                }}
              />
            ) : pickingTransfer ? (
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
                <EnvelopeChoices
                  key={picking.id}
                  envelopes={envelopes}
                  activeId={decisionFor(picking.id).envelopeId}
                  onChoose={(envelopeId, createRule) => choose(picking.id, envelopeId, createRule)}
                >
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

                  {/* Several envelopes is the same question again, answered in parts. */}
                  <button
                    className="picker-option"
                    // In place of the envelopes rather than after them, so that
                    // closing once the split is staged leaves the picker instead
                    // of stepping back into it.
                    onClick={() => picking && overlay.open(picking.id, { to: 'split' }, { replace: true })}
                    disabled={pending}
                  >
                    <span className="picker-name">Split between envelopes</span>
                    <span className="muted picker-group">part here, part there</span>
                  </button>

                  {/* "No envelope at all" is the same question as "which one". */}
                  <button
                    className="picker-option"
                    onClick={() => picking && overlay.open(picking.id, { to: 'account' })}
                    disabled={pending}
                  >
                    <span className="picker-name">Not spending</span>
                    <span className="muted picker-group">a transfer between my own accounts</span>
                  </button>
                </EnvelopeChoices>

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

/**
 * The parts of one row's split, staged like any other decision: nothing is
 * written until Save. Opened from the row's picker, it starts from the
 * envelope the row has - usually the larger part - with a second part to
 * fill in, and that first part left blank takes whatever the second leaves.
 */
function ReviewSplit({
  row,
  envelopes,
  decision,
  onBack,
  onDone,
}: {
  row: QueueRow;
  envelopes: EnvelopeOption[];
  decision: Decision;
  onBack: () => void;
  onDone: (lines: LineDraft[]) => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>(
    () =>
      decision.split ?? [
        { envelopeId: decision.envelopeId ?? '', amount: '' },
        { envelopeId: '', amount: '' },
      ],
  );
  const finished = splitLines(lines, row.amountCents) !== null;

  return (
    <>
      <div className="dialog-body">
        <SplitLines
          lines={lines}
          setLines={setLines}
          totalCents={Math.abs(row.amountCents)}
          envelopes={envelopes}
          title={row.payeeDisplay}
        />
        {!finished && (
          <p className="muted">
            Every part needs an envelope, and the parts need to add up to the whole.
          </p>
        )}
      </div>
      <div className="picker-foot dialog-foot">
        <button className="primary" onClick={() => onDone(lines)} disabled={!finished}>
          Use this split
        </button>
        <button onClick={onBack}>Back to envelopes</button>
      </div>
    </>
  );
}
