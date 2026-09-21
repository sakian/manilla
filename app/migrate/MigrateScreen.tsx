'use client';

/**
 * The migration wizard (MG-1 to MG-7).
 *
 * Four steps, and the order matters: read the files, decide what every envelope
 * and account becomes, look at what will be written *and what cannot be*, then
 * commit. The reconciliation step comes last because it can only be answered
 * once the history is in.
 *
 * The step that carries the most weight is the third one. Phase 0 established
 * that "Fill Envelopes" rows carry no amounts, so past envelope balances cannot
 * be rebuilt from the export at all - only past spending. Saying that plainly,
 * before anything is written, is the difference between a migration you can trust
 * and one that quietly comes out short.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AccountChoice,
  EnvelopeChoice,
  MigrationMapping,
} from '../../src/migrate/migrate.ts';
import {
  DEFAULT_SOURCE,
  MIGRATION_SOURCES,
  migrationSource,
  type MigrationSourceId,
} from '../../src/migrate/sources.ts';
import { centsFromInput, inputFromCents } from '../amount.ts';
import { Hint } from '../Hint.tsx';
import {
  applyReconciliationAction,
  commitMigrationAction,
  planMigrationAction,
  revertMigrationAction,
  type PlanSummary,
} from './actions.ts';
import { formatMoney } from '../../src/money.ts';

type Step = 'files' | 'mapping' | 'report' | 'done';

const ACCOUNT_KINDS = ['chequing', 'savings', 'credit_card', 'cash', 'line_of_credit'] as const;
type AccountKind = (typeof ACCOUNT_KINDS)[number];

/**
 * The rows-with-no-account choice as the server takes it. Following an export
 * account sends that account's own choice: a created account is matched by name,
 * so both land in the one account rather than two with the same name.
 */
function defaultAccountChoice(
  value: string,
  created: { name: string; kind: AccountKind },
  accountChoices: Record<string, AccountChoice>,
): AccountChoice | null {
  if (value.startsWith('export:')) return accountChoices[value.slice('export:'.length)] ?? null;
  if (value.startsWith('existing:')) {
    return { action: 'existing', accountId: value.slice('existing:'.length) };
  }
  const name = created.name.trim();
  return name ? { action: 'create', name, kind: created.kind } : null;
}

/** `Vehicle:Gas` becomes group "Vehicle", name "Gas". */
function splitName(full: string): { group: string; name: string } {
  const at = full.indexOf(':');
  if (at < 0) return { group: 'Migrated', name: full };
  return { group: full.slice(0, at).trim(), name: full.slice(at + 1).trim() };
}

