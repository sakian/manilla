import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { openAccount, recordTransaction } from '../ledger/ledger.ts';
import { fundEnvelopes, setPlanned } from '../budget/budget.ts';
import { attention, type AttentionKind } from './notices.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';

const available = await databaseAvailable();

describe(
  'what needs attention',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let accountId: string;

    before(async () => {
      db = await setupTestDb('notices');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    const kinds = async (): Promise<AttentionKind[]> =>
      (await attention(db, '2026-09')).notices.map((notice) => notice.kind);

    const receiveIncome = (cents: number, date = '2026-09-01') =>
      recordTransaction(db, {
        accountId,
        date,
        amountCents: cents,
        payeeRaw: 'PAYROLL',
        status: 'confirmed',
        lines: [{ envelopeId: env.unallocatedId, amountCents: cents }],
      });

    test('an untouched ledger says where to start, and nothing else', async () => {
      assert.deepEqual(await kinds(), ['nothing_recorded']);
    });

    test('income arriving becomes something to allocate', async () => {
      await receiveIncome(400000);
      assert.deepEqual(await kinds(), ['unallocated']);
    });

    test('an uncategorized import is a nudge, not a broken ledger', async () => {
      await recordTransaction(db, {
        accountId,
        date: '2026-09-04',
        amountCents: -4250,
        payeeRaw: 'PETRO CANADA',
        source: 'file_import',
      });

      const report = await attention(db, '2026-09');
      assert.deepEqual(
        report.notices.map((notice) => notice.kind),
        ['awaiting_review'],
      );
      assert.equal(
        report.anyBad,
        false,
        'uncategorized money is counted by the invariant, so the books still agree',
      );
      assert.equal(report.notices[0]!.count, 1);
    });

    test('an overspent envelope needs a decision', async () => {
      await receiveIncome(400000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 10000 }], {
        today: '2026-09-19',
      });
      await recordTransaction(db, {
        accountId,
        date: '2026-09-10',
        amountCents: -25000,
        payeeRaw: 'SHELL',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -25000 }],
      });

      const report = await attention(db, '2026-09');
      const overspent = report.notices.find((notice) => notice.kind === 'envelopes_overspent');
      assert.ok(overspent);
      assert.equal(overspent.severity, 'warn');
      assert.equal(overspent.count, 1);
    });

    test('allocating past what has arrived is a bad state, and says by how much', async () => {
      await receiveIncome(10000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 30000 }], {
        today: '2026-09-19',
      });

      const report = await attention(db, '2026-09');
      const overdrawn = report.notices.find((notice) => notice.kind === 'pool_overdrawn');
      assert.ok(overdrawn);
      assert.equal(overdrawn.severity, 'bad');
      assert.equal(overdrawn.cents, 20000);
      assert.ok(report.anyBad);
    });

    test('a plan beyond the income there is to fund it is a warning (FR-31)', async () => {
      await receiveIncome(100000, '2026-08-01');
      await setPlanned(db, env.gasId, 900000);

      const report = await attention(db, '2026-09');
      const exceeds = report.notices.find((notice) => notice.kind === 'plan_exceeds_income');
      assert.ok(exceeds, 'the warning the budget screen used to carry');
      assert.equal(exceeds.cents, 900000);
      assert.equal(exceeds.againstCents, 100000);
    });

    test('notices are severity-ranked, worst first', async () => {
      await receiveIncome(10000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 30000 }], {
        today: '2026-09-19',
      });
      await recordTransaction(db, {
        accountId,
        date: '2026-09-11',
        amountCents: -9999,
        payeeRaw: 'UNSORTED',
        source: 'file_import',
      });

      const report = await attention(db, '2026-09');
      const rank = { bad: 0, warn: 1, info: 2 } as const;
      const order = report.notices.map((notice) => rank[notice.severity]);
      assert.deepEqual(order, [...order].sort(), 'already in the order a screen should show them');
      assert.equal(report.notices[0]!.severity, 'bad');
    });

    test('rules worth suggesting are read from the count, not searched for', async () => {
      const { refreshRuleSuggestionCount } = await import('../rules/rules.ts');

      // Nothing cached: the notices say nothing about rules, and cost nothing
      // finding that out.
      assert.ok(!(await kinds()).includes('rules_to_suggest'));

      for (let at = 0; at < 6; at += 1) {
        await recordTransaction(db, {
          accountId,
          date: '2026-09-02',
          amountCents: -1000 - at,
          payeeRaw: 'NETFLIX.COM',
          status: 'confirmed',
          source: 'file_import',
          lines: [{ envelopeId: env.gasId, amountCents: -1000 - at }],
        });
      }

      // Still silent until something recounts - the search is too expensive to
      // run on every screen, so it runs when the answer could have changed.
      assert.ok(!(await kinds()).includes('rules_to_suggest'));

      await refreshRuleSuggestionCount(db);

      const report = await attention(db, '2026-09');
      const notice = report.notices.find((item) => item.kind === 'rules_to_suggest');
      assert.ok(notice);
      assert.equal(notice.count, 1);
      assert.equal(notice.severity, 'info');
    });

    test('a settled month is quiet', async () => {
      await receiveIncome(30000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 30000 }], {
        today: '2026-09-19',
      });
      await recordTransaction(db, {
        accountId,
        date: '2026-09-12',
        amountCents: -25000,
        payeeRaw: 'SHELL',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -25000 }],
      });

      assert.deepEqual(await kinds(), [], 'nothing to say means nothing shown');
    });
  },
);
