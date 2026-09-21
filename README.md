# Manilla

Self-hosted envelope budgeting. Money in your accounts is assigned to virtual
envelopes — Groceries, Gas, the water bill — and the two sides always agree to the
cent. Statements go in as OFX/QFX files, a layered classifier proposes an envelope
for each transaction with how sure it is, and you confirm or correct in one pass.

Built to fix the two things that make envelope apps tedious: getting transactions
in often enough to be useful mid-month, and categorizing them without doing it all
by hand.

| | |
| --- | --- |
| Stack | TypeScript, Next.js 16, Postgres, Docker |
| Sign-in | Passkeys (WebAuthn) with single-use recovery codes |
| Access | Its own node on your tailnet — no port open to anything |
| Classifier | Your rules → payee history → optionally the Claude API, with an off switch |
| Banking | File import. Canada; automatic feeds deliberately deferred |
| Users | One |

## What it does

**The ledger holds.** Every envelope balance and every account balance is derived
from transactions, allocations and transfers, and their totals are compared after
every write. A discrepancy is shown, not swallowed.

**Import is preview-then-commit.** Duplicates are matched on the bank's own
transaction ID, look-alikes are flagged rather than dropped, a stated closing
balance is checked against the result, and a whole import can be undone.

**Categorization proposes; you confirm.** Rules fire first, then recency-weighted
payee history, then — if you leave it on — a model, only for what the free layers
could not place. Every suggestion shows its confidence and its reason. Rules are
never written for you: Manilla notices when one would help and asks.

**The review queue stages.** You work down the list marking rows and nothing is
written until you save, so a sitting abandoned halfway leaves the ledger exactly as
it was. Suggestions in the medium band and up are already applied to balances so
mid-month figures are useful, and each envelope card says how much of its balance
is still unreviewed.

**A budget is a plan; an allocation is a fact.** Funding writes dated records out
of the income pool, so changing this month's plan cannot rewrite what a past month
actually received.

**Everything is one screen where it can be.** Envelopes and the dashboard are one
list. Accounts are the same screen for the other half of the ledger. Every
transaction list is `/transactions` with a filter, and pressing an envelope, a
group, an account or a category lands there with that filter applied. What needs
attention is one ranked list shown on every main screen — and nothing at all when
there is nothing to say.

**Your data leaves as easily as it arrived.** JSON or CSV, any time, from Settings
or a URL. Passkeys, sessions and recovery codes are never in it: they are
credentials, not records of your money.

## Honest limitations

- **One user.** The schema is keyed by row so a second login is additive, but
  nothing is built. The first visitor to a fresh install claims it by registering a
  passkey, so do that before it is reachable by anyone else.
- **One currency, and it is dollars.** The symbol is one constant
  (`src/money.ts`); thousands separators follow the server's locale. Nobody has
  tried it anywhere else.
- **Canada-shaped.** OFX/QFX only, and the argument for deferring automatic feeds
  is specifically about Canadian banking. See [docs/measurements.md](docs/measurements.md).
- **Automatic categorization tops out around 72%** of transactions accepted
  unchanged, because 68% of transactions happen at merchants used for more than one
  envelope. This was measured, not guessed, and it is why the review queue matters
  more than the classifier.
- **No rate limiting** on recovery-code sign-in. 60 bits of entropy per code makes
  brute force impractical, and the app is meant to sit behind a tailnet, but it is
  worth knowing.
- **`docker-compose.yml` defaults the Postgres password to `manilla`.** It is bound
  to loopback and never published, but set `POSTGRES_PASSWORD` anyway.
- **No audit trail** for edits and deletions yet (NF-2). Undo is a contra entry
  rather than a delete, so envelope history survives, but a changed transaction does
  not record what it used to say.

## Documentation

- [docs/requirements.md](docs/requirements.md) — every FR-/VW-/CA-/RQ-/MG-/NF-/RP-
  identifier cited in the code, what it asks for, and whether it is built.
- [docs/design-decisions.md](docs/design-decisions.md) — the choices that would be
  expensive to reverse, and why.
- [docs/measurements.md](docs/measurements.md) — what was measured against real
  data: the accuracy ceiling, the four silent-corruption defects, and the case for
  waiting on open banking.

## Getting set up

