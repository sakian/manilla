import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OTHER_SIDE_PARAMS, draftFrom, draftQuery, otherSideOf } from './otherSide.ts';

const fromQuery = (query: Record<string, string>) => draftFrom((name) => query[name] ?? null);

describe('the other side of money that crossed ledgers', () => {
  test('money out of one ledger is money into the other, same amount and day', () => {
    assert.deepEqual(
      otherSideOf({ amountCents: -300000, date: '2026-09-30', payee: "Owner's draw" }, 'Business'),
      {
        amountCents: 300000,
        direction: 'in',
        date: '2026-09-30',
        payee: "Owner's draw",
        note: 'Other side of "Owner\'s draw" in Business',
      },
    );
    assert.equal(
      otherSideOf({ amountCents: 7500, date: '2026-09-30', payee: 'Repayment' }, 'Personal').direction,
      'out',
      'and the reverse',
    );
  });

  test('it survives the trip through the URL exactly', () => {
    const draft = otherSideOf({ amountCents: -123456, date: '2026-02-28', payee: 'A & B?=c' }, 'Biz');
    assert.deepEqual(fromQuery(draftQuery(draft)), draft);
    assert.deepEqual(Object.keys(draftQuery(draft)).sort(), [...OTHER_SIDE_PARAMS].sort());
  });

  test("its parameters are the draft's own, not the screen's filters", () => {
    for (const name of OTHER_SIDE_PARAMS) {
      assert.ok(!['payee', 'date', 'dir', 'from', 'to', 'min', 'max'].includes(name), name);
    }
  });

  test('a draft from the URL is checked before anyone sees it', () => {
    const good = draftQuery(otherSideOf({ amountCents: -5000, date: '2026-09-30', payee: 'X' }, 'Y'));
    const without = (changes: Record<string, string>) => fromQuery({ ...good, ...changes });

    assert.equal(without({ sideAmount: '0' }), null, 'nothing to record');
    assert.equal(without({ sideAmount: '-5000' }), null, 'the sign is the direction, not the amount');
    assert.equal(without({ sideAmount: '50.00' }), null, 'cents, never a decimal');
    assert.equal(without({ sideAmount: '1e3' }), null);
    assert.equal(without({ sideDir: 'sideways' }), null);
    assert.equal(without({ sideDate: '2026-02-30' }), null, 'not a day that exists');
    assert.equal(without({ sideDate: '30/09/2026' }), null);
    assert.equal(without({ sideNote: 'x'.repeat(501) }), null);
    assert.equal(fromQuery({}), null, 'no draft at all');
  });

  test('a saved transaction with no amount, or no real date, has no other side', () => {
    assert.throws(() => otherSideOf({ amountCents: 0, date: '2026-09-30', payee: 'X' }, 'Y'));
    assert.throws(() => otherSideOf({ amountCents: 12.5, date: '2026-09-30', payee: 'X' }, 'Y'));
    assert.throws(() => otherSideOf({ amountCents: 100, date: 'today', payee: 'X' }, 'Y'));
  });
});
