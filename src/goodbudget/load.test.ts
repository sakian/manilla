import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectColumns,
  detectDateFormat,
  parseExportDate,
  parseDetails,
  loadGoodBudgetExport,
  AVAILABLE,
} from './load.ts';

const HEADERS = 'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details';

test('columns are detected from the real export header', () => {
  const mapping = detectColumns(HEADERS.split(','));
  assert.equal(mapping.date, 'Date');
  assert.equal(mapping.envelope, 'Envelope');
  assert.equal(mapping.payee, 'Name');
  assert.equal(mapping.amount, 'Amount');
  assert.equal(mapping.account, 'Account');
  assert.equal(mapping.details, 'Details');
  assert.equal(mapping.notes, 'Notes');
});

test('the date format is decided for the whole file, not per row', () => {
  // A first component above 12 can only be a day.
  assert.deepEqual(detectDateFormat(['04/09/2026', '31/08/2026']).format, 'dmy');
  assert.deepEqual(detectDateFormat(['04/09/2026', '08/31/2026']).format, 'mdy');
  assert.equal(detectDateFormat(['2026-09-04']).format, 'iso');
  assert.equal(detectDateFormat(['04/09/2026', '05/10/2026']).format, 'ambiguous');
  assert.equal(detectDateFormat(['31/08/2026', '08/31/2026']).format, 'ambiguous', 'inconsistent file');
});

test('D/M/Y is read as day first', () => {
  // The bug this pins: read as M/D/Y, 04/09 becomes 9 April and lands in the
  // wrong budget month.
  assert.equal(parseExportDate('04/09/2026', 'dmy'), '2026-09-04');
  assert.equal(parseExportDate('04/09/2026', 'mdy'), '2026-04-09');
  assert.equal(parseExportDate('31/08/2026', 'dmy'), '2026-08-31');
  assert.equal(parseExportDate('31/08/2026', 'mdy'), '2026-08-31', 'an unambiguous row overrides the file format');
  assert.equal(parseExportDate('2026-09-04', 'dmy'), '2026-09-04');
  assert.equal(parseExportDate('04/09/26', 'dmy'), '2026-09-04', 'two-digit year');
  assert.equal(parseExportDate('not a date', 'dmy'), undefined);
  assert.equal(parseExportDate('45/09/2026', 'dmy'), undefined, 'impossible day');
});

test('splits are parsed from the Details column', () => {
  const parts = parseDetails('Living:Groceries and Supplies|-12.00||Health:Equipment|-24.40');
  assert.deepEqual(parts, [
    { envelope: 'Living:Groceries and Supplies', amountCents: -1200 },
    { envelope: 'Health:Equipment', amountCents: -2440 },
  ]);
});

test('income is a split into the unallocated pool', () => {
  assert.deepEqual(parseDetails('[Available]|836.96'), [{ envelope: AVAILABLE, amountCents: 83696 }]);
  assert.deepEqual(parseDetails('[Available]|20,000.00'), [{ envelope: AVAILABLE, amountCents: 2000000 }]);
  assert.deepEqual(parseDetails(''), []);
});

test('an envelope name containing a colon survives the pipe split', () => {
  // Envelope names are "Group:Name", so the amount separator must be the LAST pipe.
  const [part] = parseDetails('Vehicle:Gas|-45.20');
  assert.equal(part!.envelope, 'Vehicle:Gas');
  assert.equal(part!.amountCents, -4520);
});

test('rows are classified by kind', () => {
  const csv = [
    HEADERS,
    '04/09/2026,Vehicle:Gas,Visa,PETRO-CANADA,,,-45.20,CLR,',
    '31/08/2026,,Chequing,CHILD TAX BEN    CCB,,,836.96,CLR,[Available]|836.96',
    '18/07/2026,,Visa,AMZN Mktp CA,,,-36.40,CLR,Living:Groceries|-12.00||Health:Equipment|-24.40',
    '04/08/2026,,Chequing,UR125 TFR-TO C/C,,,-6889.31,CLR,',
    '01/08/2026,,[none],Fill Envelopes,,,0.00,,',
    '04/09/2026,Home:Purchase,,Envelope Transfer,,,"16,732.19",,',
    '04/09/2026,Saving:Emergency Fund,,Envelope Transfer,,,"-16,732.19",,',
  ].join('\n');

  const result = loadGoodBudgetExport(csv);
  assert.equal(result.dateFormat, 'dmy');
  assert.deepEqual(result.counts, {
    spending: 1, split: 1, income: 1, transfer: 1, envelopeTransfer: 2, fill: 1,
  });
  assert.equal(result.splitLines, 3, 'one income line plus two split lines');

  // Four envelope-bearing lines: the spend, the income, and both split parts.
  assert.equal(result.transactions.length, 4);
  const gas = result.transactions.find((t) => t.envelope === 'Vehicle:Gas')!;
  assert.equal(gas.date, '2026-09-04', 'D/M/Y');
  assert.equal(gas.amountCents, -4520);

  // The transfer contributes no envelope line: transfers are not spending (FR-5).
  assert.ok(!result.transactions.some((t) => t.payeeRaw.includes('TFR-TO')));

  // Envelope moves carry an envelope but are not spending either (FR-34).
  assert.ok(!result.transactions.some((t) => t.payeeRaw === 'Envelope Transfer'));
});

test('a split whose parts do not sum to the total is reported', () => {
  const csv = [
    HEADERS,
    '18/07/2026,,Visa,AMZN,,,-40.00,CLR,Living:Groceries|-12.00||Health:Equipment|-24.40',
  ].join('\n');
  assert.match(loadGoodBudgetExport(csv).warnings.join(' '), /sum to -3640 but the row total is -4000/);
});

test('thousands separators in amounts are read correctly', () => {
  const csv = [HEADERS, '19/08/2026,Saving:Vacation,Chequing,DEPOSIT,,,"16,732.19",CLR,'].join('\n');
  assert.equal(loadGoodBudgetExport(csv).transactions[0]!.amountCents, 1673219);
});
