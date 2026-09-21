'use client';

/**
 * The home screen: what every envelope holds, and everything you do to them
 * (VW-1, VW-3, FR-21 to FR-25, FR-34, FR-35).
 *
 * The dashboard and the envelope list were two screens showing the same column
 * of balances, so they are one screen. Accounts are not here at all: an account
 * balance is the bank's view and it has its own tab, while this screen is the
 * envelope view - the one that answers "can I afford this".
 *
 * Reading and rearranging are separated by an Edit button rather than shown at
 * once. Renaming, archiving, adding, moving an envelope between groups and
 * setting planned amounts are all things you do occasionally and deliberately;
 * showing their controls on every row buries the balances, which is what you came
 * for. Cover stays visible, because an overspend is something the screen is
 * telling you about and the fix belongs next to it.
 *
 * Moving money is one button at the top rather than one per row. Per-row buttons
 * made every card busier for an action that needs a dialog anyway, and that
 * dialog asks which envelope regardless.
 *
 * A card is two lines: the name with its balance, then what it planned and spent.
 * The balance is what anyone opens this screen for, so it shares the line with
 * the name rather than sitting in a third column. Clicking anywhere on the card
 * opens the envelope.
 *
 * Envelopes are alphabetical inside their group; groups keep a manual order.
 * There are dozens of envelopes and a handful of groups, so one is scanned and
 * the other is read as a shape - "Income first, Archive last" is a real
 * preference, while a hand-made envelope order is just somewhere to lose things.
 *
 * Groups are `<details>` elements, so collapsing (FR-22) works without state,
 * without JavaScript, and with a keyboard. A group heading is a name and nothing
 * else: its rolled-up balance, plan and spending were three more figures to read
 * past on the way to the envelope actually being looked for.
 *
 * Archiving is the interesting interaction: an envelope with money in it cannot
 * just disappear (FR-25), so the button asks where the balance should go and the
 * server does both in one transaction.
 */

import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { FundingPlan } from '../src/budget/budget.ts';
import type { ManagedGroup } from '../src/envelopes/manage.ts';
import { Hint } from './Hint.tsx';
import { useOverlay } from './useOverlay.ts';
import { Money, Spend } from './Money.tsx';
import { inputFromCents } from './amount.ts';
import {
  archiveGroupAction,
  createEnvelopeAction,
  createGroupAction,
  editEnvelopeAction,
  moveEnvelopeToGroupAction,
  nudgeGroupAction,
  renameGroupAction,
  unarchiveEnvelopeAction,
  unarchiveGroupAction,
} from './envelopes/actions.ts';
import {
  ArchiveDialog,
  CoverDialog,
  TransferDialog,
  type EnvelopeChoice,
} from './envelopes/MoveMoney.tsx';
import { setPlannedAction } from './budget/actions.ts';
import FundEnvelopes from './budget/FundEnvelopes.tsx';
import { formatMoney } from '../src/money.ts';

export type MonthFigures = Record<
  string,
  {
    plannedCents: number;
    spentCents: number;
    allocatedCents: number;
    lastMonthSpentCents: number;
    averageSpentCents: number;
    /** The share of the balance still awaiting review (RQ-4). */
    pendingCents: number;
  }
>;

type Result = { ok: true; message?: string } | { ok: false; error: string };

