import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LedgerConfigError,
  chooseLedger,
  cleanLedgerName,
  databaseNameFor,
  databaseOf,
  urlFor,
  type Ledger,
} from './config.ts';

const HOME = 'postgres://manilla:secret@db:5432/manilla';

describe('naming ledgers', () => {
  test('a name is trimmed, and has to be there and short enough to show', () => {
    assert.equal(cleanLedgerName('  Side   business '), 'Side business');
    assert.throws(() => cleanLedgerName('   '), LedgerConfigError);
    assert.throws(() => cleanLedgerName('x'.repeat(41)), LedgerConfigError);
  });

  test('a new ledger gets <home>_ledger_<name>, clear of restore and test databases', () => {
    const none = new Set<string>();
    assert.equal(databaseNameFor('manilla', 'Business', none), 'manilla_ledger_business');
    assert.equal(databaseNameFor('manilla', 'Café & Co.', none), 'manilla_ledger_cafe_co');
    assert.equal(databaseNameFor('manilla', 'Restore check', none), 'manilla_ledger_restore_check');
    assert.equal(databaseNameFor('manilla', '!!!', none), 'manilla_ledger_book', 'nothing usable');
    assert.equal(
      databaseNameFor('Not-A-Valid-Name', 'Business', none),
      'manilla_ledger_business',
      'an odd home database name is not copied into a new one',
    );
  });

  test('an existing database is never adopted: a clash gets a number', () => {
    const taken = new Set(['manilla_ledger_business', 'manilla_ledger_business_2']);
    assert.equal(databaseNameFor('manilla', 'Business', taken), 'manilla_ledger_business_3');
  });

  test('a long name still makes a name Postgres accepts', () => {
    const name = databaseNameFor('manilla', 'b'.repeat(40), new Set());
    assert.ok(name.length <= 60);
    assert.match(name, /^[a-z][a-z0-9_]*$/);
  });
});

describe('choosing and reaching a ledger', () => {
  const ledgers: Ledger[] = [
    { key: 'manilla', name: 'Personal', database: 'manilla' },
    { key: 'manilla_ledger_business', name: 'Business', database: 'manilla_ledger_business' },
  ];

  test('the cookie only ever picks from the list', () => {
    assert.equal(chooseLedger(ledgers, 'manilla_ledger_business').name, 'Business');
    assert.equal(chooseLedger(ledgers, undefined).name, 'Personal', 'no cookie: the home one');
    assert.equal(chooseLedger(ledgers, 'postgres').name, 'Personal', 'not listed: the home one');
    assert.equal(chooseLedger(ledgers, 'Business').name, 'Personal', 'a name is not a key');
  });

  test('another ledger is the same server and credentials, another database', () => {
    assert.equal(databaseOf(HOME), 'manilla');
    assert.equal(
      urlFor(HOME, 'manilla_ledger_business'),
      'postgres://manilla:secret@db:5432/manilla_ledger_business',
    );
    assert.equal(
      urlFor(`${HOME}?sslmode=require`, 'manilla_ledger_business'),
      'postgres://manilla:secret@db:5432/manilla_ledger_business?sslmode=require',
      'connection options carry over',
    );
  });
});
