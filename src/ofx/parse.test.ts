import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOfx, parseOfxDate } from './parse.ts';

const sample = (name: string) => readFileSync(new URL(`../../data/samples/${name}`, import.meta.url), 'utf8');

test('OFX 1.x SGML with unclosed leaf tags', () => {
  const doc = parseOfx(sample('bank-ofx1.ofx'));

  assert.equal(doc.version, '1.x');
  assert.equal(doc.headers.VERSION, '102');
  assert.equal(doc.intuitBankId, '00003');
  assert.equal(doc.statements.length, 1);

  const statement = doc.statements[0]!;
  assert.equal(statement.kind, 'bank');
  assert.equal(statement.accountId, '1234567');
  assert.equal(statement.bankId, '000300002');
  assert.equal(statement.accountType, 'CHECKING');
  assert.equal(statement.currency, 'CAD');
  assert.equal(statement.start, '2025-08-01');
  assert.equal(statement.end, '2025-09-03');
  assert.equal(statement.ledgerBalanceCents, 482194);
  assert.equal(statement.transactions.length, 5);
});

test('transaction fields survive the SGML round trip', () => {
  const [statement] = parseOfx(sample('bank-ofx1.ofx')).statements;
  const byId = new Map(statement!.transactions.map((t) => [t.fitId, t]));

  const fuel = byId.get('20250903001')!;
  assert.equal(fuel.amountCents, -4520);
  assert.equal(fuel.posted, '2025-09-03');
  assert.equal(fuel.name, 'SHELL #4471 CALGARY AB');
  assert.equal(fuel.type, 'DEBIT');

  const groceries = byId.get('20250902001')!;
  assert.equal(groceries.amountCents, -120455, 'thousands separator handled');
  assert.equal(groceries.memo, 'POS PURCHASE');

  const pay = byId.get('20250901001')!;
  assert.equal(pay.amountCents, 320000, 'income is positive');

  assert.equal(byId.get('20250829001')!.checkNumber, '0142');
  assert.equal(byId.get('20250828001')!.name, 'EPCOR WATER & SEWER', 'entities decoded');
});

test('OFX 2.x XML with closed tags and a credit card account', () => {
  const doc = parseOfx(sample('creditcard-ofx2.ofx'));

  assert.equal(doc.version, '2.x');
  assert.equal(doc.headers.VERSION, '211');
  assert.equal(doc.statements.length, 1);

  const statement = doc.statements[0]!;
  assert.equal(statement.kind, 'creditcard');
  assert.equal(statement.accountId, '4510XXXXXXXX9021');
  assert.equal(statement.ledgerBalanceCents, -124018);
  assert.equal(statement.transactions.length, 3);

  const netflix = statement.transactions.find((t) => t.fitId === 'CC20250831AB')!;
  assert.equal(netflix.amountCents, -1899);
  assert.equal(netflix.payeeName, 'Netflix', 'structured <PAYEE> aggregate read');
  assert.equal(netflix.name, 'NETFLIX.COM');
});

test('every transaction carries a FITID for deduplication', () => {
  for (const file of ['bank-ofx1.ofx', 'creditcard-ofx2.ofx']) {
    for (const statement of parseOfx(sample(file)).statements) {
      const ids = statement.transactions.map((t) => t.fitId);
      assert.ok(ids.every(Boolean), `${file}: every transaction has a FITID`);
      assert.equal(new Set(ids).size, ids.length, `${file}: FITIDs are unique within the account`);
    }
  }
});

test('parsing is deterministic, so re-importing a file changes nothing', () => {
  const once = parseOfx(sample('bank-ofx1.ofx'));
  const twice = parseOfx(sample('bank-ofx1.ofx'));
  assert.deepEqual(once, twice);
});

test('dates keep the bank calendar day regardless of local timezone', () => {
  // A midnight posting with a -6 offset becomes the previous day if it is read
  // as an instant and rendered in, say, UTC. It must not.
  assert.equal(parseOfxDate('20250903000000[-6:MDT]'), '2025-09-03');
  assert.equal(parseOfxDate('20250101000000[-7:MST]'), '2025-01-01', 'year boundary holds');
  assert.equal(parseOfxDate('20250903'), '2025-09-03', 'date-only form');
  assert.equal(parseOfxDate('20250903120000.000[+13:NZDT]'), '2025-09-03');
  assert.equal(parseOfxDate('garbage'), undefined);
});

test('clean files produce no warnings', () => {
  assert.deepEqual(parseOfx(sample('bank-ofx1.ofx')).warnings, []);
  assert.deepEqual(parseOfx(sample('creditcard-ofx2.ofx')).warnings, []);
});

test('a bank error status is surfaced', () => {
  const doc = parseOfx(`
    <OFX><SIGNONMSGSRSV1><SONRS><STATUS>
      <CODE>2000<SEVERITY>ERROR<MESSAGE>General error
    </STATUS></SONRS></SIGNONMSGSRSV1></OFX>`);
  assert.match(doc.warnings.join(' '), /ERROR 2000/);
  assert.match(doc.warnings.join(' '), /No <STMTRS>/);
});

test('a missing FITID is flagged rather than dropped', () => {
  const doc = parseOfx(`
    <OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
      <BANKACCTFROM><ACCTID>1</ACCTID></BANKACCTFROM>
      <BANKTRANLIST>
        <STMTTRN><DTPOSTED>20250903<TRNAMT>-10.00<NAME>NO ID HERE</STMTTRN>
      </BANKTRANLIST>
    </STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
  const transaction = doc.statements[0]!.transactions[0]!;
  assert.equal(transaction.amountCents, -1000);
  assert.match(transaction.warnings.join(' '), /No FITID/);
});

test('rejects a file that is not OFX', () => {
  assert.throws(() => parseOfx('Date,Amount\n2025-09-03,-45.20'), /Is this an OFX/);
});
