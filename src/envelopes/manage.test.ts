import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { checkInvariant, openAccount, recordTransaction } from '../ledger/ledger.ts';
import { envelopeBalance } from '../budget/budget.ts';
import {
  EnvelopeError,
  archiveEnvelope,
  archiveGroup,
  createEnvelope,
  createGroup,
  editEnvelope,
  envelopeHistory,
  listEnvelopes,
  nudgeGroup,
  renameGroup,
  unarchiveEnvelope,
} from './manage.ts';
import {
  TransferError,
  coverFrom,
  coverPlan,
  transferBetweenEnvelopes,
  transferOptions,
} from './transfer.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { envelopes } from '../../db/schema.ts';

const available = await databaseAvailable();

describe(
  'envelope management and transfers',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let accountId: string;

    before(async () => {
      db = await setupTestDb('envelopes');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    const fund = async (envelopeId: string, cents: number, date = '2026-09-01') =>
      recordTransaction(db, {
        accountId,
        date,
        amountCents: cents,
        payeeRaw: 'DEPOSIT',
        status: 'confirmed',
        lines: [{ envelopeId, amountCents: cents }],
      });

    const spend = async (envelopeId: string, cents: number, date = '2026-09-10') =>
      recordTransaction(db, {
        accountId,
        date,
        amountCents: -cents,
        payeeRaw: 'ZEHRS 1234',
        status: 'confirmed',
        lines: [{ envelopeId, amountCents: -cents }],
      });

    // -- groups and envelopes (FR-21, FR-22) --------------------------------

    test('a group and its envelopes can be created and listed together', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const gasId = await createEnvelope(db, { groupId, name: 'Gas' });
      await createEnvelope(db, { groupId, name: 'Repairs' });

      const groups = await listEnvelopes(db);
      const vehicle = groups.find((group) => group.id === groupId)!;
      assert.deepEqual(
        vehicle.envelopes.map((envelope) => envelope.name),
        ['Gas', 'Repairs'],
        'in the order they were created',
      );
      assert.equal(vehicle.envelopes.find((envelope) => envelope.id === gasId)!.carryOver, true);
    });

    test('names are trimmed, and an empty one is refused', async () => {
      const groupId = await createGroup(db, '  Utilities  ');
      const groups = await listEnvelopes(db);
      assert.ok(groups.some((group) => group.name === 'Utilities'));

      await assert.rejects(() => createGroup(db, '   '), EnvelopeError);
      await assert.rejects(() => createEnvelope(db, { groupId, name: '' }), EnvelopeError);
      await assert.rejects(() => renameGroup(db, groupId, ''), EnvelopeError);
    });

    test('an envelope can be renamed and moved to another group', async () => {
      const vehicle = await createGroup(db, 'Vehicle');
      const home = await createGroup(db, 'Home');
      const id = await createEnvelope(db, { groupId: vehicle, name: 'Fuel' });

      await editEnvelope(db, id, { name: 'Gas', groupId: home, carryOver: false });

      const groups = await listEnvelopes(db);
      const moved = groups.find((group) => group.id === home)!.envelopes[0]!;
      assert.equal(moved.name, 'Gas');
      assert.equal(moved.carryOver, false);
      assert.equal(groups.find((group) => group.id === vehicle)!.envelopes.length, 0);
    });

    test('envelopes are listed alphabetically, whatever order they were made in', async () => {
      const groupId = await createGroup(db, 'Utilities');
      await createEnvelope(db, { groupId, name: 'Water' });
      await createEnvelope(db, { groupId, name: 'Electricity' });
      await createEnvelope(db, { groupId, name: 'Phone' });

      const groups = await listEnvelopes(db);
      assert.deepEqual(
        groups.find((group) => group.id === groupId)!.envelopes.map((envelope) => envelope.name),
        ['Electricity', 'Phone', 'Water'],
        'predictable to read down, rather than an order someone has to remember',
      );
    });

    test('an envelope moved to another group is alphabetical there too', async () => {
      const utilities = await createGroup(db, 'Utilities');
      const home = await createGroup(db, 'Home');
      await createEnvelope(db, { groupId: home, name: 'Mortgage' });
      await createEnvelope(db, { groupId: home, name: 'Repairs' });
      const phone = await createEnvelope(db, { groupId: utilities, name: 'Phone' });

      await editEnvelope(db, phone, { groupId: home });

      const groups = await listEnvelopes(db);
      assert.deepEqual(
        groups.find((group) => group.id === home)!.envelopes.map((envelope) => envelope.name),
        ['Mortgage', 'Phone', 'Repairs'],
      );
      assert.equal(groups.find((group) => group.id === utilities)!.envelopes.length, 0);
    });

    test('the income pool cannot be renamed or refiled', async () => {
      const other = await createGroup(db, 'Somewhere else');

      await assert.rejects(
        () => editEnvelope(db, env.unallocatedId, { name: 'Slush fund' }),
        EnvelopeError,
      );
      await assert.rejects(
        () => editEnvelope(db, env.unallocatedId, { groupId: other }),
        EnvelopeError,
      );

      // Unchanged, and still the one thing income is found by.
      const pool = (await listEnvelopes(db))
        .flatMap((group) => group.envelopes)
        .find((envelope) => envelope.isUnallocated)!;
      assert.equal(pool.name, 'Available');
      assert.equal(pool.groupName, 'Living');
    });

    test('nudging swaps a group with its neighbour and stops at the ends', async () => {
      // Groups keep a manual order: there are few of them, and "Income first,
      // Archive last" is a real preference rather than a lookup.
      const first = await createGroup(db, 'Vehicle');
      const second = await createGroup(db, 'Home');

      await nudgeGroup(db, second, 'up');
      let names = (await listEnvelopes(db)).map((group) => group.name);
      assert.deepEqual(names.slice(0, 3), ['Living', 'Home', 'Vehicle']);

      // Already as high as it goes past the seeded group: a no-op, not an error.
      await nudgeGroup(db, second, 'up');
      names = (await listEnvelopes(db)).map((group) => group.name);
      assert.deepEqual(names.slice(0, 3), ['Home', 'Living', 'Vehicle']);

      await nudgeGroup(db, second, 'up');
      names = (await listEnvelopes(db)).map((group) => group.name);
      assert.deepEqual(names.slice(0, 3), ['Home', 'Living', 'Vehicle']);
      assert.ok(first);
    });

    // -- archiving (FR-25) --------------------------------------------------

    test('an empty envelope archives and leaves the live list', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const id = await createEnvelope(db, { groupId, name: 'Repairs' });

      await archiveEnvelope(db, id);

      const live = await listEnvelopes(db);
      assert.equal(live.find((group) => group.id === groupId)!.envelopes.length, 0);

      const all = await listEnvelopes(db, { includeArchived: true });
      const archived = all.find((group) => group.id === groupId)!.envelopes[0]!;
      assert.ok(archived.archivedAt, 'but it is still there, archived');
    });

    test('an envelope holding money refuses to archive, and says how much (FR-25)', async () => {
      await fund(env.gasId, 12500);

      await assert.rejects(
        () => archiveEnvelope(db, env.gasId),
        (error: unknown) => {
          assert.ok(error instanceof EnvelopeError);
          assert.match(error.message, /\$125\.00/);
          return true;
        },
      );

      const all = await listEnvelopes(db, { includeArchived: true });
      const gas = all
        .flatMap((group) => group.envelopes)
        .find((envelope) => envelope.id === env.gasId)!;
      assert.equal(gas.archivedAt, null, 'nothing was archived');
    });

    test('an overspent envelope refuses to archive too', async () => {
      await spend(env.gasId, 4000);
      await assert.rejects(
        () => archiveEnvelope(db, env.gasId),
        (error: unknown) => {
          assert.ok(error instanceof EnvelopeError);
          assert.match(error.message, /overspent by \$40\.00/);
          return true;
        },
      );
    });

    test('archiving with a destination moves the balance first, in one step', async () => {
      await fund(env.gasId, 12500);

      await archiveEnvelope(db, env.gasId, {
        moveBalanceTo: env.groceriesId,
        today: '2026-09-19',
      });

      assert.equal(await envelopeBalance(db, env.gasId), 0);
      assert.equal(await envelopeBalance(db, env.groceriesId), 12500);
      assert.ok((await checkInvariant(db)).ok, 'and the two ledgers still agree');
    });

    test('archiving an overspent envelope covers it from the destination', async () => {
      await fund(env.groceriesId, 50000);
      await spend(env.gasId, 4000);

      await archiveEnvelope(db, env.gasId, {
        moveBalanceTo: env.groceriesId,
        today: '2026-09-19',
      });

      assert.equal(await envelopeBalance(db, env.gasId), 0);
      assert.equal(await envelopeBalance(db, env.groceriesId), 46000);
    });

    test('the income pool can never be archived', async () => {
      await assert.rejects(() => archiveEnvelope(db, env.unallocatedId), EnvelopeError);
    });

    test('a balance cannot be parked in an archived envelope', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const retired = await createEnvelope(db, { groupId, name: 'Old' });
      await archiveEnvelope(db, retired);
      await fund(env.gasId, 1000);

      await assert.rejects(
        () => archiveEnvelope(db, env.gasId, { moveBalanceTo: retired }),
        EnvelopeError,
      );
      assert.equal(await envelopeBalance(db, env.gasId), 1000, 'nothing moved');
    });

    test('a group with live envelopes will not archive', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      await createEnvelope(db, { groupId, name: 'Gas' });

      await assert.rejects(
        () => archiveGroup(db, groupId),
        (error: unknown) => {
          assert.ok(error instanceof EnvelopeError);
          assert.match(error.message, /Gas/);
          return true;
        },
      );
    });

    test('a group archives once its envelopes are archived', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const id = await createEnvelope(db, { groupId, name: 'Gas' });
      await archiveEnvelope(db, id);
      await archiveGroup(db, groupId);

      const live = await listEnvelopes(db);
      assert.equal(live.some((group) => group.id === groupId), false);
    });

    test('an envelope cannot be restored into an archived group', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const id = await createEnvelope(db, { groupId, name: 'Gas' });
      await archiveEnvelope(db, id);
      await archiveGroup(db, groupId);

      await assert.rejects(() => unarchiveEnvelope(db, id), EnvelopeError);
    });

    test('archiving twice is not an error', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const id = await createEnvelope(db, { groupId, name: 'Gas' });
      await archiveEnvelope(db, id);
      await archiveEnvelope(db, id);
      const [row] = await db.select().from(envelopes).where(eq(envelopes.id, id));
      assert.ok(row?.archivedAt);
    });

    // -- transfers (FR-34, FR-36) ------------------------------------------

    test('a transfer moves money between envelopes and touches no account', async () => {
      await fund(env.groceriesId, 50000);
      const before = await checkInvariant(db);

      await transferBetweenEnvelopes(db, {
        fromEnvelopeId: env.groceriesId,
        toEnvelopeId: env.gasId,
        amountCents: 15000,
        date: '2026-09-19',
        note: 'Filled up before the drive',
      });

      assert.equal(await envelopeBalance(db, env.groceriesId), 35000);
      assert.equal(await envelopeBalance(db, env.gasId), 15000);

      const after = await checkInvariant(db);
      assert.equal(after.accountTotalCents, before.accountTotalCents, 'no account changed');
      assert.ok(after.ok);
    });

    test('a transfer of zero or a negative amount is refused', async () => {
      for (const amountCents of [0, -500, 12.5]) {
        await assert.rejects(
          () =>
            transferBetweenEnvelopes(db, {
              fromEnvelopeId: env.groceriesId,
              toEnvelopeId: env.gasId,
              amountCents,
            }),
          TransferError,
        );
      }
    });

    test('a transfer to an archived envelope is refused', async () => {
      const groupId = await createGroup(db, 'Vehicle');
      const retired = await createEnvelope(db, { groupId, name: 'Old' });
      await archiveEnvelope(db, retired);

      await assert.rejects(
        () =>
          transferBetweenEnvelopes(db, {
            fromEnvelopeId: env.groceriesId,
            toEnvelopeId: retired,
            amountCents: 100,
          }),
        TransferError,
      );
    });

    test('a transfer shows up in both envelopes histories', async () => {
      await fund(env.groceriesId, 50000);
      await transferBetweenEnvelopes(db, {
        fromEnvelopeId: env.groceriesId,
        toEnvelopeId: env.gasId,
        amountCents: 15000,
        date: '2026-09-19',
        note: 'Road trip',
      });

      const gasHistory = await envelopeHistory(db, env.gasId);
      const incoming = gasHistory.find((event) => event.kind === 'transfer')!;
      assert.equal(incoming.amountCents, 15000, 'money in is positive');
      assert.equal(incoming.description, 'Road trip');

      const groceriesHistory = await envelopeHistory(db, env.groceriesId);
      const outgoing = groceriesHistory.find((event) => event.kind === 'transfer')!;
      assert.equal(outgoing.amountCents, -15000, 'and out is negative');
    });

    test('history lists spending newest first and marks what is unconfirmed', async () => {
      await fund(env.gasId, 20000, '2026-09-01');
      await recordTransaction(db, {
        accountId,
        date: '2026-09-15',
        amountCents: -4000,
        payeeRaw: 'SHELL 4471',
        lines: [{ envelopeId: env.gasId, amountCents: -4000 }],
      });

      const history = await envelopeHistory(db, env.gasId);
      assert.equal(history[0]!.date, '2026-09-15');
      assert.equal(history[0]!.pending, true, 'still in the review queue');
      assert.equal(history[1]!.pending, false);
    });

    // -- covering an overspend (FR-35) -------------------------------------

    test('cover suggests the pool first, then the fullest envelope', async () => {
      await fund(env.unallocatedId, 3000);
      await fund(env.groceriesId, 40000);
      await spend(env.gasId, 10000);

      const plan = await coverPlan(db, env.gasId);
      assert.equal(plan.neededCents, 10000);
      assert.deepEqual(
        plan.sources.map((source) => [source.name, source.proposedCents]),
        [
          ['Available', 3000],
          ['Groceries', 7000],
        ],
        'the pool is emptied first, the rest comes from the fullest envelope',
      );
      assert.equal(plan.proposedCents, 10000);
    });

    test('a proposal never pushes another envelope negative', async () => {
      await fund(env.groceriesId, 2500);
      await spend(env.gasId, 10000);

      const plan = await coverPlan(db, env.gasId);
      assert.equal(plan.neededCents, 10000);
      assert.equal(plan.proposedCents, 2500, 'only what there is');
      assert.equal(plan.sources[0]!.proposedCents, 2500);
    });

    test('an envelope that is not overspent needs nothing', async () => {
      await fund(env.gasId, 5000);
      const plan = await coverPlan(db, env.gasId);
      assert.equal(plan.neededCents, 0);
      assert.equal(plan.proposedCents, 0);
      assert.ok(plan.sources.every((source) => source.proposedCents === 0));
    });

    test('applying a cover clears the overspend as transfers', async () => {
      await fund(env.unallocatedId, 3000);
      await fund(env.groceriesId, 40000);
      await spend(env.gasId, 10000);

      const plan = await coverPlan(db, env.gasId);
      const moved = await coverFrom(
        db,
        env.gasId,
        plan.sources.map((source) => ({
          envelopeId: source.envelopeId,
          amountCents: source.proposedCents,
        })),
        { date: '2026-09-19' },
      );

      assert.equal(moved, 2);
      assert.equal(await envelopeBalance(db, env.gasId), 0);
      assert.equal(await envelopeBalance(db, env.unallocatedId), 0);
      assert.equal(await envelopeBalance(db, env.groceriesId), 33000);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an envelope cannot cover itself', async () => {
      await spend(env.gasId, 1000);
      await assert.rejects(
        () => coverFrom(db, env.gasId, [{ envelopeId: env.gasId, amountCents: 1000 }]),
        TransferError,
      );
    });

    test('transfer options leave out the envelope being moved from, and carry balances', async () => {
      await fund(env.groceriesId, 4200);
      const options = await transferOptions(db, env.gasId);

      assert.equal(options.some((option) => option.id === env.gasId), false);
      assert.ok(options.some((option) => option.id === env.unallocatedId));
      assert.equal(
        options.find((option) => option.id === env.groceriesId)!.balanceCents,
        4200,
        'so the picker can show what each envelope holds',
      );
    });
  },
);
