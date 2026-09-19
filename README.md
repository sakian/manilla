# Manilla

Envelope budgeting, built to fix the two things that make GoodBudget tedious:
getting transactions in often enough to be useful mid-month, and categorizing
them without doing it all by hand.

Requirements live in the [requirements doc](https://claude.ai/code/artifact/5da0430a-8b8f-44cd-af2b-277fb6345fb5).

## Status: Phase 0 (de-risking) - complete except the AI layer

Phase 0 exists to answer questions that would be expensive to get wrong later,
using real files rather than assumptions. No app yet - just the parsers and the
measurement harness.

| Decision | Answer |
| --- | --- |
| Stack | TypeScript, Next.js + Postgres, self-hosted in Docker |
| Banking | Canada (OFX/QFX import; aggregator choice deferred to Phase 5) |
| AI | Hosted Claude API (`claude-opus-5`), minimal payload, off switch |
| Users | Single user for now; multi-user deferred |

Measured against a real 7,957-row GoodBudget export (2021-2026) and a real TD
OFX file, holding out the most recent three months (435 transactions):

| | History only | History + AI |
| --- | --- | --- |
| Accepted unchanged | 62.8% | **72.4%** |
| Got any suggestion | 90.6% | 99.5% |
| Auto-confirm precision at 0.95 | - | 98.6% (covering 15.9%) |
| Cost per 1,000 transactions | $0 | ~$2 |

Recorded in section 12 of the requirements doc:

- **90% was never reachable from bank data.** 68% of transactions happen at
  merchants used for more than one envelope - Amazon Marketplace alone spans 21
  envelopes across 712 transactions. Whether an order was Clothing or Groceries
  is not in the bank feed, so no model can read it. 72% is the realistic target.
- The auto-confirm threshold is **0.95**, not the 0.85 first proposed. At 0.95
  it confirms 16% of transactions at 98.6% precision; at 0.85 it confirms 30%
  at 91.7%, which is roughly one wrong entry in twelve.
- The AI layer earns its place: +9.6 points and near-total coverage for about
  $1.50 a year at this volume. Its real job is the ~9% of transactions at
  merchants never seen before, not breaking the ambiguity ceiling.
- The fast review queue still matters most. Only 16% can be auto-confirmed, so
  almost everything passes under a human eye either way.

## Requirements

Node 24 or newer. It runs TypeScript directly, so there is no build step.

```bash
npm install
```

## What's here

```
src/
  money.ts              integer-cents parsing; never floats (NF-1)
  csv.ts                RFC 4180 reader (quoted commas, embedded newlines, BOM)
  ofx/parse.ts          OFX 1.x (SGML) and 2.x (XML), plus QFX
  goodbudget/load.ts    GoodBudget export loader with column auto-detection
  categorize/
    normalize.ts        payee normalization (CA-1)
    history.ts          recency-weighted history matching (CA-3, CA-4)
    ai.ts               Claude layer for unknown merchants (CA-5, CA-8)
    pipeline.ts         rules -> history -> AI, with confidence bands (CA-7)
spikes/                 runnable Phase 0 investigations
data/samples/           synthetic fixtures, safe to commit
data/private/           your real exports - gitignored
```

## Running the spikes

Put real exports in `data/private/` first. That folder is gitignored, so
financial data never reaches version control.

```bash
npm test                 # 66 tests, no network, no spend
npm run typecheck

npm run ofx              # profile bank OFX/QFX files
npm run goodbudget       # profile a GoodBudget export, cache parsed history
npm run categorize       # accuracy of rules + history layers (free)
```

The categorizer eval holds out recent transactions, categorizes them against
the history that preceded them, and compares the result to what you actually
chose. The AI layer is opt-in because it spends money:

```bash
npm run categorize -- --ai --limit 100   # cap the spend while trying it
npm run categorize -- --months 3         # widen the held-out window
```

Credentials come from `ant auth login` or `ANTHROPIC_API_KEY`.

## Design decisions worth knowing

**Money is integer cents everywhere.** `parseAmount` works on the digit string
rather than `parseFloat`, because `1234.56 * 100` is `123455.99999999999` in
floating point. Ambiguous input (`"1.234"`) is parsed and flagged, never
silently guessed.

**Dates are plain `YYYY-MM-DD` strings, not `Date` objects.** A bank posting
date is a calendar date, not an instant. Parsing `20250903000000[-6:MDT]` into a
`Date` and reading it elsewhere can shift a transaction into the previous day,
and therefore into the wrong budget month.

**Date *format* is decided per file, never per row.** The real GoodBudget export
is D/M/Y despite being a North American file. The format is inferred from rows
that can only be read one way - a first component above 12 - and 4,450 such rows
settle it. Guessing per row would have silently misdated thousands of
transactions.

**Automation proposes, you confirm.** Imported transactions arrive as
*pending review* with a suggested envelope and a confidence score. High
confidence is bulk-confirmable; low confidence is left uncategorized with
candidates rather than guessed at.

**The AI layer is last and optional.** Rules and history handle repeat
merchants for free, so the model is only consulted for genuinely unknown ones,
and results are cached per merchant. Everything works with AI switched off.