Node 24 or newer, and Docker for Postgres. Node runs the TypeScript directly, so
there is no build step in development, and the test suite is `node --test` with no
framework.

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
  transactions/         every transaction, filtered however you like, and manual
                        entry, correction and deletion (VW-5, VW-6, FR-2, FR-4, FR-5)
  envelopes/[id]/       one envelope: its history, transfers, cover an overspend (VW-4, FR-34, FR-35)
  accounts/             accounts under categories (FR-1, FR-3)
  search/               a redirect, so links saved from the old search page still work
  login/, settings/     passkey sign-in and registered devices (NF-3)
  auth.ts               the session check every page and action goes through
proxy.ts                redirects a signed-out browser before a page renders
db/
  schema.ts             the data model (docs/requirements.md)
  migrations/           generated by drizzle-kit
src/
  money.ts              integer-cents parsing and formatting; never floats (NF-1)
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
  transactions/urlQuery.ts the filters as they live in the URL, so a search is a link
  envelopes/            envelope and group management, transfers, cover
  accounts/             account management
  auth/                 passkeys, sessions, recovery codes, RP configuration
  categorize/
    normalize.ts        payee normalization (CA-1)
    history.ts          recency-weighted history matching (CA-3, CA-4)
    ai.ts               Claude layer for unknown merchants (CA-5, CA-8)
    pipeline.ts         rules -> history -> AI, with confidence bands (CA-7)
spikes/                 runnable investigations; see docs/measurements.md
deploy/                 the Tailscale serve config, and an Nginx example as a fallback
docs/                   requirements, design decisions, measurements
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

Manilla uses port 3001 by default, set by `MANILLA_PORT`, on the assumption that
something already has 3000. `MANILLA_ORIGIN` has to name the same port: a passkey
is bound to an exact origin, port included, so a mismatch means every sign-in
fails with nothing useful on screen.

The first visit asks you to create a passkey, and shows ten recovery codes once.
Save them: they are stored hashed, and they are the only way in if the device
holding your passkey is lost. More devices can be added from Settings.

```bash
npm test                         # no network, no spend
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
sudo ufw allow from <your LAN subnet> to any port 3001 proto tcp
```

Then point the hostname at this machine in whatever answers DNS on your network -
a Pi-hole's Local DNS records, your router's host table, or `/etc/hosts` on the
one device if that is all you need - and set `MANILLA_RP_ID` and `MANILLA_ORIGIN`
to the hostname and `https://<hostname>:3001`.

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

### Where your own configuration lives

Nothing about your deployment belongs in a tracked file, and nothing here needs
it to be. Everything in `docker-compose.yml` that varies is an environment
variable with a working default — `${MANILLA_TS_HOSTNAME:-manilla}`,
`${MANILLA_RP_ID:-localhost}`, `${POSTGRES_PASSWORD:-manilla}` — and
`deploy/tailscale-serve.json` uses Tailscale's own `${TS_CERT_DOMAIN}` rather
than a name. So a clone gets defaults that work, and your `.env` (gitignored)
gets your tailnet.

For anything that is not a value — an extra volume, a different image tag, a
published port you do want — write a `docker-compose.override.yml`. Compose reads
it automatically and merges it over the base file, and it is gitignored, so you
never have to edit a tracked file to run your own arrangement and never have to
un-edit one to pull.

`npm run backup` copies `.env` alongside the database dump, because it is what
says which hostname your passkeys are bound to and a ledger restored under the
wrong name is not a restore. It also means the backup holds your API key; the
dump already held your entire financial history, so treat the directory as the
secret it always was, or set `MANILLA_BACKUP_ENV=0` to leave the file out.

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

## The logo

`design/manilla-logo.png` and the icons generated from it by `scripts/icons.mjs`
are AI-generated, and the accent colours are drawn from the mark. Said plainly
because it affects what a fork inherits: the copyright status of AI-generated
images is unsettled in some jurisdictions, so treat the mark as the least certain
thing in this repository. Everything else here is covered by the MIT licence in
the usual way. Replacing it is one file plus `npm run icons`.

## Running the spikes

Put real exports in `data/private/` first. That folder is gitignored, so
financial data never reaches version control.

```bash
npm run ofx              # profile bank OFX/QFX files
npm run goodbudget       # profile an export from another app, cache parsed history
npm run categorize       # accuracy of rules + history layers (free)
```

The categorizer eval holds out recent transactions, categorizes them against
the history that preceded them, and compares the result to what you actually
chose. The AI layer is opt-in because it spends money:

```bash
npm run categorize -- --ai --limit 100   # cap the spend while trying it
npm run categorize -- --months 3         # widen the held-out window
```

The key comes from `ANTHROPIC_API_KEY`, which `.env.example` shows where to put.

