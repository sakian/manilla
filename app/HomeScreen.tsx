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
 * once. Renaming, reordering, archiving, adding and setting planned amounts are
 * all things you do occasionally and deliberately; showing their controls on
 * every row buries the balances, which is what you came for. Nothing is hidden
 * that changes money - Move and Cover stay visible, because those are answers to
 * what the screen is telling you.
 *
 * Groups are `<details>` elements, so collapsing (FR-22) works without state,
 * without JavaScript, and with a keyboard. Every group shows its rolled-up
 * balance, plan and spending, because that roll-up is the reason groups exist.
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
import { Money } from './Money.tsx';
import { inputFromCents } from './amount.ts';
import {
  archiveGroupAction,
  createEnvelopeAction,
  createGroupAction,
  editEnvelopeAction,
  nudgeEnvelopeAction,
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
  allocatedCents,
  headline,
}: {
  groups: ManagedGroup[];
  figures: MonthFigures;
  monthLabel: string;
  month: string;
  funding: FundingPlan;
  /** Net allocated this month, for the funding dialog's send-it-back path. */
  allocatedCents: number;
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
          <h2>Envelopes</h2>
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
            {/* Reachable while there is either something to fund or something
                already funded to send back (FR-30). */}
            <button
              onClick={() => setFunded(true)}
              disabled={pending || (funding.lines.length === 0 && allocatedCents === 0)}
              title={
                funding.lines.length === 0 && allocatedCents === 0
                  ? 'No envelope has a planned amount yet'
                  : `Move ${money(funding.totalCents)} out of Available`
              }
            >
              {funding.totalCents === 0 ? 'Fund envelopes' : `Fund ${money(funding.totalCents)}`}
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
        <p className="muted">
          Balances carry over month to month. Planned and spent are for {monthLabel}; the balance is
          everything that has ever happened to the envelope.
        </p>
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
          unallocated
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

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {live.map((group) => {
        const envelopes = group.envelopes.filter((envelope) => envelope.archivedAt === null);
        const balance = envelopes.reduce((sum, envelope) => sum + envelope.balanceCents, 0);
        const planned = envelopes.reduce(
          (sum, envelope) => sum + (figures[envelope.id]?.plannedCents ?? 0),
          0,
        );
        const spent = envelopes.reduce(
          (sum, envelope) => sum + (figures[envelope.id]?.spentCents ?? 0),
          0,
        );

        return (
          <details key={group.id} className="panel group-panel" open>
            <summary>
              <span className="group-summary">
                <span className="group-name">{group.name}</span>
                <span className="group-figures muted">
                  planned {money(planned)} · spent {money(spent)}
                </span>
                <Money cents={balance} />
              </span>
            </summary>

            {editing && (
            <div className="group-tools">
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

            {envelopes.map((envelope, index) => {
              const figure = figures[envelope.id];
              const overspent = envelope.balanceCents < 0;
              return (
                <div key={envelope.id} className="envelope-row">
                  <span className="envelope-name">
                    <Link href={`/envelopes/${envelope.id}`}>{envelope.name}</Link>
                    {envelope.isUnallocated && <span className="tag">income pool</span>}
                    {overspent && <span className="tag warn">overspent</span>}
                    {!envelope.carryOver && <span className="tag">resets monthly</span>}
                  </span>

                  <span className="envelope-figures muted">
                    {figure ? (
                      <>
                        <span className="figure">
                          <span className="figure-label">planned</span>{' '}
                          {money(figure.plannedCents)}
                        </span>
                        <span className="figure">
                          <span className="figure-label">spent</span> {money(figure.spentCents)}
                        </span>
                      </>
                    ) : (
                      'archived group'
                    )}
                  </span>

                  <Money cents={envelope.balanceCents} />

                  <span className="envelope-actions">
                    {overspent && (
                      <button
                        onClick={() => setCovering({ id: envelope.id, name: envelope.name })}
                        disabled={pending}
                      >
                        Cover
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setTransferFrom(envelope.id);
                        setTransferOpen(true);
                      }}
                      disabled={pending}
                    >
                      Move
                    </button>
                    {editing && (
                      <>
                        {!envelope.isUnallocated && (
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
                        )}
                        <button
                          onClick={() => rename(envelope.id, envelope.name)}
                          disabled={pending}
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => run(() => nudgeEnvelopeAction(envelope.id, 'up'))}
                          disabled={pending || index === 0}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => run(() => nudgeEnvelopeAction(envelope.id, 'down'))}
                          disabled={pending || index === envelopes.length - 1}
                          title="Move down"
                        >
                          ↓
                        </button>
                        {!envelope.isUnallocated && (
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
                        )}
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
          allocatedCents={allocatedCents}
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
