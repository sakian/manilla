# Manilla

Envelope budgeting, built to fix the two things that make GoodBudget tedious:
getting transactions in often enough to be useful mid-month, and categorizing
them without doing it all by hand.

Requirements live in the [requirements doc](https://claude.ai/code/artifact/5da0430a-8b8f-44cd-af2b-277fb6345fb5).

## Status: Phase 0 (de-risking)

Phase 0 exists to answer questions that would be expensive to get wrong later,
using real files rather than assumptions. No app yet - just the parsers and the
measurement harness.

| Decision | Answer |
| --- | --- |
| Stack | TypeScript, Next.js + Postgres, self-hosted in Docker |
| Banking | Canada (OFX/QFX import; aggregator choice deferred to Phase 5) |
| AI | Hosted Claude API (`claude-opus-5`), minimal payload, off switch |

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
npm test                 # 54 tests, no network, no spend
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

**Automation proposes, you confirm.** Imported transactions arrive as
*pending review* with a suggested envelope and a confidence score. High
confidence is bulk-confirmable; low confidence is left uncategorized with
candidates rather than guessed at.

**The AI layer is last and optional.** Rules and history handle repeat
merchants for free, so the model is only consulted for genuinely unknown ones,
and results are cached per merchant. Everything works with AI switched off.
