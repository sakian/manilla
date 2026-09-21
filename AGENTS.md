# Manilla

Self-hosted envelope budgeting. Read [README.md](README.md) for what it is and
[docs/requirements.md](docs/requirements.md) for the identifiers — `FR-37`, `CA-3`,
`VW-5` — that comments throughout the code cite. A comment saying "(FR-37)" leads
somewhere; follow it before changing the thing it describes.

## The one invariant

**The sum of all envelope balances equals the sum of all account balances.**
Accounts hold real money, envelopes hold its assignment, and both are derived from
the same records. `checkInvariant()` compares them, the home screen reports any
difference, and `src/ledger/ledger.ts` is where writes that touch both sides live.

If a change can make those two totals disagree, it is wrong, and no amount of
convenience elsewhere buys it back.

## Rules that are load-bearing

**Money is integer cents. Never a float.** `1234.56 * 100` is
`123455.99999999999`. `parseAmount` in `src/money.ts` works on the digit string;
`formatMoney` is the only display formatter and owns the currency symbol.
Ambiguous input is flagged, never guessed.

**Dates are `YYYY-MM-DD` strings. Never `Date` objects.** A bank posting date is a
calendar date, not an instant. Parsing `20250903000000[-6:MDT]` into a `Date` and
reading it back elsewhere moves a transaction into the previous day, and therefore
into the wrong budget month. Month arithmetic is `src/budget/month.ts`.

**Automation proposes; a person confirms.** Suggestions are stored apart from
confirmed lines so accuracy can be measured. Only suggestions above the low band
move money, and what has not been reviewed says so on screen.

**Rules are never written for anyone.** The app notices when a rule would help and
asks. A wrong rule stays wrong where history would drift towards the truth.

**Undo is a contra entry, not a delete.** Sending an allocation back writes the
opposite move so the envelope's history still shows what happened.

**Nothing holding money can be hidden.** Archiving an envelope or account with a
balance is refused, and says how much is in the way.

## Layout

- `src/` — behaviour, and where the tests are. Pure logic belongs here even when
  only `app/` calls it.
- `app/` — Next App Router: pages, server actions, components. **Not reachable by
  the test runner** (`npm test` globs `src/**/*.test.ts`), so anything worth
  testing goes in `src/`. See issue #16.
- `db/schema.ts` — the authority on the data model. `db/migrations/` is generated
  by drizzle-kit; never hand-edit a migration that has run.
- `spikes/` — runnable investigations behind [docs/measurements.md](docs/measurements.md).

## Working here

```bash
docker compose up -d db      # Postgres on 5433
npm test                     # node --test, no framework
npm run typecheck
npm run build
```

Tests that need Postgres **skip cleanly when it is absent**, so a green run proves
nothing unless they actually ran — check the count, don't just look for "0 fail".

Every server action is a POST endpoint reachable without the page that renders its
button, so each one calls `requireUser()` itself. The only exceptions are in
`app/login/actions.ts`, and each says why it is safe to be public.

**Never commit real financial data.** `data/private/`, `.env`, `certs/` and
`backups/` are gitignored and stay that way. Fixtures in `data/samples/` are
synthetic. Account numbers, balances and anybody's name do not belong in a commit,
a test, or a commit message.

Comments explain *why*, not *what*. Match the density of the surrounding file.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
