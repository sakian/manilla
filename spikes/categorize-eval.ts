/**
 * Phase 0 spike: measure categorization accuracy against real history.
 *
 *   npm run categorize                      rules + history only, free
 *   npm run categorize -- --ai              adds the model layer (spends money)
 *   npm run categorize -- --ai --limit 100  cap the spend while trying it out
 *   npm run categorize -- --months 3        widen the test window
 *
 * Method: everything before the cutoff date is treated as known history; the
 * transactions after it are hidden, categorized, and compared against what you
 * actually chose in GoodBudget. This is the number that decides whether the
 * 90%-accepted-unchanged target in the requirements is reachable.
 *
 * The AI layer is opt-in because it costs real money.
 */

import { readFileSync, existsSync } from 'node:fs';
import { HistoryIndex } from '../src/categorize/history.ts';
import { AiCategorizer } from '../src/categorize/ai.ts';
import { Categorizer, bandOf, type Band, type Rule } from '../src/categorize/pipeline.ts';
import { normalizePayee } from '../src/categorize/normalize.ts';
import type { LabeledTransaction, Layer, Suggestion } from '../src/categorize/types.ts';
import { formatCents } from '../src/money.ts';

const HISTORY_CACHE = 'out/history.json';

// Claude Opus 5, USD per million tokens.
const PRICE = { input: 5, cachedInput: 0.5, output: 25 };

type Args = { ai: boolean; months: number; limit: number | undefined };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    ai: argv.includes('--ai'),
    months: Number(value('--months') ?? 1),
    limit: value('--limit') ? Number(value('--limit')) : undefined,
  };
}

function loadHistory(): LabeledTransaction[] {
  if (!existsSync(HISTORY_CACHE)) {
    console.log(`No parsed history at ${HISTORY_CACHE}.

Run the GoodBudget inspector first - it writes the cache:

    npm run goodbudget -- data/private/<your-export>.csv
`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(HISTORY_CACHE, 'utf8')) as LabeledTransaction[];
}

/** Cutoff = `months` before the newest transaction in the file. */
function splitByDate(transactions: LabeledTransaction[], months: number) {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const newest = sorted[sorted.length - 1]!.date;
  const cutoffDate = new Date(newest + 'T00:00:00Z');
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - months);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  return {
    cutoff,
    train: sorted.filter((t) => t.date < cutoff),
    test: sorted.filter((t) => t.date >= cutoff),
  };
}