export default function MigrateScreen({
  envelopes,
  accounts,
}: {
  envelopes: {
    id: string;
    name: string;
    groupName: string;
    isUnallocated: boolean;
    balanceCents: number;
  }[];
  accounts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<Step>('files');
  const [error, setError] = useState<string | null>(null);

  /**
   * Which app the file came from. The only place in the app an app is named to
   * the user: everything else - the notes written into envelope history, this
   * wizard's prose - stays neutral, so a second format is a row in the registry
   * and a reader, not a pass over every string on screen.
   */
  const [from, setFrom] = useState<MigrationSourceId>(DEFAULT_SOURCE);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [summary, setSummary] = useState<PlanSummary | null>(null);

  const [envelopeChoices, setEnvelopeChoices] = useState<Record<string, EnvelopeChoice>>({});
  const [accountChoices, setAccountChoices] = useState<Record<string, AccountChoice>>({});
  /**
   * Where rows that name no account go: `export:<name>` follows whatever that
   * export account becomes, `existing:<id>` is one already here, and `create`
   * is a new one. Offering only existing accounts left a fresh install - which
   * has none - with an empty list and a commit that could never succeed.
   */
  const [defaultAccount, setDefaultAccount] = useState('create');
  const [newDefault, setNewDefault] = useState<{ name: string; kind: AccountKind }>({
    name: 'Cash',
    kind: 'cash',
  });

  const [result, setResult] = useState<{
    batchId: string;
    added: number;
    duplicates: number;
    moves: number;
    transfers: number;
  } | null>(null);

  // Reconciliation, once the history is in.
  const [expected, setExpected] = useState<Record<string, string>>({});
  const [reconciled, setReconciled] = useState<number | null>(null);

  const readFiles = useCallback(
    async (chosen: FileList) => {
      const read = await Promise.all(
        [...chosen].map(async (file) => ({ name: file.name, text: await file.text() })),
      );
      setFiles(read);
      setError(null);

      startTransition(async () => {
        const planned = await planMigrationAction(read.map((file) => file.text), from);
        if (!planned.ok) {
          setError(planned.error);
          return;
        }

        // Default every envelope to being created under the group its name
        // already carries, which is what the export's `Group:Name` is for. The
        // pool is not offered: income always lands in the one Manilla has.
        const defaults: Record<string, EnvelopeChoice> = {};
        for (const envelope of planned.summary.envelopes) {
          if (envelope.name === '[Available]') continue;
          const { group, name } = splitName(envelope.name);
          const existing = envelopes.find(
            (candidate) =>
              !candidate.isUnallocated &&
              candidate.name.toLowerCase() === name.toLowerCase() &&
              candidate.groupName.toLowerCase() === group.toLowerCase(),
          );
          defaults[envelope.name] = existing
            ? { action: 'existing', envelopeId: existing.id }
            : { action: 'create', name, group };
        }

        const accountDefaults: Record<string, AccountChoice> = {};
        for (const account of planned.summary.accounts) {
          const existing = accounts.find(
            (candidate) => candidate.name.toLowerCase() === account.name.toLowerCase(),
          );
          accountDefaults[account.name] = existing
            ? { action: 'existing', accountId: existing.id }
            : { action: 'create', name: account.name, kind: 'chequing' };
        }

        // The export's busiest account is the likeliest home for rows it left
        // unnamed; failing that, one already here. The row is on screen either way.
        const busiest = planned.summary.accounts[0];
        setDefaultAccount(
          busiest ? `export:${busiest.name}` : accounts[0] ? `existing:${accounts[0].id}` : 'create',
        );

        setSummary(planned.summary);
        setEnvelopeChoices(defaults);
        setAccountChoices(accountDefaults);
        setStep('mapping');
      });
    },
    [accounts, envelopes, from],
  );

  const commit = useCallback(() => {
    if (!summary) return;
    setError(null);

    const mapping: MigrationMapping = {
      envelopes: envelopeChoices,
      accounts: accountChoices,
    };
    if (summary.needsDefaultAccount) {
      const chosen = defaultAccountChoice(defaultAccount, newDefault, accountChoices);
      if (!chosen) {
        setError('Choose where the rows that name no account should go.');
        return;
      }
      mapping.defaultAccount = chosen;
    }

    startTransition(async () => {
      const committed = await commitMigrationAction(
        files.map((file) => file.text),
        mapping,
        from,
        { filename: files.map((file) => file.name).join(', ') },
      );
      if (!committed.ok) {
        setError(committed.error);
        return;
      }
      setResult(committed);
      setStep('done');
      router.refresh();
    });
  }, [accountChoices, defaultAccount, envelopeChoices, files, from, newDefault, router, summary]);

  const undo = useCallback(() => {
    if (!result) return;
    if (!window.confirm('Undo the whole migration? Everything it wrote is removed.')) return;

    startTransition(async () => {
      const reverted = await revertMigrationAction(result.batchId);
      if (!reverted.ok) {
        setError(reverted.error);
        return;
      }
      setResult(null);
      setSummary(null);
      setFiles([]);
      setStep('files');
      router.refresh();
    });
  }, [result, router]);

  const applyAdjustments = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const adjustments: { envelopeId: string; differenceCents: number }[] = [];
      for (const envelope of envelopes) {
        if (envelope.isUnallocated) continue;
        const typed = expected[envelope.id];
        if (typed === undefined || typed.trim() === '') continue;
        try {
          adjustments.push({
            envelopeId: envelope.id,
            differenceCents: centsFromInput(typed) - envelope.balanceCents,
          });
        } catch {
          setError(`"${typed}" is not an amount`);
          return;
        }
      }

      const applied = await applyReconciliationAction(adjustments);
      if (!applied.ok) {
        setError(applied.error);
        return;
      }
      setReconciled(applied.written);
      router.refresh();
    });
  }, [envelopes, expected, router]);

  return (
    <>
      <div className="page-head">
        <h2>
          Bring in your budgeting history{' '}
          <Hint label="How the migration works">
          Years of transactions, their envelopes and their splits. Nothing is written until you have
            seen what it will do, and the whole thing can be undone in one step.
          </Hint>
        </h2>
      </div>

      {error && <p className="signin-error">{error}</p>}

      {step === 'files' && (
        <section className="panel">
          <h3>Choose your export</h3>

          <label className="field">
            <span>Where is it from?</span>
            <select
              value={from}
              disabled={pending}
              onChange={(event) => setFrom(event.target.value as MigrationSourceId)}
            >
              {MIGRATION_SOURCES.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
          {/* Under the list it explains. Below the file picker it was pulled up
              into the input by .footnote's negative margin. */}
          {MIGRATION_SOURCES.length === 1 && (
            <p className="muted footnote">
              One app so far. Another would need a reader for its own row shape, not just a name in
              this list — so it is a real piece of work rather than a setting.
            </p>
          )}

          <p className="muted">
            {migrationSource(from).hint} Rows that appear in more than one file are recognised and
            brought in only once.
          </p>

          <input
            type="file"
            accept=".csv,text/csv"
            multiple
            disabled={pending}
            onChange={(event) => {
              const chosen = event.target.files;
              if (chosen && chosen.length > 0) void readFiles(chosen);
            }}
          />
          {pending && <p className="muted">Reading…</p>}

        </section>
      )}

      {step === 'mapping' && summary && (
        <>
          <div className="callouts">
            <div className="callout">
              <strong>{summary.willWrite.transactions.toLocaleString()}</strong> transactions
            </div>
            <div className="callout">
              <strong>{summary.willWrite.moves}</strong> envelope transfers
            </div>
            <div className="callout">
              <strong>{summary.willWrite.transfers}</strong> account transfers
            </div>
            {summary.dateRange && (
              <div className="callout">
                {summary.dateRange.from} to {summary.dateRange.to}
              </div>
            )}
          </div>

          <p className="muted footnote">
            Dates read as {summary.dateFormat.toUpperCase()} — {summary.dateEvidence}.
          </p>

          <section className="panel">
            <h3>Envelopes</h3>
            <p className="muted">
              Each one can be created here or merged into an envelope you already have. Renaming
              now is easier than renaming six years of history later (MG-3).
            </p>

            <div className="map-table">
              <div className="map-row map-head" aria-hidden="true">
                <span className="map-name">In the export · rows</span>
                <span>Becomes</span>
                <span>Group</span>
                <span>Name</span>
              </div>
              {summary.envelopes
                .filter((envelope) => envelope.name !== '[Available]')
                .map((envelope) => {
                  const choice = envelopeChoices[envelope.name];
                  if (!choice) return null;
                  return (
                    <div key={envelope.name} className="map-row">
                      <span className="map-name">
                        {envelope.name}
                        <span className="muted"> · {envelope.uses}</span>
                      </span>

                      <select
                        value={choice.action === 'existing' ? choice.envelopeId : '__create__'}
                        onChange={(event) => {
                          const value = event.target.value;
                          const { group, name } = splitName(envelope.name);
                          setEnvelopeChoices((current) => ({
                            ...current,
                            [envelope.name]:
                              value === '__create__'
                                ? { action: 'create', name, group }
                                : { action: 'existing', envelopeId: value },
                          }));
                        }}
                      >
                        <option value="__create__">Create it</option>
                        {envelopes
                          .filter((candidate) => !candidate.isUnallocated)
                          .map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.groupName} · {candidate.name}
                            </option>
                          ))}
                      </select>

                      {choice.action === 'create' && (
                        <>
                          <input
                            value={choice.group}
                            aria-label={`Group for ${envelope.name}`}
                            onChange={(event) =>
                              setEnvelopeChoices((current) => ({
                                ...current,
                                [envelope.name]: { ...choice, group: event.target.value },
                              }))
                            }
                          />
                          <input
                            value={choice.name}
                            aria-label={`Name for ${envelope.name}`}
                            onChange={(event) =>
                              setEnvelopeChoices((current) => ({
                                ...current,
                                [envelope.name]: { ...choice, name: event.target.value },
                              }))
                            }
                          />
                        </>
                      )}
                    </div>
                  );
                })}
            </div>
            <p className="muted footnote">
              <code>[Available]</code> is the export&rsquo;s own unallocated pool, so its income
              goes straight into yours — there is nothing to decide about it.
            </p>
          </section>

          <section className="panel">
            <h3>Accounts</h3>
            <div className="map-table">
              <div className="map-row map-head" aria-hidden="true">
                <span className="map-name">In the export · rows</span>
                <span>Becomes</span>
                <span>Name</span>
                <span>Kind</span>
              </div>
              {summary.accounts.map((account) => {
                const choice = accountChoices[account.name];
                if (!choice) return null;
                return (
                  <div key={account.name} className="map-row">
                    <span className="map-name">
                      {account.name}
                      <span className="muted"> · {account.uses}</span>
                    </span>

                    <select
                      value={choice.action === 'existing' ? choice.accountId : '__create__'}
                      aria-label={`What ${account.name} becomes`}
                      onChange={(event) => {
                        const value = event.target.value;
                        setAccountChoices((current) => ({
                          ...current,
                          [account.name]:
                            value === '__create__'
                              ? { action: 'create', name: account.name, kind: 'chequing' }
                              : { action: 'existing', accountId: value },
                        }));
                      }}
                    >
                      <option value="__create__">Create it</option>
                      {accounts.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>

                    {choice.action === 'create' && (
                      <>
                        <input
                          value={choice.name}
                          aria-label={`Name for ${account.name}`}
                          onChange={(event) =>
                            setAccountChoices((current) => ({
                              ...current,
                              [account.name]: { ...choice, name: event.target.value },
                            }))
                          }
                        />
                        <KindSelect
                          value={choice.kind}
                          label={`Kind of account for ${account.name}`}
                          onChange={(kind) =>
                            setAccountChoices((current) => ({
                              ...current,
                              [account.name]: { ...choice, kind },
                            }))
                          }
                        />
                      </>
                    )}
                  </div>
                );
              })}

              {summary.needsDefaultAccount && (
                <div className="map-row">
                  <span className="map-name">
                    <em>No account named</em>
                    <span className="muted"> · {summary.rowsWithoutAccount}</span>
                  </span>

                  <select
                    value={defaultAccount}
                    aria-label="Where rows that name no account go"
                    onChange={(event) => setDefaultAccount(event.target.value)}
                  >
                    {summary.accounts.length > 0 && (
                      <optgroup label="In this export">
                        {summary.accounts.map((account) => (
                          <option key={account.name} value={`export:${account.name}`}>
                            Same as {account.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {accounts.length > 0 && (
                      <optgroup label="Already here">
                        {accounts.map((account) => (
                          <option key={account.id} value={`existing:${account.id}`}>
                            {account.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="create">A new account</option>
                  </select>

                  {defaultAccount === 'create' && (
                    <>
                      <input
                        value={newDefault.name}
                        aria-label="Name for the new account"
                        onChange={(event) =>
                          setNewDefault((current) => ({ ...current, name: event.target.value }))
                        }
                      />
                      <KindSelect
                        value={newDefault.kind}
                        label="Kind of the new account"
                        onChange={(kind) => setNewDefault((current) => ({ ...current, kind }))}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
            {summary.needsDefaultAccount && (
              <p className="muted footnote">
                Rows the export records with no account still moved real money, so they need an
                account to belong to.
              </p>
            )}
          </section>

          <div className="signin-actions">
            <button className="primary" onClick={() => setStep('report')} disabled={pending}>
              Next: what this will do
            </button>
            <button onClick={() => setStep('files')} disabled={pending}>
              Back
            </button>
          </div>
        </>
      )}

      {step === 'report' && summary && (
        <>
          <section className="panel">
            <h3>What will be written</h3>
            <div className="row">
              <span>Transactions</span>
              <span>{summary.willWrite.transactions.toLocaleString()}</span>
            </div>
            <div className="row">
              <span>Envelope shares of them</span>
              <span>{summary.willWrite.lines.toLocaleString()}</span>
            </div>
            <div className="row">
              <span>Envelope-to-envelope transfers</span>
              <span>{summary.willWrite.moves}</span>
            </div>
            <div className="row">
              <span>Transfers between your accounts</span>
              <span>{summary.willWrite.transfers}</span>
            </div>
            <p className="muted footnote">
              All of it arrives confirmed, because you already categorized it where it came from
              (MG-5).
            </p>
          </section>

          <section className="panel">
            <h3>What cannot come across</h3>
            <p className="budget-warning">
              {summary.counts.fill ?? 0} &ldquo;Fill Envelopes&rdquo; rows carry no amounts and no
              per-envelope breakdown, so the money that was <em>put into</em> envelopes over the
              years is not in this export at all. Past <em>spending</em> rebuilds exactly; past
              envelope <em>balances</em> do not. The last step of this wizard is where you enter
              what your old app shows today, and the difference is recorded as a dated adjustment.
            </p>

            {summary.unrepresentable.length > 0 ? (
              <>
                <p className="muted">
                  {summary.unrepresentable.length} rows cannot be reproduced and will be left out
                  rather than guessed at (MG-4):
                </p>
                <div className="import-table">
                  {summary.unrepresentable.slice(0, 25).map((item) => (
                    <div key={item.row} className="row">
                      <span className="muted">row {item.row}</span>
                      <span>{item.reason}</span>
                    </div>
                  ))}
                </div>
                {summary.unrepresentable.length > 25 && (
                  <p className="muted footnote">
                    …and {summary.unrepresentable.length - 25} more.
                  </p>
                )}
              </>
            ) : (
              <p className="muted">
                Every other row in the file can be reproduced exactly.
              </p>
            )}

            {summary.warnings.map((warning) => (
              <p key={warning} className="budget-warning">
                {warning}
              </p>
            ))}
          </section>

          <div className="signin-actions">
            <button className="primary" onClick={commit} disabled={pending}>
              {pending ? 'Writing…' : 'Bring it all in'}
            </button>
            <button onClick={() => setStep('mapping')} disabled={pending}>
              Back
            </button>
          </div>
        </>
      )}

      {step === 'done' && result && (
        <>
          <section className="panel">
            <h3>Migrated</h3>
            <p className="muted">
              {result.added.toLocaleString()} transactions, {result.transfers} account transfers and{' '}
              {result.moves} envelope transfers are in.
              {result.duplicates > 0 && ` ${result.duplicates} were already here and were left alone.`}
            </p>
            <div className="signin-actions">
              <button onClick={undo} disabled={pending}>
                Undo the whole migration
              </button>
            </div>
          </section>

          <section className="panel">
            <h3>Reconcile the balances (MG-7)</h3>
            <p className="muted">
              Every envelope is now short by whatever was filled into it over the years, because the
              export does not record that. Type what your old app shows for each one today and the
              difference is written as a dated adjustment out of the income pool — visible in the
              envelope&rsquo;s history, not a number from nowhere. Leave one blank to skip it.
            </p>

            {reconciled === null ? (
              <>
                <div className="map-table">
                  {envelopes
                    .filter((envelope) => !envelope.isUnallocated)
                    .map((envelope) => (
                      <div key={envelope.id} className="map-row reconcile">
                        <span className="map-name">
                          <span className="muted">{envelope.groupName}</span> {envelope.name}
                          <span className="muted"> · now {formatMoney(envelope.balanceCents)}</span>
                        </span>
                        <input
                          className="amount"
                          inputMode="decimal"
                          placeholder={inputFromCents(envelope.balanceCents)}
                          value={expected[envelope.id] ?? ''}
                          onChange={(event) =>
                            setExpected((current) => ({
                              ...current,
                              [envelope.id]: event.target.value,
                            }))
                          }
                        />
                      </div>
                    ))}
                </div>
                <div className="signin-actions">
                  <button className="primary" onClick={applyAdjustments} disabled={pending}>
                    {pending ? 'Adjusting…' : 'Make the balances match'}
                  </button>
                </div>
              </>
            ) : (
              <p className="queue-note">
                {reconciled} {reconciled === 1 ? 'envelope' : 'envelopes'} adjusted. Check the
                dashboard: envelopes and accounts should still agree, and the income pool holds
                whatever is left over.
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}

function KindSelect({
  value,
  label,
  onChange,
}: {
  value: AccountKind;
  label: string;
  onChange: (kind: AccountKind) => void;
}) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value as AccountKind)}
    >
      {ACCOUNT_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {kind.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}
