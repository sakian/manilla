/**
 * OFX / QFX parser covering both dialects banks actually ship:
 *
 *   OFX 1.x  SGML-ish, key:value headers, leaf tags usually left unclosed
 *   OFX 2.x  real XML with an <?OFX?> processing instruction
 *   QFX      either of the above plus Intuit's <INTU.BID> field
 *
 * Dates are deliberately kept as plain `YYYY-MM-DD` strings rather than `Date`
 * objects. A bank posting date is a calendar date, not an instant; converting
 * "20250903120000[-6:MDT]" to a Date and reading it back in another timezone
 * can move a transaction into the previous day, and therefore into the wrong
 * budget month.
 */

import { parseAmount } from '../money.ts';

export type OfxNode = {
  tag: string;
  value?: string;
  children: OfxNode[];
};

export type OfxTransaction = {
  fitId: string;
  type: string;
  /** Calendar date, `YYYY-MM-DD`. */
  posted: string;
  amountCents: number;
  name: string;
  memo?: string;
  checkNumber?: string;
  /** Present when the bank sends a structured <PAYEE> aggregate. */
  payeeName?: string;
  warnings: string[];
};

export type OfxStatement = {
  kind: 'bank' | 'creditcard';
  accountId: string;
  bankId?: string;
  accountType?: string;
  currency?: string;
  start?: string;
  end?: string;
  ledgerBalanceCents?: number;
  ledgerBalanceAsOf?: string;
  availableBalanceCents?: number;
  transactions: OfxTransaction[];
};

export type OfxDocument = {
  version: '1.x' | '2.x';
  /** Raw pre-<OFX> headers, present on 1.x only. */
  headers: Record<string, string>;
  intuitBankId?: string;
  statements: OfxStatement[];
  /** Non-fatal problems worth showing the user rather than swallowing. */
  warnings: string[];
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Build a node tree from either dialect.
 *
 * A tag followed by text is a leaf; a tag followed by another tag is an
 * aggregate. Closing tags are honoured when the tag is actually open, and
 * ignored otherwise, which is what lets one pass handle both the banks that
 * close their leaf tags and the ones that do not.
 */
export function parseTree(body: string): OfxNode {
  const root: OfxNode = { tag: '#root', children: [] };
  const stack: OfxNode[] = [root];
  const token = /<(\/?)([A-Za-z0-9._:-]+)[^>]*>([^<]*)/g;

  let match: RegExpExecArray | null;
  while ((match = token.exec(body)) !== null) {
    const closing = match[1] === '/';
    const tag = match[2]!.toUpperCase();
    const text = decodeEntities(match[3]!).trim();

    if (closing) {
      const depth = stack.findLastIndex((node) => node.tag === tag);
      if (depth > 0) stack.length = depth;
      continue;
    }

    const node: OfxNode = { tag, children: [] };
    stack[stack.length - 1]!.children.push(node);

    if (text !== '') {
      node.value = text;
    } else {
      stack.push(node);
    }
  }

  return root;
}

function child(node: OfxNode, tag: string): OfxNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

function text(node: OfxNode | undefined, tag: string): string | undefined {
  if (!node) return undefined;
  const found = child(node, tag);
  return found?.value;
}

function findAll(node: OfxNode, tag: string, into: OfxNode[] = []): OfxNode[] {
  for (const c of node.children) {
    if (c.tag === tag) into.push(c);
    findAll(c, tag, into);
  }
  return into;
}

/**
 * OFX date -> `YYYY-MM-DD`. Accepts `YYYYMMDD`, `YYYYMMDDHHMMSS`, an optional
 * `.SSS` fraction and an optional `[-6:MDT]` timezone, which is intentionally
 * discarded (see the note at the top of this file).
 */
export function parseOfxDate(raw: string): string | undefined {
  const digits = /^\s*(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!digits) return undefined;
  return `${digits[1]}-${digits[2]}-${digits[3]}`;
}

function parseHeaders(source: string): { version: '1.x' | '2.x'; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const preamble = source.slice(0, source.search(/<OFX>/i));

  if (/<\?xml/i.test(preamble)) {
    const instruction = /<\?OFX([^?]*)\?>/i.exec(preamble);
    if (instruction) {
      for (const attr of instruction[1]!.matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)) {
        headers[attr[1]!.toUpperCase()] = attr[2]!;
      }
    }
    return { version: '2.x', headers };
  }

  for (const line of preamble.split(/\r?\n/)) {
    const pair = /^([A-Z0-9]+):(.*)$/.exec(line.trim());
    if (pair) headers[pair[1]!] = pair[2]!.trim();
  }
  return { version: '1.x', headers };
}

