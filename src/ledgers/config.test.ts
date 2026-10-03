import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LedgerConfigError,
  chooseLedger,
  configuredLedgers,
  databaseOf,
  parseLedgers,
  urlFor,
} from './config.ts';

const HOME = 'postgres://manilla:secret@db:5432/manilla';

describe('ledger configuration', () => {
  test('unset, there is one ledger: the database in DATABASE_URL', () => {
    assert.deepEqual(parseLedgers(undefined, 'manilla'), [
      { key: 'manilla', name: 'Manilla', database: 'manilla' },
    ]);
    assert.equal(parseLedgers('  ', 'manilla').length, 1, 'blank is the same as unset');
  });

  test('each entry is a name to show and the database it lives in', () => {
    assert.deepEqual(parseLedgers(' Personal = manilla , Business=manilla_business,', 'manilla'), [
      { key: 'manilla', name: 'Personal', database: 'manilla' },
      { key: 'manilla_business', name: 'Business', database: 'manilla_business' },
    ]);
  });

  test('the home database has to be one of them, so nothing recorded so far is hidden', () => {
    assert.throws(
      () => parseLedgers('Business=manilla_business', 'manilla'),
      (error: unknown) =>
        error instanceof LedgerConfigError && /must include manilla/.test(error.message),
    );
  });

  test('anything ambiguous is refused rather than guessed', () => {
    const refused = (spec: string) =>
      assert.throws(() => parseLedgers(spec, 'manilla'), LedgerConfigError, spec);

    refused('manilla'); // no name
    refused('=manilla'); // empty name
    refused('Personal=manilla,Business=Manilla_Business'); // not lowercase
    refused('Personal=manilla,Business=manilla-business'); // hyphen: ambiguous backup names
    refused('Personal=manilla,Business=1business'); // starts with a digit
    refused('Personal=manilla,Other=manilla'); // one database twice
    refused('Personal=manilla,personal=manilla_two'); // two names alike
    refused(`${'x'.repeat(41)}=manilla`); // a name too long to show
  });

  test('the cookie only ever picks from the list', () => {
    const ledgers = parseLedgers('Personal=manilla,Business=manilla_business', 'manilla');
    assert.equal(chooseLedger(ledgers, 'manilla_business').name, 'Business');
    assert.equal(chooseLedger(ledgers, undefined).name, 'Personal', 'no cookie: the first');
    assert.equal(chooseLedger(ledgers, 'postgres').name, 'Personal', 'not listed: the first');
    assert.equal(chooseLedger(ledgers, 'Business').name, 'Personal', 'a name is not a key');
  });

  test('another ledger is the same server and credentials, another database', () => {
    assert.equal(databaseOf(HOME), 'manilla');
    assert.equal(urlFor(HOME, 'manilla_business'), 'postgres://manilla:secret@db:5432/manilla_business');
    assert.equal(
      urlFor('postgres://manilla:secret@db:5432/manilla?sslmode=require', 'manilla_business'),
      'postgres://manilla:secret@db:5432/manilla_business?sslmode=require',
      'connection options carry over',
    );
  });

  test('read from the environment, DATABASE_URL naming the home ledger', () => {
    const ledgers = configuredLedgers({
      DATABASE_URL: HOME,
      MANILLA_LEDGERS: 'Personal=manilla,Business=manilla_business',
    });
    assert.deepEqual(
      ledgers.map((ledger) => ledger.database),
      ['manilla', 'manilla_business'],
    );
    assert.throws(() => configuredLedgers({}), /DATABASE_URL is not set/);
  });
});
