'use client';

/**
 * The envelope screen (FR-21 to FR-25, FR-34, FR-35, VW-4).
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
import type { ManagedGroup } from '../../src/envelopes/manage.ts';
import { Money } from '../Money.tsx';
import {
  archiveGroupAction,
  createEnvelopeAction,
  createGroupAction,
  editEnvelopeAction,
  nudgeEnvelopeAction,
  renameGroupAction,
  unarchiveEnvelopeAction,
  unarchiveGroupAction,
} from './actions.ts';
import {
  ArchiveDialog,
  CoverDialog,
  TransferDialog,
  type EnvelopeChoice,
} from './MoveMoney.tsx';

export type MonthFigures = Record<
  string,
  { plannedCents: number; spentCents: number; allocatedCents: number }
>;

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

type Result = { ok: true; message?: string } | { ok: false; error: string };

export default function EnvelopeManager({
  groups,
  figures,
  monthLabel,
}: {
  groups: ManagedGroup[];
  figures: MonthFigures;
  monthLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
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
          <button className="primary" onClick={() => { setTransferFrom(null); setTransferOpen(true); }}>
            Move money
          </button>
        </div>
        <p className="muted">
          Balances carry over month to month. Planned and spent are for {monthLabel}; the balance is
          everything that has ever happened to the envelope.
        </p>
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

            {envelopes.map((envelope, index) => {
              const month = figures[envelope.id];
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
                    {month ? (
                      <>
                        planned {money(month.plannedCents)} · spent {money(month.spentCents)}
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
                    <button onClick={() => rename(envelope.id, envelope.name)} disabled={pending}>
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
                  </span>
                </div>
              );
            })}

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
          </details>
        );
      })}

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

      {(archivedEnvelopes.length > 0 || archivedGroups.length > 0) && (
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
