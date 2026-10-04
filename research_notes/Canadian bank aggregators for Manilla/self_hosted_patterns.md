# Self-hosted and indie budgeting apps: bank-sync patterns for North America (Canada emphasis), as of October 2026

Research date: 2026-10-04. About 25 searches and fetches. Several primary pages could not be fetched (support.plaid.com returned 403, openbankingtracker returned 429, the YNAB help page rendered empty). Where a claim comes only from a search-engine snippet of a page, it is marked "(snippet)".

## SimpleFIN Bridge: mechanism, price, underlying aggregator, Canada, data model, limits

### Takeaway
SimpleFIN Bridge costs US$1.50/month or US$15/year for up to 25 institutions and 25 apps. It sits on top of MX, which holds the credential connection. A user exchanges a one-time setup token for a read-only access URL. Data refreshes about once a day, apps are asked to poll no more than 24 times a day, and each request covers at most 90 days. The data model has a per-account transaction `id`, a `pending` flag, `posted` (which may be 0 while pending) and an optional `transacted_at`. Canada is covered only as far as MX covers it. Sources say "US and Canada", but I found no published list of which Canadian banks work through SimpleFIN.

### Cited Findings
- Price: "$1.50 + tax per month, or $15.00 + tax per year". "Connect up to 25 institutions and 25 apps." — [SimpleFIN Bridge home](https://beta-bridge.simplefin.org/)
- Protocol flow: the user gets a Setup Token (Base64 of a claim URL), the app POSTs to `/claim/:token`, and the server returns an Access URL with embedded credentials that is used for all later requests. The protocol provides "read-only access to a User's financial data". — [SimpleFIN protocol spec](https://www.simplefin.org/protocol.html)
- Transaction fields: `id` ("uniquely describes a transaction within an Account", so IDs are unique per account, not globally); `posted` ("When the transaction posted… If pending, this may be 0"); `transacted_at` (optional); `pending` (boolean, "true indicates that this transaction has not yet posted"); `amount` (positive means a deposit); `description`. — [SimpleFIN protocol spec](https://www.simplefin.org/protocol.html)
- Account fields: `currency` (ISO 4217 or a custom currency URL), `balance`, `available-balance`, `balance-date`. `/accounts` takes `start-date` and `end-date` (Unix epoch), `pending=1` to include pending transactions (they are excluded unless asked for), and `balances-only=1`. Errors come back as a structured `errlist` (codes such as `con.auth` and `act.failed`), which replaces the deprecated string `errors` array. The `/info` endpoint reports protocol versions "1" or "2". — [SimpleFIN protocol spec](https://www.simplefin.org/protocol.html)
- Timestamps are Unix epoch values, not calendar dates. This is relevant to Manilla's rule that dates are `YYYY-MM-DD` strings. — [SimpleFIN protocol spec](https://www.simplefin.org/protocol.html)
- Rate limits: "make 24 requests or fewer per day". Exceeding that brings warnings, and serious violations get the token disabled. Data is "intended to provide daily updates". Requests are "limited to 90 days at a time", and "the number of days of history available varies for each institution". Guidance for developers: fetch at a random minute, overlap date windows by about 5 days so nothing is missed, and always show structured errors to the user. — [SimpleFIN Bridge developer guide](https://beta-bridge.simplefin.org/info/developers)
- The upstream provider is MX: "SimpleFIN's data updates one time / day, roughly every 24 hours… The time of day that each bank updates… may vary… (based on the bank and upstream provider, MX)". Sync pulls "at most 90 days of data". — [Actual Budget SimpleFIN docs](https://actualbudget.org/docs/advanced/bank-sync/simplefin/)
- Credentials go to MX, "the one party in the chain that ever sees your login", and never touch SimpleFIN's or the app's servers. Each app gets its own revocable read-only token. The same post claims an MX bug in May 2026 "caused account data to mix between users", affecting up to 39 users for about 4 hours. It also describes SimpleFIN as providing "US and Canada bank sync". (Third-party blog dated 9 August 2026. I did not confirm the MX incident from a primary source.) — [DueZen: Is SimpleFIN safe?](https://getduezen.com/blog/is-simplefin-safe/)
- A competitor says "SimpleFin relies on MX" as its only provider and "doesn't notify you when connections fail". This is vendor marketing. — [Lunch Flow: SimpleFIN alternative](https://www.lunchflow.app/simplefin-alternative)
- Actual Budget users have filed several SimpleFIN sync bugs: connection-problem errors ("An internal error occurred. Try to log in again"), 504 gateway timeouts, and fetch timeouts when many banks return in one response. — [actual#4376](https://github.com/actualbudget/actual/issues/4376), [actual#5346](https://github.com/actualbudget/actual/issues/5346), [actual#3629](https://github.com/actualbudget/actual/issues/3629), [actual#3228](https://github.com/actualbudget/actual/issues/3228)

### Inferences
- Because SimpleFIN wraps MX, MX's Canadian connections are credential- or screen-scrape based for most of the Big Six until Canadian consumer-driven banking APIs arrive. Expect MFA re-auth prompts and broken connections similar to the Plaid-based apps below. The user fixes them in the SimpleFIN Bridge UI, not in Manilla.
- For Manilla this pattern has the lowest friction: one setup-token field, no webhooks, no company registration, and polling once a day with a 5-day overlap. Pending transactions can change or disappear, so `pending` rows should stay separate from confirmed lines, much like Manilla's split between suggestions and confirmed lines. Matching should use the per-account `id` plus the account id.
- The `posted` and `transacted_at` epoch values must be converted to a calendar date carefully. The spec doesn't say which timezone the bank's posting date was in, which is the same hazard AGENTS.md describes.

### Gaps
- I found no published SimpleFIN or MX list of Canadian institutions, and no first-hand reports (Reddit or GitHub) naming which Canadian banks do or don't work. Searches for SimpleFIN with TD, RBC, Tangerine or Wealthsimple returned nothing specific.
- I couldn't confirm whether SimpleFIN uses any aggregator besides MX in 2026.
- I couldn't tell whether the price is USD and whether Canadians pay GST/HST. It is presumably USD.
- The protocol spec's exact definition of `id` stability (whether the id survives the move from pending to posted) wasn't stated in the fetched summary.

## Actual Budget: providers, Canada, dedupe and pending

### Takeaway
Actual supports SimpleFIN (North America), GoCardless (Europe, closed to new accounts), Enable Banking (Europe), Pluggy.ai (Brazil) and Akahu (New Zealand). SimpleFIN is its only North American path. Dedupe works on `imported_id` and then fuzzy matching within ±7 days. Pending transactions are reconciled to posted ones using the financial ids.

### Cited Findings
- Providers: Akahu (NZ), Enable Banking (EU), GoCardless BankAccountData (EU, "not accepting new accounts"), SimpleFIN Bridge (North America), Pluggy.ai (Brazil). Sync is triggered by hand (the Bank Sync button, or pull-to-refresh on mobile), not on a schedule. — [Actual Budget bank sync docs](https://actualbudget.org/docs/advanced/bank-sync/)
- SimpleFIN setup in Actual: create a Bridge account, go to My Accounts > Apps > New Connection, and paste the one-time setup token. Requires client and server version 24.10.0 or later. — [Actual SimpleFIN docs](https://actualbudget.org/docs/advanced/bank-sync/simplefin/)
- Dedupe: "Transactions with the same imported_id will never be added more than once". Otherwise Actual matches the same amount with similar dates and payees. The described algorithm is an exact `imported_id` match, then same amount, date within ±7 days and same payee, then same amount and date within ±7 days regardless of payee. — [Actual: Importing transactions](https://actualbudget.org/docs/transactions/importing/) (snippet); [DeepWiki: Actual bank sync](https://deepwiki.com/actualbudget/actual/6.3-bank-synchronization-and-import) (secondary)
- Pending: on import Actual matches previously pending transactions that have now posted and takes them out of the pending state, using financial ids. — [Actual: How transaction reconciliation works](https://medium.com/actualbudget/how-transaction-reconciliation-works-8dc5749bbd21) (snippet)
- Known failure modes: mixing import paths that compute `imported_id` differently creates duplicates, and providers that re-send a row under a new id cause re-imports. — [actual-sync-woob#10](https://github.com/valec56/actual-sync-woob/issues/10); [fork PR "Match bank rows re-sent under a new id"](https://github.com/azimul-kabir/actua/pull/799)
- Lunch Flow also advertises a sync into self-hosted Actual covering banks in 40+ countries. — [Lunch Flow: Actual Budget integration](https://www.lunchflow.app/features/actual-budget-integration)

### Inferences
- Actual's design (stable provider id first, then a fuzzy fallback within ±7 days, with pending reconciled into posted) is a reasonable model for Manilla. Its bugs show that provider ids are not always stable, so the fuzzy fallback is needed.

### Gaps
- Actual's docs don't name Canada explicitly. I found no Actual-specific reports on Canadian bank quality.

## Firefly III data importer: providers and Canada

### Takeaway
The Firefly III data importer supports files (CSV and CAMT), GoCardless/Nordigen, SimpleFIN, Enable Banking and Lunch Flow. Spectre (Salt Edge) has been removed. For a Canadian user, SimpleFIN or Lunch Flow are the only realistic automatic options.

### Cited Findings
- Import flows: file (CSV and CAMT), Nordigen (GoCardless), SimpleFIN and Enable Banking. "Spectre Import is deprecated", and the Spectre code was removed in recent versions. — [DeepWiki: data-importer import flows](https://deepwiki.com/firefly-iii/data-importer/3-import-flows) (secondary); [Firefly docs: data providers](https://docs.firefly-iii.org/tutorials/data-importer/data-providers/)
- SimpleFIN can be set up in the UI or with the `SIMPLEFIN_TOKEN` environment variable. — [Firefly docs: Import from SimpleFIN](https://docs.firefly-iii.org/tutorials/data-importer/simplefin/)
- Lunch Flow needs the `LUNCH_FLOW_API_KEY` environment variable. — [Firefly docs: How to configure](https://docs.firefly-iii.org/how-to/data-importer/how-to-configure/); [Firefly docs: Import from Lunch Flow](https://docs.firefly-iii.org/tutorials/data-importer/lunchflow/)
- Enable Banking covers more than 2,500 banks in 29 European countries over PSD2 APIs, so it doesn't help Canada. — [Firefly docs: Enable Banking](https://docs.firefly-iii.org/tutorials/data-importer/eb/)
- Recent fixes mention "SimpleFIN quota usage", which suggests the 24-requests-a-day cap matters in practice. — search snippet of Firefly release notes via [DeepWiki](https://deepwiki.com/firefly-iii/data-importer)

### Gaps
- I couldn't fetch the canonical Firefly provider reference page (it returned 404 at `/references/data-importer/import-providers/`). There is no Firefly-specific Canadian coverage data.

## Maybe / Sure, Lunch Money, YNAB, Monarch, Copilot: aggregators for Canadians

### Takeaway
The commercial apps all use the large US aggregators. YNAB uses MX and Plaid, Monarch uses Plaid, MX and Mastercard Data Connect (Finicity), and Lunch Money and Copilot use Plaid. Every one warns that Canadian banks are the weak spot. Lunch Money's September 2026 known-issues list shows Plaid problems at BMO, CIBC, RBC, Tangerine, Wealthsimple, PC Financial, Canadian Tire Bank and Coast Capital. Maybe Finance shut down. Its fork Sure supports bring-your-own Plaid keys, SimpleFIN, Lunch Flow and Enable Banking.

### Cited Findings
**Lunch Money (Plaid)**: these known issues were current in mid-2026:
- BMO: data updates fail after an authentication system migration (2 Sep 2026). CIBC: MFA invalidated after initial setup, which breaks background updates (KI123004, 9 Aug 2026). RBC: "increased relinking frequency" (10 Sep 2026). Tangerine: MFA invalidated after setup (KI122553, 5 Sep 2026). Wealthsimple: integration incompatibility (KI787097, 28 Aug 2026). PC Financial: "unexpected response" failures (KI407194, 15 Jul 2026). Canadian Tire Bank: integration needs a rebuild (28 Aug 2026). Coast Capital: migration in progress (KI537252, 10 Sep 2026). — [Lunch Money: Institution-specific issues](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)
- Lunch Money suggests Lunch Flow (paid, MX and Finicity) as an alternative for most of those institutions, and free community tools (Lunchsimple, Sandwich Sync) for Wealthsimple. — [same page](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)
- Automatic import via Plaid is "available to most US and Canadian-based banks". Canadian connections are "particularly prone" to syncing problems because many big banks, including Wealthsimple, still use older authentication while they wait for open-banking and OAuth guidance. — [Lunch Money: Automatic imports](https://support.lunchmoney.app/guides/automatic-imports) (snippet); [Handling syncing issues](https://support.lunchmoney.app/guides/automatic-imports/handling-syncing-issues) (snippet)

**YNAB (MX and Plaid)**
- YNAB "partners with MX and Plaid for Direct Import, and routes each bank through whichever provider is currently performing best". Canadian institutions are "more challenging", and YNAB publishes no list of supported Canadian institutions. — [unifiedbankings: YNAB in Canada (2026)](https://unifiedbankings.com/blog/ynab-canada) (secondary); [YNAB: How Direct Import works](https://support.ynab.com/en_us/how-direct-import-works-H1IGYLgnxl) (page didn't render for me)
- In 2020 YNAB said: "We partner with Plaid… Plaid works with over 11,000 banks across the US, Canada, and Europe". — [YNAB on X, 2020](https://twitter.com/ynab/status/1285197543610167298?lang=en) (dated)

**Monarch (Plaid, MX, Mastercard Data Connect/Finicity)**
- Monarch "uses three main data providers… Plaid, Mastercard Data Connect (Formerly Finicity), and MX". It picks a default per institution and lets the user switch. "Certain Canadian banks" are listed with store cards and mortgages as hard to connect or keep synced, and manual accounts are recommended for them. Monarch serves the US and Canada only, in USD and CAD. — [Monarch: Guide to connecting your accounts](https://help.monarch.com/hc/en-us/articles/360048393352-Guide-to-Connecting-Your-Accounts) (snippet); [borderlessbudget review](https://borderlessbudget.com/blog/monarch-money-review-expats) (secondary)

**Copilot Money (Plaid)**
- Copilot syncs through Plaid, with support built mainly for the US. Canadian support is described as limited, and the app is USD-only with no currency conversion. — [Copilot help: International currency](https://help.copilot.money/en/articles/10715424-international-currency) (snippet); [borderlessbudget: Copilot review](https://borderlessbudget.com/blog/copilot-money-review-expats) (secondary); [Finnomia comparison](https://finnomia.ca/copilot-money-alternative) (competitor marketing)

**Maybe Finance / Sure**
- Sure is "the volunteer fork of Maybe Finance after it open-sourced following shutdown". Maybe was built on Plaid. Recent Sure releases stabilised SimpleFIN and added Lunch Flow as a first-class provider. — [Sure discussion #388 (v0.6.5 bank sync)](https://github.com/we-promise/sure/discussions/388); [Sure SimpleFIN discussion #93](https://github.com/we-promise/sure/discussions/93); [Finlynq vs Maybe](https://finlynq.com/vs/maybe) (competitor, secondary)
- SimpleFIN was proposed for Sure because Plaid "has a convoluted process to setup and approve an account". SimpleFIN needs no application process and no webhook endpoint exposed to the internet. — [Sure discussion #93](https://github.com/we-promise/sure/discussions/93)
- Sure's Plaid docs: self-hosters fill in Plaid's onboarding questionnaire describing the use as "for personal use only on a self-hosted version of the Sure Finance software". Approval takes more than 24 hours, and OAuth banks such as Chase take "3-4 months". Pricing is pay-as-you-go. Production is "not available to European users". The page lists SimpleFIN, Enable Banking and Lunch Flow as alternatives. — [Sure docs: Plaid](https://docs.sure.am/providers/plaid); [sure/docs/hosting/plaid.md](https://github.com/we-promise/sure/blob/main/docs/hosting/plaid.md)
- My fetch summary of the Sure docs read them as saying Plaid "only supports US institutions". That conflicts with Plaid's own Trial-plan page (US and Canada, next section). The Sure doc probably says "Western users", so treat the US-only reading as unreliable.

### Inferences
- Every consumer app that depends on Plaid or MX has the same Canadian failure pattern: MFA tokens invalidated after setup, frequent relinking, and breakage when a bank migrates its authentication. That comes from the credential-based connections underneath, not from any one app.
- Being able to switch provider per institution, as Monarch and YNAB do, is the main tool commercial apps use against poor Canadian coverage. A small self-hosted app gets the same benefit indirectly through Lunch Flow (several aggregators) rather than SimpleFIN (MX only).

### Gaps
- I couldn't get YNAB's own help page text, so its MX-and-Plaid routing claim comes from a secondary 2026 source plus a 2020 tweet.
- I found no Reddit or HN threads from 2026 (r/PersonalFinanceCanada, r/ynab) with first-hand Canadian bank reports. Search returned nothing usable.

## Can an individual get direct production access for Canadian banks?

### Takeaway
Yes, in two ways, both new or small. (1) Plaid's Trial plan, for US and Canadian developers who signed up on or after 15 April 2026, gives free production access up to 10 Items with no business registration. It is the most notable change for a self-hosted Canadian app, though OAuth banks may need further approval. (2) Brokered services such as SimpleFIN (US$15/year) and Lunch Flow (about US$35/year for 2 connections, per a Canada page snippet). Teller is free for up to 100 live connections but covers the US only. Flinks, MX and Finicity sell to businesses, and I found no individual tier. Salt Edge/Spectre has been dropped by Firefly.

### Cited Findings
- Plaid Trial plan: "For developers in the US and Canada who sign up on or after April 15, 2026, Plaid offers a Trial plan — a free way to use Plaid with real production data". It needs "no business registration, security questionnaire, or sales process". It is "auto-approved for most developers", supports up to 10 production Items, and covers Auth, Transactions (with Refresh), Balance, Identity, Assets, Liabilities, Investments and Statements. Developers with an existing Production or Limited Production account are not eligible. After 10 Items, an upgrade to paid Production is needed. — [Plaid: What is the Trial plan?](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan) (snippet; fetch got 403); [Plaid: Sandbox vs Production vs Trial vs Limited Production](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different); [Plaid: Can I use Plaid for free?](https://support.plaid.com/hc/en-us/articles/16194695660311-Can-I-use-Plaid-for-free)
- Earlier route (Sure docs): Plaid Production with a personal-use questionnaire, more than 24 hours to approve, months for OAuth banks, then pay-as-you-go. — [Sure docs: Plaid](https://docs.sure.am/providers/plaid)
- Teller: free developer tier with 100 live connections. Region listed as US, with no Canada support found. — [Teller](https://teller.io/); [apitracker: Teller](https://apitracker.io/a/teller-io) (secondary)
- Lunch Flow: one widget over "MX plus Finicity, GoCardless, Finverse, Pluggy, and more", covering the US, Canada, Brazil, the UK, the EU and Asia. Per a search snippet of a Lunch Flow Canada coverage page, individual pricing in Canada is "$2.92/month or $34.99 billed annually, with 2 connections included and $10.00 per extra connection", with a 7-day free trial. Lunch Flow plugs into Actual, Firefly, Sure, Lunch Money and Google Sheets, and emails the user when a connection fails. — [Lunch Flow: SimpleFIN alternative](https://www.lunchflow.app/simplefin-alternative); [Lunch Flow: Connect Canada Life](https://www.lunchflow.app/coverage/canada-life) (pricing via snippet, unverified); [lunchflow.dev](https://lunchflow.dev/)
- Flinks (owned by National Bank of Canada) is business-focused, with "the lack of a true free tier beyond sandbox". Reported per-connection pricing starts at $0.20 (Connect). — [GitHub: api-evangelist/flinks](https://github.com/api-evangelist/flinks); [SourceForge: Flinks](https://sourceforge.net/software/product/Flinks/) (secondary, pricing unverified)

### Inferences
- For Manilla there are three realistic tiers: (a) SimpleFIN, the cheapest and simplest, with MX coverage and a daily refresh; (b) Lunch Flow, with more aggregator choice for awkward Canadian banks but more expensive per connection; (c) bring-your-own Plaid Trial keys, which are free for a household (10 Items is plenty), offer better freshness and webhooks, but need Plaid Link hosted in the app and run into the same Canadian MFA and relink problems Lunch Money documents.
- Plaid in the trial still means Plaid Link in a browser served by Manilla, plus token storage and possibly webhooks. That is much more surface than pasting a SimpleFIN token.

### Gaps
- Not confirmed: whether the Plaid Trial plan includes Canadian institutions that need OAuth registration (for example RBC or TD if they have moved to OAuth), any time limit on the trial, and its terms of use for personal or self-hosted apps.
- Salt Edge's partner programme and any individual access in 2026: not researched in depth. Firefly removed its Spectre support.
- Lunch Flow's pricing comes from a snippet, not a fetched page, and the currency is not stated.
- No primary source on MX or Finicity offering direct individual access. I found none, and they appear to be business-only.

## Open-source projects using Flinks or Plaid for Canadian banks, and practical issues

### Takeaway
I found no maintained open-source budgeting project that uses Flinks. Open-source projects that use Plaid (Maybe and Sure, plaid-ynab) expect self-hosters to bring their own keys. The documented practical problems are Plaid approval friction, OAuth-bank delays and, for Canada, MFA invalidation and frequent relinking. Lunch Money's known-issues page is the best evidence of the last two.

### Cited Findings
- Open-source projects that use Plaid with bring-your-own keys include Sure/Maybe and plaid-ynab. — [Sure docs: Plaid](https://docs.sure.am/providers/plaid); [colmdoyle/plaid-ynab](https://github.com/colmdoyle/plaid-ynab)
- Canadian Plaid failure modes (2026): MFA invalidated after setup (CIBC, Tangerine), more relinking (RBC), and authentication migrations breaking refresh (BMO). — [Lunch Money: Institution-specific issues](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)
- Canadian banks still rely largely on older authentication (screen-scraping) while open banking is pending. Flinks and National Bank built their own "Open Banking Environment" because they were "tired of waiting", with the budgeting app Moka as the first partner. — [Lunch Money: Handling syncing issues](https://support.lunchmoney.app/guides/automatic-imports/handling-syncing-issues) (snippet); [BetaKit](https://betakit.com/tired-of-waiting-flinks-launches-its-own-open-banking-environment-with-national-bank/) (dated, pre-2026)
- Sure dropped the Plaid-only approach partly because Plaid needs a webhook endpoint exposed to the internet, which is awkward for home servers. — [Sure discussion #93](https://github.com/we-promise/sure/discussions/93)

### Inferences
- Whichever aggregator Manilla picks, Canadian connections will break periodically. The app should show connection status and staleness ("last successful sync N days ago") and treat a re-auth as normal, since SimpleFIN itself doesn't notify on failures.

### Gaps
- No open-source Flinks integration found. No current (2026) status found for Canada's consumer-driven banking framework and when the Big Six move to OAuth. Another researcher may be covering that.
