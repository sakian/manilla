import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { testServerUrl } from '../ledger/testdb.ts';
import { databaseNotUpYet, retryWhileDatabaseStarts, rootMessage } from './boot.ts';
import { prepareEveryLedger } from './registry.ts';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** What the app logged after the power cut: drizzle's error, wrapped by the registry's. */
function startingUp(): Error {
  const postgres = pgError('57P03', 'the database system is starting up');
  const drizzle = new Error('Failed query: select 1 from pg_database where datname = $1', { cause: postgres });
  return new Error('the home ledger (manilla) could not be brought up: Failed query', { cause: drizzle });
}

/** A clock that moves only when slept on. */
function fakeTime() {
  let at = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => at,
    sleep: async (ms: number) => {
      slept.push(ms);
      at += ms;
    },
  };
}

describe('waiting for the database at boot', () => {
  test('a database still recovering is not up yet, however deeply wrapped', () => {
    assert.equal(databaseNotUpYet(startingUp()), true);
    assert.equal(databaseNotUpYet(pgError('08006', 'connection failure')), true);
  });

  test('anything else is a real failure', () => {
    assert.equal(databaseNotUpYet(pgError('42P01', 'relation "envelopes" does not exist')), false);
    assert.equal(databaseNotUpYet(new Error('MANILLA_RP_ID is localhost')), false);
    assert.equal(databaseNotUpYet(undefined), false);
  });

  test('the message that says what happened is the innermost one', () => {
    assert.equal(rootMessage(startingUp()), 'the database system is starting up');
  });

  test('a database that comes up is waited for', async () => {
    const time = fakeTime();
    const lines: string[] = [];
    let tries = 0;
    const result = await retryWhileDatabaseStarts(
      async () => {
        tries += 1;
        if (tries < 4) throw startingUp();
        return 'up';
      },
      { ...time, log: (line) => lines.push(line) },
    );
    assert.equal(result, 'up');
    assert.deepEqual(time.slept, [1_000, 2_000, 4_000]);
    assert.match(lines[0]!, /not up yet \(the database system is starting up\)/);
  });

  test('a real failure is not retried', async () => {
    const time = fakeTime();
    await assert.rejects(
      retryWhileDatabaseStarts(async () => {
        throw pgError('42P01', 'relation "envelopes" does not exist');
      }, time),
      /relation "envelopes"/,
    );
    assert.deepEqual(time.slept, []);
  });

  test('a database that never comes up is given up on', async () => {
    const time = fakeTime();
    await assert.rejects(
      retryWhileDatabaseStarts(async () => {
        throw startingUp();
      }, { ...time, forMs: 30_000 }),
      /could not be brought up/,
    );
    assert.ok(time.slept.reduce((sum, ms) => sum + ms, 0) <= 30_000);
    assert.ok(time.slept.every((ms) => ms <= 10_000));
  });

  test('nothing listening is the real thing recognised as not up yet', async () => {
    // No Postgres needed: the point is the error a refused connection really
    // produces once it has come through drizzle and the registry.
    const unreachable = testServerUrl.replace(/:\d+\//, ':1/');
    const error = await prepareEveryLedger(unreachable).catch((caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.equal(databaseNotUpYet(error), true);
  });
});