function readTransaction(node: OfxNode, warnings: string[]): OfxTransaction | undefined {
  const rawAmount = text(node, 'TRNAMT');
  const rawDate = text(node, 'DTPOSTED') ?? text(node, 'DTUSER');
  const fitId = text(node, 'FITID');

  if (rawAmount === undefined || rawDate === undefined) {
    warnings.push(`Skipped a <STMTTRN> missing ${rawAmount === undefined ? 'TRNAMT' : 'DTPOSTED'}`);
    return undefined;
  }

  const posted = parseOfxDate(rawDate);
  if (!posted) {
    warnings.push(`Skipped a <STMTTRN> with an unreadable date: ${rawDate}`);
    return undefined;
  }

  const local: string[] = [];
  const amount = parseAmount(rawAmount);
  if (amount.warning) local.push(amount.warning);
  if (!fitId) local.push('No FITID; deduplication must fall back to date + amount + description');

  const payee = child(node, 'PAYEE');

  return {
    fitId: fitId ?? '',
    type: text(node, 'TRNTYPE') ?? 'OTHER',
    posted,
    amountCents: amount.cents,
    name: text(node, 'NAME') ?? text(payee, 'NAME') ?? '',
    ...(text(node, 'MEMO') ? { memo: text(node, 'MEMO')! } : {}),
    ...(text(node, 'CHECKNUM') ? { checkNumber: text(node, 'CHECKNUM')! } : {}),
    ...(text(payee, 'NAME') ? { payeeName: text(payee, 'NAME')! } : {}),
    warnings: local,
  };
}

function readStatement(
  node: OfxNode,
  kind: 'bank' | 'creditcard',
  warnings: string[],
): OfxStatement | undefined {
  const account = child(node, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM');
  const accountId = text(account, 'ACCTID');
  if (!accountId) {
    warnings.push(`A ${kind} statement had no ACCTID and was skipped`);
    return undefined;
  }

  const list = child(node, 'BANKTRANLIST');
  const transactions: OfxTransaction[] = [];
  if (list) {
    for (const trn of findAll(list, 'STMTTRN')) {
      const parsed = readTransaction(trn, warnings);
      if (parsed) transactions.push(parsed);
    }
  }

  const ledger = child(node, 'LEDGERBAL');
  const available = child(node, 'AVAILBAL');
  const ledgerAmount = text(ledger, 'BALAMT');
  const availableAmount = text(available, 'BALAMT');

  return {
    kind,
    accountId,
    ...(text(account, 'BANKID') ? { bankId: text(account, 'BANKID')! } : {}),
    ...(text(account, 'ACCTTYPE') ? { accountType: text(account, 'ACCTTYPE')! } : {}),
    ...(text(node, 'CURDEF') ? { currency: text(node, 'CURDEF')! } : {}),
    ...(text(list, 'DTSTART') ? { start: parseOfxDate(text(list, 'DTSTART')!) } : {}),
    ...(text(list, 'DTEND') ? { end: parseOfxDate(text(list, 'DTEND')!) } : {}),
    ...(ledgerAmount ? { ledgerBalanceCents: parseAmount(ledgerAmount).cents } : {}),
    ...(text(ledger, 'DTASOF') ? { ledgerBalanceAsOf: parseOfxDate(text(ledger, 'DTASOF')!) } : {}),
    ...(availableAmount ? { availableBalanceCents: parseAmount(availableAmount).cents } : {}),
    transactions,
  };
}

export function parseOfx(source: string): OfxDocument {
  if (!/<OFX>/i.test(source)) {
    throw new Error('No <OFX> element found. Is this an OFX/QFX file?');
  }

  const warnings: string[] = [];
  const { version, headers } = parseHeaders(source);
  const tree = parseTree(source.slice(source.search(/<OFX>/i)));

  for (const status of findAll(tree, 'STATUS')) {
    const severity = text(status, 'SEVERITY');
    if (severity && severity.toUpperCase() !== 'INFO') {
      warnings.push(`Bank reported ${severity} ${text(status, 'CODE') ?? ''}: ${text(status, 'MESSAGE') ?? 'no message'}`.trim());
    }
  }

  const statements: OfxStatement[] = [];
  for (const node of findAll(tree, 'STMTRS')) {
    const statement = readStatement(node, 'bank', warnings);
    if (statement) statements.push(statement);
  }
  for (const node of findAll(tree, 'CCSTMTRS')) {
    const statement = readStatement(node, 'creditcard', warnings);
    if (statement) statements.push(statement);
  }

  if (statements.length === 0) warnings.push('No <STMTRS> or <CCSTMTRS> statement found');

  const intuit = findAll(tree, 'INTU.BID')[0]?.value;

  return {
    version,
    headers,
    ...(intuit ? { intuitBankId: intuit } : {}),
    statements,
    warnings,
  };
}
