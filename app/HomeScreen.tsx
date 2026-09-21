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

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { FundingPlan } from '../src/budget/budget.ts';
import type { ManagedGroup } from '../src/envelopes/manage.ts';
import { Hint } from './Hint.tsx';
import { Money } from './Money.tsx';
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

export type MonthFigures = Record<
  string,
  {
    plannedCents: number;
    spentCents: number;
    allocatedCents: number;
    lastMonthSpentCents: number;
    averageSpentCents: number;
  }
>;

export type Headline = {
  /** Transactions waiting in the review queue. */
  waiting: number;
  /** What is sitting in the income pool, unassigned to any envelope. */
  unallocatedCents: number;
  overspentCount: number;
  /** FR-37: whether the two sides of the ledger still agree. */
  invariantOk: boolean;
  unexplainedCents: number;
  unassignedCents: number;
};

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

type Result = { ok: true; message?: string } | { ok: false; error: string };

export default function HomeScreen({
  groups,
  figures,
  monthLabel,
  month,
  funding,
  headline,
}: {
  groups: ManagedGroup[];
  figures: MonthFigures;
  monthLabel: string;
  month: string;
  funding: FundingPlan;
  headline: Headline;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [funded, setFunded] = useState(false);
  const [newEnvelope, setNewEnvelope] = useState<Record<string, string>>({});
  const [newGroup, setNewGroup] = useState('');
  const [transferFrom, setTransferFrom] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [covering, setCovering] = useState<{ id: string; name: string } | null>(null);
  const [archiving, setArchiving] = useState<{
    id: string;
    name: string;
    balanceCents: number;
  } | null>(null);

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
      <div className="page-head">
        <div className="month-head">
          <h2>
            Envelopes{' '}
            <Hint label="What these figures mean">
              Balances carry over month to month. Planned and spent are for {monthLabel}; the
              balance is everything that has ever happened to the envelope. Edit lets you rename,
              regroup, archive and set planned amounts; groups can be reordered there too, while
              envelopes stay alphabetical.
            </Hint>
          </h2>
          <div className="head-actions">
            <button
              className="primary"
              onClick={() => {
                setTransferFrom(null);
                setTransferOpen(true);
              }}
              disabled={pending}
            >
              Move money
            </button>
            {/* Every envelope is fundable, so this is only unreachable when
                there are none at all. */}
            <button
              onClick={() => setFunded(true)}
              disabled={pending || funding.lines.length === 0}
              title="Move money between Available and the envelopes"
            >
              {funding.totalCents === 0 ? 'Move money in' : `Fund ${money(funding.totalCents)}`}
            </button>
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

      <div className="callouts">
        {headline.waiting > 0 && (
          <Link href="/review" className="callout">
            <strong>{headline.waiting}</strong> awaiting review
          </Link>
        )}
        <div className={`callout${headline.unallocatedCents < 0 ? ' bad' : ''}`}>
          <strong>
            <Money cents={headline.unallocatedCents} />
          </strong>{' '}
          {headline.unallocatedCents < 0 ? 'overdrawn' : 'unallocated'}
        </div>
        {headline.overspentCount > 0 && (
          <div className="callout warn">
            <strong>{headline.overspentCount}</strong> envelope
            {headline.overspentCount === 1 ? '' : 's'} overspent
          </div>
        )}
        {!headline.invariantOk && (
          <div className="callout bad">
            Ledger out of balance by <Money cents={headline.unexplainedCents} />
          </div>
        )}
      </div>

      {/* Overdrawing Available is allowed but is not a neutral state: more has
          been given to envelopes than has arrived, so some envelope's balance is
          money that is not there yet. It is said here every visit, not only in
          the dialog that caused it. */}
      {headline.unallocatedCents < 0 && (
        <p className="budget-warning bad">
          Available is <Money cents={-headline.unallocatedCents} plain /> overdrawn: the envelopes
          hold more than has actually arrived. Take some back with Move money, or leave it until
          income covers it — but until then the balances below are promising money you do not have.
        </p>
      )}

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {live.map((group, groupIndex) => {
        const envelopes = group.envelopes.filter((envelope) => envelope.archivedAt === null);

        return (
          <details key={group.id} className="panel group-panel" open>
            {/* A group is a heading, not a figure. Its rolled-up balance, plan
                and spending were three more numbers to read past on the way to
                the envelope you actually wanted. */}
            <summary>
              <span className="group-summary">
                <span className="group-name">{group.name}</span>
              </span>
            </summary>

            {editing && (
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
                    <Link href={`/envelopes/${envelope.id}`} className="envelope-open">
                      {envelope.name}
                    </Link>
                    {envelope.isUnallocated && <span className="tag">income pool</span>}
                    {overspent && <span className="tag warn">overspent</span>}
                    {!envelope.carryOver && <span className="tag">resets monthly</span>}
                    {editing && (
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
                    {editing && !envelope.isUnallocated ? (
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
                    ) : figure ? (
                      <>
                        <span className="figure">
                          <span className="figure-label">planned</span> {money(figure.plannedCents)}
                        </span>
                        <span className="figure">
                          <span className="figure-label">spent</span> {money(figure.spentCents)}
                        </span>
                      </>
                    ) : (
                      'archived group'
                    )}
                  </span>

                  <span className="envelope-actions">
                    {overspent && !editing && (
                      <button
                        onClick={() => setCovering({ id: envelope.id, name: envelope.name })}
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
                          onClick={() =>
                            setArchiving({
                              id: envelope.id,
                              name: envelope.name,
                              balanceCents: envelope.balanceCents,
                            })
                          }
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

            {editing && (
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

      <p className="muted footnote">
        {headline.invariantOk ? (
          <>
            Envelopes and accounts agree
            {headline.unassignedCents !== 0 && (
              <>
                , with <Money cents={headline.unassignedCents} /> still unassigned in the{' '}
                <Link href="/review">review queue</Link>
              </>
            )}
            .
          </>
        ) : (
          <>
            Envelopes and accounts disagree by <Money cents={headline.unexplainedCents} />, which
            should never happen. Recent imports are the place to look.
          </>
        )}
      </p>

      {funded && (
        <FundEnvelopes
          month={month}
          label={monthLabel}
          funding={funding}
          onClose={() => setFunded(false)}
        />
      )}

      {transferOpen && (
        <TransferDialog
          envelopes={choices}
          {...(transferFrom ? { fromEnvelopeId: transferFrom } : {})}
          onClose={() => setTransferOpen(false)}
        />
      )}

      {covering && (
        <CoverDialog
          envelopeId={covering.id}
          envelopeName={covering.name}
          onClose={() => setCovering(null)}
        />
      )}

      {archiving && (
        <ArchiveDialog
          envelopeId={archiving.id}
          envelopeName={archiving.name}
          balanceCents={archiving.balanceCents}
          envelopes={choices}
          onClose={() => setArchiving(null)}
        />
      )}
    </>
  );
}
