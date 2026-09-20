/**
 * RFC 4180 CSV reader.
 *
 * Bank and GoodBudget exports routinely contain quoted commas ("SAFEWAY, CALGARY"),
 * embedded newlines in memo fields, and a UTF-8 BOM from Excel. Splitting on
 * commas loses rows silently, which in a ledger means losing money, so this
 * parses properly rather than approximately.
 */

export type CsvTable = {
  headers: string[];
  rows: string[][];
};

export function parseCsv(input: string, delimiter = ','): CsvTable {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // Skip blank lines, which trail most exports.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r') {
      // Handled by the \n branch; a lone \r also ends a row.
      if (text[i + 1] !== '\n') endRow();
    } else if (char === '\n') {
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (field !== '' || row.length > 0) endRow();

  const headers = (rows.shift() ?? []).map((header) => header.trim());
  return { headers, rows };
}

/** Guess the delimiter from the header line: exports vary between comma, semicolon and tab. */
export function detectDelimiter(input: string): string {
  const firstLine = input.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => ({
    delimiter: d,
    // Count only outside quotes, cheaply: strip quoted spans first.
    count: (firstLine.replace(/"[^"]*"/g, '').match(new RegExp(`\\${d}`, 'g')) ?? []).length,
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0]!.count > 0 ? counts[0]!.delimiter : ',';
}

/** Row as an object keyed by header, for readable column access. */
export function toRecords(table: CsvTable): Record<string, string>[] {
  return table.rows.map((row) => {
    const record: Record<string, string> = {};
    table.headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
}

/**
 * Write RFC 4180 CSV.
 *
 * Quoting is not optional guesswork: a field is quoted whenever it contains the
 * delimiter, a quote, or a line break, and quotes inside are doubled. A payee
 * like `SOBEYS #123, CALGARY` or a note with a newline in it is ordinary data,
 * and an export that mangles it is an export nobody can import anywhere else
 * (NF-6).
 */
export function toCsv(
  rows: Record<string, unknown>[],
  columns?: string[],
  delimiter = ',',
): string {
  const headers = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];

  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /["\r\n]|^\s|\s$/.test(text) || text.includes(delimiter)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  };

  const lines = [headers.map(cell).join(delimiter)];
  for (const row of rows) {
    lines.push(headers.map((header) => cell(row[header])).join(delimiter));
  }

  // A trailing newline, so appending or concatenating files does not glue two
  // rows together.
  return `${lines.join('\r\n')}\r\n`;
}
