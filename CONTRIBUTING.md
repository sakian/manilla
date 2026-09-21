# Contributing

Manilla is one person's household budgeting app, published because the problems it
solves are not unique and the measurements in
[docs/measurements.md](docs/measurements.md) were expensive to get. It is not a
product and there is no roadmap commitment.

That said: issues are genuinely welcome, and pull requests are read.

## Issues

Useful things to open one about:

- **A bug.** Especially anything where a balance came out wrong — that is the one
  class of defect this app cannot tolerate. Say what you did and what the two
  ledgers said afterwards.
- **A file it could not read.** OFX in the wild is inconsistent. A failing file is
  the most useful bug report there is, but **do not attach your real statement** —
  reduce it to a couple of synthetic transactions that still reproduce the problem,
  or just paste the structure with the numbers changed.
- **Something the docs got wrong**, including anything in
  [docs/requirements.md](docs/requirements.md) whose Status column no longer matches
  the code.

## Pull requests

- `npm test` and `npm run typecheck` both pass. The ledger, budget, import and auth
  tests need Postgres (`docker compose up -d db`) and skip cleanly without it, so
  check that they actually ran rather than skipped.
- New behaviour comes with a test. Money code especially: every silent-corruption
  defect listed in docs/measurements.md produced a plausible wrong number rather
  than an error, and a test is the only thing that catches that class.
- Match the surrounding style. Comments here explain *why*, not what — if a line
  needs a comment saying what it does, the line is usually the problem.
- Amounts are integer cents everywhere, and dates are `YYYY-MM-DD` strings. Both
  are load-bearing; see docs/design-decisions.md before changing either.

## Things that will be turned down

- Multi-currency, multi-user or shared budgets. Not because they are bad ideas, but
  because they touch every balance calculation and this app has one user to test
  against.
- Bank aggregator integrations. The reasoning is in docs/measurements.md and it is
  a decision, not an oversight.
- Anything that sends more to a model than the payee text, amount, date, memo and
  envelope names.