export default function HomeScreen({
  groups,
  figures,
  monthLabel,
  lastMonthLabel,
  month,
  funding,
  notices,
}: {
  groups: ManagedGroup[];
  figures: MonthFigures;
  monthLabel: string;
  /** Short form of the month before this one, for the per-row history figure. */
  lastMonthLabel: string;
  month: string;
  funding: FundingPlan;
  /** The notices list, rendered on the server and slotted in under the heading. */
  notices?: ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /**
   * Which dialog is open lives in the URL: `?on=fund`, `?on=move&envelope=<id>`,
   * and so on. Back closes it, the same as everywhere else in the app, and none
   * of it costs a server round trip (see `useOverlay`).
   */
  const overlay = useOverlay('on', ['envelope']);
  const openEnvelopeId = searchParams.get('envelope');
  const [newEnvelope, setNewEnvelope] = useState<Record<string, string>>({});
  const [newGroup, setNewGroup] = useState('');

  const run = useCallback(
    (work: () => Promise<Result>) => {
      setError(null);
      setNote(null);
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNote(result.message ?? null);
        router.refresh();
      });
    },
    [router],
  );

  const live = useMemo(
    () => groups.filter((group) => group.archivedAt === null),
    [groups],
  );

  /**
   * Everything the screen has to say, in one list (see `Notices`).
   *
   * The books disagreeing and money sitting unreviewed are two different things
   * and only look alike: uncategorized money *is* accounted for - the invariant
   * counts it - so the queue gets an ordinary nudge, while a genuine mismatch is
   * the only thing here that means something is broken.
   */
  /** The envelope a dialog is about, when the URL names one. */
  const openEnvelope = useMemo(
    () =>
      openEnvelopeId
        ? (live
            .flatMap((group) => group.envelopes)
            .find((envelope) => envelope.id === openEnvelopeId) ?? null)
        : null,
    [live, openEnvelopeId],
  );

  /** Where an envelope can be moved to. Archived groups are not a destination. */
  const liveGroups = useMemo(
    () => live.map((group) => ({ id: group.id, name: group.name })),
    [live],
  );

  const choices: EnvelopeChoice[] = useMemo(
    () =>
      live.flatMap((group) =>
        group.envelopes
          .filter((envelope) => envelope.archivedAt === null)
          .map((envelope) => ({
            id: envelope.id,
            name: envelope.name,
            groupName: group.name,
            balanceCents: envelope.balanceCents,
          })),
      ),
    [live],
  );

  const archivedEnvelopes = useMemo(
    () =>
      groups.flatMap((group) =>
        group.envelopes
          .filter((envelope) => envelope.archivedAt !== null)
          .map((envelope) => ({ ...envelope, groupName: group.name })),
      ),
    [groups],
  );

  const archivedGroups = groups.filter((group) => group.archivedAt !== null);

  /**
   * Only write when the figure actually changed. Blurring a field nobody touched
   * would otherwise turn every scroll past an envelope into a database write and
   * a page refresh.
   */
  const savePlanned = useCallback(
    (envelopeId: string, figure: MonthFigures[string] | undefined, value: string) => {
      if (value.trim() === inputFromCents(figure?.plannedCents ?? 0)) return;
      run(() => setPlannedAction(envelopeId, value));
    },
    [run],
  );

  const rename = useCallback(
    (envelopeId: string, current: string) => {
      const next = window.prompt('Rename envelope', current);
      if (next === null || next.trim() === current) return;
      run(() => editEnvelopeAction(envelopeId, { name: next }));
    },
    [run],
  );

  return (
    <>
      {notices}

      <div className="page-head">
        <div className="month-head">
          <h2>
            Envelopes{' '}
            <Hint label="What these figures mean">
              Balances carry over month to month. Planned and spent are for {monthLabel}; the
              balance is everything that has ever happened to the envelope. Edit lets you rename,
              regroup, archive and set planned amounts; groups can be reordered there too, while
              envelopes stay alphabetical. Editing also shows what each envelope has actually cost -
              averaged over a year, and last month - which is the context a planned figure needs.
            </Hint>
          </h2>
          <div className="head-actions">
            <button
              onClick={() => overlay.open('move')}
              disabled={pending}
              title="Move money from one envelope to another"
            >
              Move
            </button>
            {/* Every envelope is fundable, so this is only unreachable when
                there are none at all. */}
            {/* One word each. What they do is explained where it happens, by the
                dialog that opens - not by a label long enough to need reading
                every time you glance at the screen. */}
            <button
              className="primary"
              onClick={() => overlay.open('fund')}
              disabled={pending || funding.lines.length === 0}
              title="Put money into envelopes out of Available, or take it back"
            >
              Fund
            </button>
            {/* A link styled as one of these buttons: importing is a page, not a
                dialog, and it is here as well as on Accounts because a monthly
                statement is the most common reason to open the app at all. */}
            <Link href="/import" className="button-link head-button">
              Import
            </Link>
            <button
              onClick={() => setEditing(!editing)}
              disabled={pending}
              aria-pressed={editing}
              className={editing ? 'active' : ''}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          </div>
        </div>

      </div>

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {live.map((group, groupIndex) => {
        const envelopes = group.envelopes.filter((envelope) => envelope.archivedAt === null);
        /**
         * The group holding the income pool is the app's, not the user's. There
         * is exactly one pool (a partial unique index says so), it is where
         * income lands by definition, and renaming, archiving or filling its
         * group with ordinary envelopes would all make that harder to see.
         */
        const systemGroup = envelopes.some((envelope) => envelope.isUnallocated);

        return (
          <details key={group.id} className="panel group-panel" open>
            {/* A group is a heading, not a figure. Its rolled-up balance, plan
                and spending were three more numbers to read past on the way to
                the envelope you actually wanted. */}
            <summary>
              <span className="group-summary">
                <span className="group-name">{group.name}</span>
                {/* The heading is a way in too: a whole group's spending is a
                    question people ask more often than one envelope's. */}
                <Link
                  className="group-open"
                  href={`/transactions?envgroup=${group.id}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  transactions
                </Link>
              </span>
            </summary>

            {editing && !systemGroup && (
            <div className="group-tools">
              <button
                onClick={() => run(() => nudgeGroupAction(group.id, 'up'))}
                disabled={pending || groupIndex === 0}
                title="Move this group up"
              >
                ↑
              </button>
              <button
                onClick={() => run(() => nudgeGroupAction(group.id, 'down'))}
                disabled={pending || groupIndex === live.length - 1}
                title="Move this group down"
              >
                ↓
              </button>
              <button
                onClick={() => {
                  const next = window.prompt('Rename group', group.name);
                  if (next !== null && next.trim() !== group.name) {
                    run(() => renameGroupAction(group.id, next));
                  }
                }}
                disabled={pending}
              >
                Rename group
              </button>
              <button onClick={() => run(() => archiveGroupAction(group.id))} disabled={pending}>
                Archive group
              </button>
            </div>
            )}

            {envelopes.map((envelope) => {
              const figure = figures[envelope.id];
              const overspent = envelope.balanceCents < 0;
              return (
                <div
                  key={envelope.id}
                  className={`envelope-row${editing ? ' editing' : ''}`}
                >
                  <span className="envelope-name">
                    {/* The whole card opens the envelope, done with a real link
                        stretched over the card by CSS rather than an onClick on
                        the div: a link can be middle-clicked, copied, tabbed to
                        and read out. Buttons sit above it, and the stretch is
                        switched off while editing so a stray click cannot
                        navigate away from a half-typed amount. */}
                    <Link
                      href={`/transactions?env=${envelope.id}`}
                      className="envelope-open"
                    >
                      {envelope.name}
                    </Link>
                    {envelope.isUnallocated && <span className="tag">income pool</span>}
                    {overspent && <span className="tag warn">overspent</span>}
                    {!envelope.carryOver && <span className="tag">resets monthly</span>}
                    {editing && !envelope.isUnallocated && (
                      <button
                        className="rename-inline"
                        onClick={() => rename(envelope.id, envelope.name)}
                        disabled={pending}
                        title={`Rename ${envelope.name}`}
                      >
                        Rename
                      </button>
                    )}
                  </span>

                  <Money cents={envelope.balanceCents} />

                  <span className="envelope-figures muted">
                    {/* A balance that is part fact and part proposal has to say
                        so, or it is a figure nobody can act on. */}
                    {figure && figure.pendingCents !== 0 && (
                      <span className="figure pending" title="From transactions not yet reviewed">
                        <span className="figure-label">unreviewed</span>
                        <Money cents={figure.pendingCents} plain />
                      </span>
                    )}
                    {editing && !envelope.isUnallocated ? (
                      <>
                        <label className="planned-edit">
                          <span className="figure-label">plan</span>
                          <input
                            className="amount"
                            inputMode="decimal"
                            aria-label={`Planned each month for ${envelope.name}`}
                            defaultValue={inputFromCents(figure?.plannedCents ?? 0)}
                            onBlur={(event) => savePlanned(envelope.id, figure, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                            }}
                          />
                        </label>
                        {/* What the envelope actually costs, beside the box where
                            you decide what it should get. This is what the budget
                            screen was for; a planned figure with no history next
                            to it is a guess. */}
                        <Spend cents={figure?.averageSpentCents ?? 0} label="avg/mo" />
                        <Spend cents={figure?.lastMonthSpentCents ?? 0} label={lastMonthLabel} />
                      </>
                    ) : figure ? (
                      <>
                        <span className="figure">
                          <span className="figure-label">planned</span> {formatMoney(figure.plannedCents)}
                        </span>
                        <Spend cents={figure.spentCents} />
                      </>
                    ) : (
                      'archived group'
                    )}
                  </span>

                  <span className="envelope-actions">
                    {overspent && !editing && (
                      <button
                        onClick={() => overlay.open('cover', { envelope: envelope.id })}
                        disabled={pending}
                      >
                        Cover
                      </button>
                    )}
                    {editing && !envelope.isUnallocated && (
                      <>
                        {liveGroups.length > 1 && (
                          <label className="group-move">
                            <span className="figure-label">group</span>
                            <select
                              value={group.id}
                              aria-label={`Group for ${envelope.name}`}
                              disabled={pending}
                              onChange={(event) =>
                                run(() =>
                                  moveEnvelopeToGroupAction(envelope.id, event.target.value),
                                )
                              }
                            >
                              {liveGroups.map((choice) => (
                                <option key={choice.id} value={choice.id}>
                                  {choice.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <button
                          onClick={() => overlay.open('archive', { envelope: envelope.id })}
                          disabled={pending}
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </span>
                </div>
              );
            })}

            {editing && !systemGroup && (
            <div className="add-device">
              <input
                value={newEnvelope[group.id] ?? ''}
                placeholder={`New envelope in ${group.name}`}
                onChange={(event) =>
                  setNewEnvelope((current) => ({ ...current, [group.id]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  const name = newEnvelope[group.id] ?? '';
                  if (name.trim() === '') return;
                  setNewEnvelope((current) => ({ ...current, [group.id]: '' }));
                  run(() => createEnvelopeAction(group.id, name));
                }}
              />
              <button
                onClick={() => {
                  const name = newEnvelope[group.id] ?? '';
                  if (name.trim() === '') return;
                  setNewEnvelope((current) => ({ ...current, [group.id]: '' }));
                  run(() => createEnvelopeAction(group.id, name));
                }}
                disabled={pending || (newEnvelope[group.id] ?? '').trim() === ''}
              >
                Add envelope
              </button>
            </div>
            )}
          </details>
        );
      })}

      {editing && (
      <section className="panel">
        <h3>New group</h3>
        <div className="add-device">
          <input
            value={newGroup}
            placeholder="e.g. Vehicle"
            onChange={(event) => setNewGroup(event.target.value)}
          />
          <button
            onClick={() => {
              const name = newGroup;
              setNewGroup('');
              run(() => createGroupAction(name));
            }}
            disabled={pending || newGroup.trim() === ''}
          >
            Add group
          </button>
        </div>
      </section>
      )}

      {editing && (archivedEnvelopes.length > 0 || archivedGroups.length > 0) && (
        <details className="panel group-panel">
          <summary>
            <span className="group-summary">
              <span className="group-name">Archived</span>
              <span className="muted">
                {archivedEnvelopes.length} envelope{archivedEnvelopes.length === 1 ? '' : 's'}
                {archivedGroups.length > 0 && `, ${archivedGroups.length} group`}
                {archivedGroups.length > 1 && 's'}
              </span>
            </span>
          </summary>
          {archivedEnvelopes.map((envelope) => (
            <div key={envelope.id} className="row">
              <span>
                {envelope.groupName} · {envelope.name}
              </span>
              <button
                onClick={() => run(() => unarchiveEnvelopeAction(envelope.id))}
                disabled={pending}
              >
                Restore
              </button>
            </div>
          ))}
          {archivedGroups.map((group) => (
            <div key={group.id} className="row">
              <span>{group.name} (group)</span>
              <button onClick={() => run(() => unarchiveGroupAction(group.id))} disabled={pending}>
                Restore
              </button>
            </div>
          ))}
        </details>
      )}

      {overlay.value === 'fund' && (
        <FundEnvelopes
          month={month}
          label={monthLabel}
          funding={funding}
          onClose={overlay.close}
        />
      )}

      {overlay.value === 'move' && (
        <TransferDialog
          envelopes={choices}
          {...(openEnvelopeId ? { fromEnvelopeId: openEnvelopeId } : {})}
          onClose={overlay.close}
        />
      )}

      {/* An envelope named in the URL that is no longer there - archived in
          another tab, or a stale link - closes rather than throwing. */}
      {overlay.value === 'cover' && openEnvelope && (
        <CoverDialog
          envelopeId={openEnvelope.id}
          envelopeName={openEnvelope.name}
          onClose={overlay.close}
        />
      )}

      {overlay.value === 'archive' && openEnvelope && (
        <ArchiveDialog
          envelopeId={openEnvelope.id}
          envelopeName={openEnvelope.name}
          balanceCents={openEnvelope.balanceCents}
          envelopes={choices}
          onClose={overlay.close}
        />
      )}
    </>
  );
}
