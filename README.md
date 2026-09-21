# Manilla

Envelope budgeting, built to fix the two things that make shared envelope apps
tedious: getting transactions in often enough to be useful mid-month, and
categorizing them without doing it all by hand.

Requirements live in the [requirements doc](https://claude.ai/code/artifact/5da0430a-8b8f-44cd-af2b-277fb6345fb5).

## Status: Phase 2, history and reports

Phase 0 (de-risking) and Phase 1 (the core ledger) are complete: accounts,
envelopes and groups, OFX/QFX import with deduplication, the review queue, the
monthly budget with income allocation, envelope transfers, manual entry, and
passkey sign-in so it is safe to reach from a phone.

The review queue stages rather than commits: you work down the list marking rows,
every suggestion is filled in with how sure it is beside it, and nothing is
written until you save — so a sitting abandoned halfway leaves the ledger exactly
as it was. Rules are never written for you: the history layer learns without
them, and a rule fires *before* history looks at anything, so a wrong one stays
wrong where history would drift towards the truth. What Manilla does instead is
notice when one would help — a payee sorted the same way every time, never
anywhere else — and ask. Declining sticks.

Phase 2 is complete bar CSV import: a multi-year export from another envelope
budgeting app comes across with its envelopes, splits, income and transfers;
spending reports run over any period; the data exports as JSON or CSV; and the
database is backed up nightly with a restore that has been exercised.

| Decision | Answer |
| --- | --- |
| Stack | TypeScript, Next.js + Postgres, self-hosted in Docker |
| Banking | Canada (OFX/QFX import; waiting for consumer-driven banking, see below) |
| AI | Hosted Claude API (`claude-opus-5`), minimal payload, off switch |
| Users | Single user for now; multi-user deferred |
| Sign-in | Passkeys (WebAuthn), with single-use recovery codes |

Phase 2 has started: the migration wizard is in (MG-1 to MG-7), so a multi-year
export from another envelope budgeting app comes across with its envelopes,
splits, income, envelope transfers and account transfers, and the balances it
cannot rebuild are reconciled rather than fudged. The wizard asks which app the
file came from, so a second format is a loader rather than a rewrite.

Phase 3's AI layer is in and on by default, switchable from Settings: it is asked
only about transactions your own rules and history could not place, with a
monthly call budget, a cost counter and a running accuracy measure. Re-measured
on three held-out months of the real history at 71.7% accepted unchanged and
98.6% precision in the auto-confirm band, for $0.36.

Search and filtering are in (VW-5, VW-6): one query, filterable by text, date,
amount, direction, envelope, account, status and kind, with the filters in the
URL so a search can be bookmarked and downloaded as the CSV of exactly what is
on screen. It lives on the screens that list transactions rather than on a page
of its own - the account view with no account picked is every transaction.

The screens then went through a usability pass. There are three places —
envelopes, accounts, reports — because seven did not fit across a phone and most
of them were not destinations: importing is a button where the statements go, the
review queue is reached from the notice saying there is something to review, and
migrating lives in Settings because it happens once. The budget screen went
altogether: it edited the same standing plan the envelopes screen edits, so what
was worth keeping — what each envelope actually costs, averaged over a year and
last month — moved next to the box where the plan is set.

The dashboard and the envelope list were one column of balances shown twice, so
they are one screen: two lines per envelope (name with its balance, then plan and
spend), the whole card a link into it, and renaming, archiving, regrouping and
planned amounts behind an Edit button. Envelopes are alphabetical inside their
group and groups keep a manual order — dozens of one are scanned, a handful of the
other are read as a shape.

The accounts screen is deliberately the same screen for the other half of the
ledger: accounts under categories you name, two lines per card, the whole card a
link, everything structural behind Edit.

Every list of transactions is one screen. There were three — on the accounts
screen, on an account's page, and a search page — and they were the same list with
different things pinned, so tapping an envelope, an envelope group, an account or
an account category now lands on `/transactions` with that filter applied, where it
can be widened, narrowed or cleared. Filters: payee, memo, free text across both,
envelope, envelope group, account, account category, status, kind, date range,
amount range and direction. When exactly one envelope or account is in view its own
figures stand above the list, so arriving from a card does not lose what the card
was saying.

What needs attention is one ranked list, read once on the server and shown on
every main screen: a ledger that does not add up, an overdrawn pool, overspent
envelopes, a plan beyond the income to fund it, transactions to review. A quiet
screen shows nothing at all.

Every dialog's open-ness lives in the URL, as a shallow navigation — so the
phone's back button closes a dialog instead of leaving the page under it, Escape
does the same, and an open transaction is a thing you can link to. Nothing is
fetched to open one.

Moving money is one dialog, beside the envelopes being filled: every envelope is
listed whether it has a plan or not, amounts can be added or given as a target
balance, and they can be negative to take money back out. What Available would be
left with is worked out as you type, and nothing is written until you apply —
including, if you want, into an overdrawn pool, which the home screen then keeps
saying out loud. Screen explanations sit behind a `?` beside each heading rather
than a paragraph you read once and then read past for ever.
The budget screen shows each envelope's plan next to what it actually cost -
last month, and averaged over a year - with every figure labelled on every row,
because a phone has scrolled the table header away by the time you reach
Groceries. Expected income is measured over six months rather than typed. A
confirmed transaction can be sent back to the review queue, and a transfer
pairing undone, without deleting anything.

Automatic bank feeds are deliberately not being built yet. Direct OFX is a dead
end in Canada — there is no Direct Connect with Canadian institutions, and
Quicken Canada's "Express Web Connect" is aggregator-backed scraping in an OFX
costume. That leaves the aggregators (Plaid, Flinks, Mastercard Open Banking),
which mostly work by holding your online banking credentials and signing in as
you where no real API exists. That breaches the banks' own agreements and moves
liability for fraud onto the customer, which is a poor trade for saving a monthly
download.

The alternative has a date. The Consumer-Driven Banking Act passed in June 2024;
the Bank of Canada is lead regulator; draft regulations were published on 27 June
2026 with comments closing 26 August 2026, and the framework comes into force
within a year of final publication. The large banks must participate from the
outset, and phase one is read access. So the decision is to wait for it rather
than integrate an aggregator in the meantime.

One wrinkle worth remembering: phase one phases data in *by account type* —
deposit and payment accounts first, then lending, and registered and
non-registered investment accounts last. Chequing and credit cards will arrive
well before an RRSP does, and RRSPs may stay a manual download for a while after
the rest is automatic.

The schema is already shaped for it: `bank_sync` is a transaction source and
`aggregator` an external-id kind, so a feed is additive rather than a rewrite.

Still outstanding: CSV import with a column-mapping step (FR-8), period
comparisons and income-against-spending (RP-3, RP-4), progress bars and a pace
marker on the dashboard (VW-1, VW-2), a balance-over-time chart on an envelope
(VW-4), reconciliation of an account against a statement (FR-6), and per-month
budget overrides (FR-32, which the data model and the reads support but which no
screen now writes — the month navigation that could have gone with them went with
the budget screen).

## What Phase 0 measured

Measured against a real 7,957-row export from six years of envelope budgeting
(2021-2026) and a real TD OFX file, holding out the most recent three months
(435 transactions):

| | History only | History + AI |
| --- | --- | --- |
| Accepted unchanged | 62.8% | **72.4%** |
| Got any suggestion | 90.6% | 99.5% |
| Auto-confirm precision at 0.95 | - | 98.6% (covering 15.9%) |
| Cost per 1,000 transactions | $0 | ~$2 |

Re-measured against the same three months once the layer was wired into the app:
62.8% and 71.7%, with 98.6% auto-confirm precision and $2.09 per 1,000. The model
is not deterministic, so the AI figure moves by a few tenths of a point between
runs.

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

## Getting set up

Node 24 or newer, and Docker for Postgres. Node runs the TypeScript directly, so
there is no build step in development.

```bash
npm install
```

## What's here

```
app/                    the web app (Next.js App Router)
  page.tsx              home: envelope balances and what needs attention (VW-1, VW-3)
  HomeScreen.tsx        the merged dashboard and envelope list, view and edit modes
  Notices.tsx           one ranked list of what is wrong or worth knowing
  Hint.tsx              screen explanations, behind a marker rather than always on
  useOverlay.ts         a dialog's open-ness in the URL, so back closes it
  review/               the review queue: decide, then save in one go (RQ-1 to RQ-5)
  budget/               funding envelopes out of Available, and the plan's writes (FR-27 to FR-31)
  import/               OFX/QFX import: preview, decide, commit (FR-7 to FR-14)
  migrate/              the migration wizard (MG-1 to MG-7)
  reports/              spending by envelope, month by month, with CSV (RP-1 to RP-6)
  transactions/         entering, correcting and deleting by hand (FR-2, FR-4, FR-5)
  envelopes/[id]/       one envelope: its history, transfers, cover an overspend (VW-4, FR-34, FR-35)
  accounts/             accounts under categories (FR-1, FR-3)
  transactions/         every transaction, filtered however you like (VW-5, VW-6)
  login/, settings/     passkey sign-in and registered devices (NF-3)
  auth.ts               the session check every page and action goes through
proxy.ts                redirects a signed-out browser before a page renders
db/
  schema.ts             the section 9 data model
  migrations/           generated by drizzle-kit
src/
  money.ts              integer-cents parsing; never floats (NF-1)
  csv.ts                RFC 4180 reader (quoted commas, embedded newlines, BOM)
  ofx/parse.ts          OFX 1.x (SGML) and 2.x (XML), plus QFX
  migrate/sources.ts    which apps can be migrated from, and the loader for each
  goodbudget/load.ts    one such loader, with column auto-detection
  ledger/ledger.ts      balances and the writes that keep the two sides equal (FR-37)
  import/ofxImport.ts   preview-then-commit import with dedupe (FR-7 to FR-14)
  queue/queue.ts        the review queue's reads and writes
  budget/               months, the plan, funding and reversal
  migrate/migrate.ts    a loaded export, written as transactions (MG-1 to MG-7)
  notices/notices.ts    what needs attention, as data, for every screen to show (VW-3)
  reports/reports.ts    spending read from envelope lines, so RP-5 holds by construction
  ai/ai.ts              the off switch, budget, merchant cache and accuracy measure (NF-5)
  export/export.ts      the whole ledger as JSON or CSV (NF-6)
  transactions/manage.ts manual entry, edits, deletions, account transfers
  accounts/groups.ts    categories of accounts, shaped like envelope groups (FR-3)
  transactions/search.ts the one filter query behind every transaction list (VW-5, VW-6)
  envelopes/            envelope and group management, transfers, cover
  accounts/             account management
  auth/                 passkeys, sessions, recovery codes, RP configuration
  categorize/
    normalize.ts        payee normalization (CA-1)
    history.ts          recency-weighted history matching (CA-3, CA-4)
    ai.ts               Claude layer for unknown merchants (CA-5, CA-8)
    pipeline.ts         rules -> history -> AI, with confidence bands (CA-7)
spikes/                 runnable Phase 0 investigations
deploy/                 the Tailscale serve config, and an Nginx example as a fallback
data/samples/           synthetic fixtures, safe to commit
data/private/           your real exports - gitignored
```

## Running it

```bash
docker compose up -d db          # Postgres on 5433
cp .env.example .env             # then fill in DATABASE_URL and the passkey host
npm run db:migrate
npm run seed                     # a starting chart of envelopes and one account
npm run dev                      # http://localhost:3001
```

Manilla uses port 3001 by default, set by `MANILLA_PORT`, because port 3000 on
this machine is already taken. `MANILLA_ORIGIN` has to name the same port: a
passkey is bound to an exact origin, port included, so a mismatch means every
sign-in fails with nothing useful on screen.

The first visit asks you to create a passkey, and shows ten recovery codes once.
Save them: they are stored hashed, and they are the only way in if the device
holding your passkey is lost. More devices can be added from Settings.

```bash
npm test                         # 358 tests; no network, no spend
npm run typecheck
npm run import -- path/to/statement.ofx
```

The ledger, budget, envelope, account, import and auth tests run against a real
Postgres and skip cleanly when none is reachable, so the suite still passes on a
machine without Docker running.

### Reaching it from a phone on the LAN

Two things stop a LAN address working: a passkey needs a secure origin, and its
relying-party ID has to be a domain name - an IP address is not a valid one, so
`http://192.168.1.2:3001` can never sign you in however the browser is coaxed. A
hostname over HTTPS fixes both, without Tailscale:

```bash
npm run dev:cert                 # a dev CA and a certificate for manilla.lan
npm run dev:https
sudo ufw allow from 192.168.1.0/24 to any port 3001 proto tcp
```

Then point the hostname at this machine in local DNS (Pi-hole's Local DNS
records) and set `MANILLA_RP_ID` and `MANILLA_ORIGIN` to the hostname and
`https://<hostname>:3001`.

Last, trust the CA on the phone: open `/api/dev-ca` there (a development-only
route), accept the certificate warning once, and install what it offers. On iOS
installing the profile is only half of it - it also has to be switched on under
Settings, General, About, Certificate Trust Settings. Until the certificate is
genuinely trusted, WebAuthn is switched off by the browser and registering a
passkey fails with "the operation is insecure"; accepting the warning is not
enough, which is the whole trap. Firefox keeps its own certificate store, so it
needs the CA imported into Firefox rather than into the operating system.

`certs/` is gitignored, and the CA key stays on this machine: anything trusting it
would accept a certificate for any name.

## Deploying to the home server

Manilla runs as **its own node on your tailnet**, next to Postgres and a Tailscale
sidecar. A tailnet node gets exactly one DNS name, so a machine running several
services either routes them by port and path behind a reverse proxy, or gives each
service a node of its own — and a node is not a machine, it is a container. So
Manilla is `manilla.<your-tailnet>.ts.net`, with a real browser-trusted
certificate renewed by the thing that issued it, and whatever else the box runs
carries on exactly as it did.

The app shares the sidecar's network namespace, so it has no address of its own:
not on the LAN, not on the host, not on loopback. The only way in is through its
Tailscale node, and the only people there are the ones on your tailnet.

```bash
# 1. A reusable auth key from login.tailscale.com/admin/settings/keys
cp .env.example .env            # then fill in TS_AUTHKEY and the two below
#    MANILLA_RP_ID=manilla.your-tailnet.ts.net
#    MANILLA_ORIGIN=https://manilla.your-tailnet.ts.net

# 2. In the admin console, turn on MagicDNS and HTTPS certificates.

# 3. Up it goes. The app migrates the database itself on start.
docker compose up -d --build
docker compose logs -f app      # "database is up to schema", then the origin

# 4. Clear TS_AUTHKEY from .env - the node keeps its identity in a volume.
```

Then open `https://manilla.your-tailnet.ts.net` from any device on the tailnet.

**Your existing passkey will not work there.** A passkey is bound to an exact
host, so moving off `manilla.lan` invalidates it — which is the intended
behaviour, not a bug. Sign in with one of your recovery codes and register a
passkey for the new origin from Settings. Worth doing early, while there is one
passkey to replace rather than four.

In production the boot check refuses to start on a localhost relying-party ID or
a schema it could not bring up to date, with the reason in
`docker compose logs app`. Serving against a half-migrated schema is how a ledger
ends up half-written, so both are fatal rather than warnings.

`deploy/nginx.conf.example` is still there for the other arrangement — one node
for the whole machine, a reverse proxy in front of several services, and a
systemd timer to re-run `tailscale cert` every 90 days. The sidecar exists so none
of that is needed for this one service.

## Backups (NF-7)

```bash
npm run backup          # a verified pg_dump, plus the node's identity, pruned
npm run restore         # the newest backup into a scratch database, checked
```

The backup takes the Tailscale sidecar's state as well as the database. It is
small and load-bearing: it is what makes the machine `manilla.<tailnet>.ts.net`
rather than some other name, and a passkey is bound to an exact hostname — so
losing it would stop every registered passkey working at the same moment. A
ledger restored under a name nobody can sign in to is not a restore.

`scripts/backup.sh` writes to `backups/` (gitignored), reads the archive back to
prove it is not a half-written file, and keeps the last 14. It runs Postgres's
own `pg_dump` inside the container rather than the host's, because a dump written
by an older client than the server is a restore that fails on the day it matters.

`scripts/restore.sh` restores into `manilla_restore_check` and leaves the live
database alone, so the procedure can be exercised on an ordinary Tuesday. After
restoring it runs the FR-37 check against the restored copy - envelope balances
against account balances - which is the difference between "the file could be
read" and "the books came back". Pass `--into manilla` to restore over the live
database; it asks for the name to be typed first.

Nightly, via `crontab -e`:

```
30 2 * * * cd /path/to/manilla && /bin/bash scripts/backup.sh >> /path/to/manilla/backups/backup.log 2>&1
```

A backup nobody has restored is a hope rather than a backup, so run
`npm run restore` occasionally and read what it prints.

## Taking your data out (NF-6)

Settings has a JSON export of everything - each transaction with its envelope
shares and the bank ids it has collected - and a CSV per table for a
spreadsheet, where a split becomes one row per envelope share. Passkeys,
sessions and recovery codes are never included: they are credentials, not
records of your money.

The same thing from a terminal:

```bash
curl -b "manilla_session=..." 'http://localhost:3001/api/export?format=json' -O
curl -b "manilla_session=..." 'http://localhost:3001/api/export?format=csv&table=transactions' -O
```

## Running the spikes

Put real exports in `data/private/` first. That folder is gitignored, so
financial data never reaches version control.

```bash
npm run ofx              # profile bank OFX/QFX files
npm run goodbudget       # profile an export, cache parsed history
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

**Date *format* is decided per file, never per row.** The real export this was
built against is D/M/Y despite being a North American file. The format is inferred from rows
that can only be read one way - a first component above 12 - and 4,450 such rows
settle it. Guessing per row would have silently misdated thousands of
transactions.

**Automation proposes, you confirm.** Imported transactions arrive as
*pending review* with a suggested envelope and a confidence score. High
confidence is bulk-confirmable; low confidence is left uncategorized with
candidates rather than guessed at.

**The AI layer is last, and asked per transaction rather than per merchant.**
Rules and history handle what they can for free, so the model only sees what they
could not place. Caching one answer per merchant looks like the obvious saving
and measured ten points *worse*: 68% of transactions happen at merchants used for
more than one envelope, and the amount is what separates them, so one answer for
"AMAZON" applied to every Amazon charge throws that signal away. A confident
answer is cached for that merchant - a fuel station is a fuel station - and an
unsure one is asked again with its own amount. A monthly call budget is checked
before each call rather than after, a failed call stops the layer instead of the
import, and Settings shows exactly what is sent: payee text, amount, date and
envelope names. Never an account number, a balance or anyone's name.

**A budget is a plan; an allocation is a fact.** The plan says what each envelope
should receive each month. Funding writes dated allocation records out of the
income pool, so changing December's plan cannot rewrite what August actually
received (FR-30). Funding proposes the *remainder* of the plan, so funding twice
never fills twice, and per-paycheque funding needs no arithmetic.

**Undo is a contra entry, never a delete.** Sending an allocation back writes the
opposite move rather than removing the record, so the envelope's history still
shows what happened.

**Nothing holding money can be hidden.** Archiving an envelope or an account with
a balance is refused, and says how much is in the way. An invisible balance still
counts towards the total the dashboard checks (FR-25, FR-37).

**A spending report reads envelope lines, never transactions.** That one choice
is what makes RP-5 true by construction rather than by remembering: a transfer
between your own accounts has no envelope lines so it cannot appear however the
sum is written, an envelope-to-envelope move is not a transaction at all, and a
split is already stored as one line per envelope so each is counted at its own
share without anything having to divide it.

**A migration reports what it cannot do.** The "Fill Envelopes" rows of the
format this was built against carry no amounts, so the money put *into* envelopes
over the years is simply not in the export: past spending rebuilds exactly, past
envelope balances do not. The wizard says so before anything is written, and
closes the gap with dated adjustments you read off your old app rather than with
a number from nowhere.

**Sign-in is a passkey, and sessions have two clocks.** WebAuthn is bound to the
origin, so there is nothing to phish and nothing to reuse. The cookie holds a
random token whose hash is what the database stores; sessions lapse after 12 idle
hours and end for good after 30 days, however busy.
