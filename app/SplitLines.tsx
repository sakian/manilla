'use client';

/**
 * The envelope parts of one transaction, as typed (FR-4).
 *
 * Shared by the transaction dialog and the review queue, which used to differ:
 * the dialog gave each part a native select of every envelope, and the queue
 * had the searchable picker but no way to split. Now each part's envelope opens
 * the same picker the queue uses, stacked over whichever dialog this is in.
 *
 * The parts carry the transaction's direction and are typed as positive
 * figures. A running "left to assign" keeps the FR-4 rule - the parts sum to
 * the whole - on screen rather than in an error after the fact, and any part
 * can be set to the rest in one press, or by typing "=".
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { EnvelopeOption } from '../src/queue/queue.ts';
import { inputFromCents } from '../src/amount.ts';
import { formatMoney } from '../src/money.ts';
import {
  fillBlankLine,
  leftToAssign,
  linesToSave,
  restFor,
  type LineDraft,
} from '../src/transactions/formLines.ts';
import EnvelopeChoices from './EnvelopeChoices.tsx';

export default function SplitLines({
  lines,
  setLines,
  totalCents,
  envelopes,
  title,
  blankLabel,
}: {
  lines: LineDraft[];
  setLines: Dispatch<SetStateAction<LineDraft[]>>;
  /** The whole, unsigned: what the parts must add up to. */
  totalCents: number;
  envelopes: EnvelopeOption[];
  /** What the transaction is, at the head of each part's picker. */
  title: string;
  /**
   * What a lone part with no envelope means. The dialog leaves such a
   * transaction for the review queue, and offers that in the picker too; the
   * queue has no such answer to give, so it says "Choose an envelope".
   */
  blankLabel?: string;
}) {
  /** Which part's picker is open. */
  const [picking, setPicking] = useState<number | null>(null);

  const filled = fillBlankLine(lines, totalCents);
  const left = leftToAssign(lines, totalCents);
  const usable = linesToSave(lines, totalCents);
  const byId = new Map(envelopes.map((envelope) => [envelope.id, envelope]));
  const offerBlank = blankLabel !== undefined && lines.length === 1;

  const change = useCallback(
    (index: number, patch: Partial<LineDraft>) =>
      setLines((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row))),
    [setLines],
  );

  /** One part takes whatever the others leave: the usual last step of a split. */
  const setRest = useCallback(
    (index: number) =>
      setLines((current) => {
        const rest = restFor(current, index, totalCents);
        return rest === null ? current : current.map((row, at) => (at === index ? { ...row, amount: rest } : row));
      }),
    [setLines, totalCents],
  );

  const choose = (envelopeId: string) => {
    if (picking !== null) change(picking, { envelopeId });
    setPicking(null);
  };

  return (
    <>
      {lines.map((line, index) => {
        const envelope = line.envelopeId ? byId.get(line.envelopeId) : undefined;
        return (
          <div key={index} className={`split-row${lines.length > 1 ? ' with-rest' : ''}`}>
            <button
              type="button"
              className={`envelope-pick${envelope ? ' chosen' : ''}`}
              onClick={() => setPicking(index)}
            >
              {envelope ? (
                <>
                  <span className="envelope-pick-group">{envelope.groupName}</span> {envelope.name}
                </>
              ) : offerBlank ? (
                blankLabel
              ) : (
                'Choose an envelope'
              )}
            </button>
            <input
              className="amount"
              inputMode="decimal"
              value={line.amount}
              aria-label={`Amount for part ${index + 1}`}
              // What a blank line will save, so leaving it blank is safe; with no
              // envelope yet, what it would take.
              placeholder={
                filled[index]!.amount ||
                (lines.length === 1 ? inputFromCents(totalCents) : (restFor(lines, index, totalCents) ?? '0.00'))
              }
              onChange={(event) => change(index, { amount: event.target.value })}
              onKeyDown={(event) => {
                // "=" for "the rest", the same as the button beside it.
                if (event.key !== '=' || lines.length < 2) return;
                event.preventDefault();
                setRest(index);
              }}
            />
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => setRest(index)}
                disabled={restFor(lines, index, totalCents) === null}
                title="Set this part to what the others leave (or type = in the amount)"
              >
                Rest
              </button>
            )}
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                title="Remove this part"
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      <div className="split-foot">
        <button
          type="button"
          onClick={() =>
            setLines((current) => [
              ...current,
              // The obvious next amount is whatever is still unassigned.
              { envelopeId: '', amount: left > 0 ? inputFromCents(left) : '' },
            ])
          }
        >
          Split across another envelope
        </button>
        {usable.length > 0 && (
          <span className={left === 0 ? 'muted' : 'split-short'}>
            {left === 0 ? 'All assigned' : `${formatMoney(left)} left to assign`}
          </span>
        )}
      </div>

      {picking !== null && (
        <PartPicker
          title={title}
          part={lines.length > 1 ? `part ${picking + 1} of ${lines.length}` : null}
          envelopes={envelopes}
          activeId={lines[picking]?.envelopeId || null}
          blankLabel={offerBlank ? blankLabel : undefined}
          onChoose={choose}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

/**
 * One part's envelope, over the dialog the parts are in, and shut on its own: a
 * click outside or Escape closes this picker, not the dialog under it, whose
 * Escape listens on the window and so never hears one stopped here. That needs
 * the key to start inside, so where the search box is not focused - a touch
 * screen, where it would raise the keyboard - the picker itself is.
 */
function PartPicker({
  title,
  part,
  envelopes,
  activeId,
  blankLabel,
  onChoose,
  onClose,
}: {
  title: string;
  part: string | null;
  envelopes: EnvelopeOption[];
  activeId: string | null;
  blankLabel: string | undefined;
  onChoose: (envelopeId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);

  return (
    <div
      className="picker-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="picker" ref={ref} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>{title}</strong>
          {part && <span className="muted">{part}</span>}
        </div>
        <EnvelopeChoices envelopes={envelopes} activeId={activeId} onChoose={(id) => onChoose(id)}>
          {blankLabel !== undefined && (
            <button className="picker-option" onClick={() => onChoose('')}>
              <span className="picker-name">{blankLabel}</span>
            </button>
          )}
        </EnvelopeChoices>
      </div>
    </div>
  );
}
