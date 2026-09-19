import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, detectDelimiter, toRecords } from './csv.ts';

test('basic rows', () => {
  const table = parseCsv('Date,Amount\n2025-09-03,-45.20\n2025-09-02,-12.00\n');
  assert.deepEqual(table.headers, ['Date', 'Amount']);
  assert.deepEqual(table.rows, [
    ['2025-09-03', '-45.20'],
    ['2025-09-02', '-12.00'],
  ]);
});

test('quoted commas do not split a field', () => {
  const table = parseCsv('Name,Envelope\n"SAFEWAY, CALGARY",Groceries\n');
  assert.deepEqual(table.rows[0], ['SAFEWAY, CALGARY', 'Groceries']);
});

test('escaped quotes and embedded newlines survive', () => {
  const table = parseCsv('Note\n"She said ""hi"""\n"line one\nline two"\n');
  assert.deepEqual(table.rows[0], ['She said "hi"']);
  assert.deepEqual(table.rows[1], ['line one\nline two']);
});

test('a BOM and CRLF line endings are handled', () => {
  const table = parseCsv('﻿Date,Amount\r\n2025-09-03,-45.20\r\n');
  assert.deepEqual(table.headers, ['Date', 'Amount']);
  assert.deepEqual(table.rows[0], ['2025-09-03', '-45.20']);
});

test('trailing blank lines are ignored', () => {
  const table = parseCsv('A,B\n1,2\n\n\n');
  assert.equal(table.rows.length, 1);
});

test('empty fields are preserved, not collapsed', () => {
  const table = parseCsv('A,B,C\n1,,3\n');
  assert.deepEqual(table.rows[0], ['1', '', '3']);
});

test('delimiter detection', () => {
  assert.equal(detectDelimiter('Date,Amount,Envelope\n'), ',');
  assert.equal(detectDelimiter('Date;Amount;Envelope\n'), ';');
  assert.equal(detectDelimiter('Date\tAmount\tEnvelope\n'), '\t');
  assert.equal(detectDelimiter('SingleColumn\n'), ',', 'falls back to comma');
});

test('records are keyed by header', () => {
  const records = toRecords(parseCsv('Date,Amount\n2025-09-03,-45.20\n'));
  assert.deepEqual(records[0], { Date: '2025-09-03', Amount: '-45.20' });
});

test('a short row is padded rather than dropped', () => {
  const records = toRecords(parseCsv('A,B,C\n1,2\n'));
  assert.deepEqual(records[0], { A: '1', B: '2', C: '' });
});
