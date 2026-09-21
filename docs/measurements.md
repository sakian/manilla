# What was measured

Manilla's two most consequential design decisions came out of measurement rather
than judgement: how accurate automatic categorization can be, and whether to
integrate a bank-data aggregator. Both answers were surprising enough to change
the plan.

Measured against a real multi-year export from another envelope budgeting app —
about 8,000 transactions across six years — and real OFX files from a Canadian
bank. The figures below are from that one household's data. Yours will differ; the
*shape* of the result probably will not, because the cause is structural.

## Automatic categorization has a ceiling, and it is about 72%

The original target was 90% of transactions categorized correctly without help.
That is not reachable from bank data alone.

Holding out the most recent three months (435 transactions) and categorizing them
against only the history that preceded them:

| Measure | History only | History + AI |
| --- | --- | --- |
| Accepted unchanged | 62.8% | **72.4%** |
| Got any suggestion at all | 90.6% | 99.5% |
| Auto-confirm precision at the 0.95 cutoff | – | 98.6%, covering 15.9% |
| Auto-confirm precision at the 0.85 cutoff first proposed | – | 91.7% |
| Cost per 1,000 transactions | $0 | about $2 |

Re-measured against the same three months once the layer was wired into the app
rather than a spike: 62.8% and 71.7%, with the same 98.6% precision. The model is
not deterministic, so the AI figure moves by a few tenths of a point between runs.

### Why the ceiling exists

**68% of transactions happen at merchants used for more than one envelope.**

| Merchant | Transactions | Envelopes used | Best possible guess |
| --- | --- | --- | --- |
| Amazon Marketplace | 712 | 21 | 25% |
| Interac e-transfer | 482 | 24 | 14% |
| A grocery chain | 428 | 7 | 79% |
| Amazon.ca | 352 | 15 | 21% |
| A coffee chain | 303 | 8 | 32% |

Whether a given Amazon order was Clothing, Groceries or Home Upkeep is genuinely
not present in the bank feed. No model can read it from `AMZN Mktp CA` and $31.46.
This is a missing-information problem, not a modelling problem.

An earlier version of this analysis claimed 64.6% was the ceiling for any method
given payee and amount. That was wrong, and the correction matters: 64.6% is the
ceiling for a *payee-name-only* strategy — always guessing each merchant's single
most-used envelope. It ignores the amount, and the amount carries real signal. A
round-numbered e-transfer and a four-figure one are different things; two insurance
policies with the same insurer are told apart by their premiums alone. Using payee,
amount and recency together, and adding the model, measures 72.4%.

### What that changed

1. **The target became 72% accepted unchanged**, with at least 95% precision on
   whatever is auto-confirmed. Keeping 90% would have made every later phase look
   like a failure against a number that was never achievable.
2. **The auto-confirm threshold went from 0.85 to 0.95** (CA-7). At 0.85 roughly
   one in five bulk-confirmed transactions would be wrong, which is worse than not
   automating.
3. **The review queue became the most important feature in the app, ahead of the
   AI layer** (RQ-3). Only 16% can be auto-confirmed safely and 28% of suggestions
   still need correcting, so the great majority pass under a human eye either way.
   The product wins by making each of those a single keystroke, not by trying to
   eliminate them.
4. **The AI layer earns its place, for a narrower job than assumed.** It is worth
   about 9.6 points and takes coverage from 90.6% to 99.5%, so almost nothing
   reaches the queue with no suggestion at all. Its real job is the ~9% of
   transactions at merchants never seen before — not breaking the ambiguity ceiling.
5. **Raising the ceiling needs new information, not better models.** The single
   highest-value addition would be importing Amazon order history, which alone
   would address 1,064 transactions — 14% of all spending. That is what the
   planned supplementary imports are for.

### One measurement that went the other way

Caching one model answer per merchant looks like the obvious saving and measured
**ten points worse**. Since 68% of transactions happen at multi-envelope merchants
and the amount is what separates them, one answer for "AMAZON" applied to every
Amazon charge throws that signal away. So the model is asked per transaction, and
only a *confident* answer is cached for the merchant — a fuel station is a fuel
station. An unsure one is asked again with its own amount.

## Four silent-corruption defects found by reading real files

Each of these would have produced plausible wrong numbers rather than an error.

**Dates in the export are D/M/Y, not M/D/Y**, despite being a North American file;
4,450 rows prove it, being rows whose first component is above 12. Reading them
the North American way would have moved thousands of transactions into the wrong
budget month and corrupted every report. The format is now decided once per file
from the unambiguous rows, never per row.

**`1234.56 * 100` is `123455.99999999999`** in floating point. Amounts are parsed
off the digit string into integer cents and never touch a float. Ambiguous input
like `"1.234"` is parsed and flagged, never silently guessed.

**Parsing `20250903000000[-6:MDT]` into a `Date`** and reading it back elsewhere
can shift a transaction into the previous day, and therefore into the wrong budget
month. Dates are plain `YYYY-MM-DD` strings throughout: a bank posting date is a
calendar date, not an instant.

**"Envelope Transfer" rows carry an envelope but are envelope-to-envelope moves.**
All 284 of them net to exactly zero. As training data they were pure noise across
42 envelopes; as spending they would have been double-counted.

Also confirmed from the files: envelope names already arrive as `Group:Name`, so
groups import directly. Income is a split into a pseudo-envelope that maps onto the
income pool. "Fill Envelopes" rows exist but carry no amount and no per-envelope
breakdown, which is why past envelope balances cannot be rebuilt from a transaction
export — only past spending. Every transaction in the OFX file had a unique FITID
and the file carried a ledger balance, so FR-10 deduplication and the FR-14 balance
check both work for this bank.

Normalization was measured too: distinct merchants fell from 1,599 to 827, and
repeat-merchant coverage rose from 80.6% to 90.7%. Bank descriptors turned out to
carry postal codes, masked e-transfer recipients, rotating transfer prefixes and
mixed letter-digit reference codes; all are handled.

## Automatic bank feeds: deliberately not built

Direct OFX is a dead end in Canada. There is no Direct Connect with Canadian
institutions, and Quicken Canada's "Express Web Connect" is aggregator-backed
scraping in an OFX costume.

That leaves the aggregators — Plaid, Flinks, Mastercard Open Banking — which mostly
work by holding your online banking credentials and signing in as you where no real
API exists. That breaches the banks' own agreements and moves liability for fraud
onto the customer, which is a poor trade for saving a monthly download.

The alternative has a date. The Consumer-Driven Banking Act passed in June 2024;
the Bank of Canada is lead regulator; draft regulations were published on 27 June
2026 with comments closing 26 August 2026, and the framework comes into force
within a year of final publication. The large banks must participate from the
outset, and phase one is read access.

One wrinkle worth remembering: phase one phases data in *by account type* — deposit
and payment accounts first, then lending, and registered and non-registered
investment accounts last. Chequing and credit cards will arrive well before a
retirement account does, and those may stay a manual download for a while after the
rest is automatic.

So the decision is to wait, rather than integrate an aggregator in the meantime.
This reasoning is specific to Canada; elsewhere the trade-off may be different.

## Reproducing any of this

The spikes are runnable. Put your own exports in `data/private/`, which is
gitignored:

```bash
npm run ofx              # profile bank OFX/QFX files
npm run goodbudget       # profile an export, cache parsed history
npm run categorize       # accuracy of rules + history layers (free)
npm run categorize -- --ai --limit 100   # add the model, capped
```

The categorizer eval holds out recent transactions, categorizes them against only
the history that preceded them, and compares the result to what you actually chose.
The AI layer is opt-in because it spends money.