/** Representative merchants per envelope, to ground the model's choices. */
function examplesByEnvelope(transactions: LabeledTransaction[]): Record<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const transaction of transactions) {
    const { display } = normalizePayee(transaction.payeeRaw);
    const perEnvelope = counts.get(transaction.envelope) ?? new Map<string, number>();
    perEnvelope.set(display, (perEnvelope.get(display) ?? 0) + 1);
    counts.set(transaction.envelope, perEnvelope);
  }

  const out: Record<string, string[]> = {};
  for (const [envelope, merchants] of counts) {
    out[envelope] = [...merchants.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name);
  }
  return out;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '  n/a' : `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

const args = parseArgs();
const all = loadHistory();
const { cutoff, train, test: fullTest } = splitByDate(all, args.months);
const test = args.limit ? fullTest.slice(0, args.limit) : fullTest;

if (train.length === 0 || test.length === 0) {
  console.log(`Not enough data to split: ${train.length} training rows, ${fullTest.length} test rows.`);
  process.exit(1);
}

const history = new HistoryIndex(train);
const envelopes = history.envelopes();

console.log('Categorization accuracy eval');
console.log('============================');
console.log(`  History (train): ${train.length} transactions up to ${cutoff}`);
console.log(`  Held out (test): ${test.length} transactions from ${cutoff} onward`);
console.log(`  Envelopes:       ${envelopes.length}`);
console.log(`  AI layer:        ${args.ai ? 'ON (claude-opus-5)' : 'off (pass --ai to enable)'}`);

const rules: Rule[] = []; // Phase 0 measures the layers you get for free, before any hand-tuning.
let ai: AiCategorizer | undefined;

if (args.ai) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log(`
  No API credentials found. Either run:
      ant auth login
  or set ANTHROPIC_API_KEY, then re-run.`);
  }
  // In the eval the label *is* the envelope name, so id and name are the same
  // thing; in the app they differ and fromDb.ts maps between them.
  ai = new AiCategorizer(
    envelopes.map((name) => ({ id: name, name })),
    examplesByEnvelope(train),
  );
}

const categorizer = new Categorizer(rules, history, ai);
const started = Date.now();
const suggestions = await categorizer.suggestAll(
  test.map(({ envelope: _ignored, ...rest }) => rest),
);
const elapsed = (Date.now() - started) / 1000;

type Bucket = { total: number; correct: number };
const byLayer = new Map<Layer, Bucket>();
const byBand = new Map<Band, Bucket>();
const misses: { transaction: LabeledTransaction; suggestion: Suggestion }[] = [];

let correct = 0;
let suggested = 0;

test.forEach((transaction, index) => {
  const suggestion = suggestions[index]!;
  const hit = suggestion.envelope === transaction.envelope;
  if (suggestion.envelope !== null) suggested += 1;
  if (hit) correct += 1;

  const layerBucket = byLayer.get(suggestion.layer) ?? { total: 0, correct: 0 };
  layerBucket.total += 1;
  if (hit) layerBucket.correct += 1;
  byLayer.set(suggestion.layer, layerBucket);

  if (suggestion.envelope !== null) {
    const band = bandOf(suggestion.confidence);
    const bandBucket = byBand.get(band) ?? { total: 0, correct: 0 };
    bandBucket.total += 1;
    if (hit) bandBucket.correct += 1;
    byBand.set(band, bandBucket);
  }

  if (!hit) misses.push({ transaction, suggestion });
});

console.log(`\nResults  (${elapsed.toFixed(1)}s)`);
console.log('-------');
console.log(`  Accepted unchanged: ${pct(correct, test.length)}  (${correct}/${test.length})   <- the 90% target`);
console.log(`  Got a suggestion:   ${pct(suggested, test.length)}  (${suggested}/${test.length})`);

console.log('\n  By layer:');
for (const layer of ['rule', 'history', 'ai', 'none'] as Layer[]) {
  const bucket = byLayer.get(layer);
  if (!bucket) continue;
  console.log(
    `    ${layer.padEnd(8)} handled ${String(bucket.total).padStart(5)}  correct ${pct(bucket.correct, bucket.total)}`,
  );
}

console.log('\n  By confidence band (of transactions that got a suggestion):');
for (const band of ['high', 'medium', 'low'] as Band[]) {
  const bucket = byBand.get(band);
  if (!bucket) continue;
  const note = band === 'high' ? '   <- auto-confirmed, errors here are the costly ones' : '';
  console.log(
    `    ${band.padEnd(8)} ${String(bucket.total).padStart(5)}  correct ${pct(bucket.correct, bucket.total)}${note}`,
  );
}

if (ai) {
  const { requests, inputTokens, cachedInputTokens, outputTokens } = ai.usage;
  const cost =
    (inputTokens / 1e6) * PRICE.input +
    (cachedInputTokens / 1e6) * PRICE.cachedInput +
    (outputTokens / 1e6) * PRICE.output;
  const handled = byLayer.get('ai')?.total ?? 0;
  console.log('\n  AI cost:');
  console.log(`    ${requests} request(s), ${inputTokens} input (${cachedInputTokens} cached), ${outputTokens} output`);
  console.log(`    ~$${cost.toFixed(4)} for ${handled} transactions` +
    (handled > 0 ? ` (~$${((cost / handled) * 1000).toFixed(2)} per 1,000)` : ''));
}

// How safe is the auto-confirm band? A wrong high-confidence suggestion is
// worse than an honest low-confidence one, so the threshold should be chosen
// from measured precision, not picked in advance (CA-7).
console.log('\n  Auto-confirm threshold sweep:');
console.log('    cutoff   confirmed   of all   correct');
for (const cutoff of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97]) {
  let confirmed = 0;
  let right = 0;
  test.forEach((transaction, index) => {
    const suggestion = suggestions[index]!;
    if (suggestion.envelope === null || suggestion.confidence < cutoff) return;
    confirmed += 1;
    if (suggestion.envelope === transaction.envelope) right += 1;
  });
  console.log(
    `    ${cutoff.toFixed(2)}     ${String(confirmed).padStart(6)}   ${pct(confirmed, test.length)}   ${pct(right, confirmed)}`,
  );
}

// What is actually reachable? Splits the test set by whether the answer was
// even present in history, which separates "needs a better model" from
// "no amount of cleverness would have known".
const trainEnvelopesByPayee = new Map<string, Set<string>>();
for (const transaction of train) {
  const key = normalizePayee(transaction.payeeRaw).key;
  const set = trainEnvelopesByPayee.get(key) ?? new Set<string>();
  set.add(transaction.envelope);
  trainEnvelopesByPayee.set(key, set);
}

let unseenMerchant = 0;
let reachableSingle = 0;
let reachableAmbiguous = 0;
let unreachable = 0;
for (const transaction of test) {
  const seen = trainEnvelopesByPayee.get(normalizePayee(transaction.payeeRaw).key);
  if (!seen) unseenMerchant += 1;
  else if (!seen.has(transaction.envelope)) unreachable += 1;
  else if (seen.size === 1) reachableSingle += 1;
  else reachableAmbiguous += 1;
}

console.log('\n  What history could possibly get right:');
console.log(`    merchant never seen before      ${String(unseenMerchant).padStart(5)}  ${pct(unseenMerchant, test.length)}  -> only the AI layer can help`);
console.log(`    seen, always one envelope       ${String(reachableSingle).padStart(5)}  ${pct(reachableSingle, test.length)}  -> history should get these`);
console.log(`    seen, but several envelopes     ${String(reachableAmbiguous).padStart(5)}  ${pct(reachableAmbiguous, test.length)}  -> needs the amount or a rule to disambiguate`);
console.log(`    seen, never this envelope       ${String(unreachable).padStart(5)}  ${pct(unreachable, test.length)}  -> history cannot reach these`);

console.log(`\n  Misses (first 20 of ${misses.length}):`);
for (const { transaction, suggestion } of misses.slice(0, 20)) {
  const guess = suggestion.envelope ?? '(none)';
  console.log(
    `    ${transaction.date}  ${formatCents(transaction.amountCents).padStart(11)}  ${normalizePayee(transaction.payeeRaw).display.slice(0, 28).padEnd(28)}` +
      `  want ${transaction.envelope.slice(0, 18).padEnd(18)} got ${guess.slice(0, 18).padEnd(18)} [${suggestion.layer} ${suggestion.confidence.toFixed(2)}]`,
  );
}
console.log('');
