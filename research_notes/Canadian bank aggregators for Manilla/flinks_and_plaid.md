# Flinks and Plaid as Canadian bank-data aggregators for Manilla (as of October 2026)

Research date: 2026-10-04. Primary sources are official docs (plaid.com/docs, docs.flinks.com) fetched on that date. Plus a live query of Flinks' public demo institution-search API (the same one used by the docs page's search widget). Anything older or unverified is flagged with a date.

## 1. Canadian institution coverage and connection method (API/OAuth vs. screen scraping)

### Takeaway
Both cover every institution on the list (big six, Desjardins, Tangerine, Simplii, EQ Bank, credit unions, Amex, Rogers Bank, PC Financial). In practice nearly all Canadian personal-banking connections on both are still credential-based. Plaid's own OAuth guide says OAuth "is not currently used by financial institutions in Canada", and every Canadian institution on Flinks' demo instance reports `IsOauth: false`, including its owner National Bank. The announced bilateral API agreements are Plaid–RBC (2022), Plaid–TD (2023) and Plaid–Amex (US-focused). Flinks has its National Bank "Open Banking Environment" (2021), its Outbound/FDX product, and FirstOntario CU (live June 2026). Canadian connections are currently unreliable, especially on Plaid.

### Cited Findings
**Plaid**
- Plaid says it "supports over 10,000 institutions across the United States and Canada". Coverage per product can be checked with `/institutions/get` or the coverage explorer. The explorer table "is not updated in real time". — [Plaid Institutions coverage](https://plaid.com/docs/institutions/)
- US and Canadian customers get Production access to US and Canadian institutions by default. — [Plaid API – Institutions](https://plaid.com/docs/api/institutions/)
- The `oauth` field on an institution: "Indicates that the institution has an OAuth login flow. This will be `true` if OAuth is supported for any Items associated with the institution, even if the institution also supports non-OAuth connections." `/institutions/get` can filter on `oauth: true` by country. — [Plaid API – Institutions](https://plaid.com/docs/api/institutions/); [Plaid OAuth guide](https://plaid.com/docs/link/oauth/)
- "OAuth connections are used universally by financial institutions in the UK and EU, are used by a number of financial institutions, especially larger ones, in the United States, and are not currently used by financial institutions in Canada." — [Plaid OAuth guide](https://plaid.com/docs/link/oauth/) (fetched 2026-10-04)
- **RBC–Plaid data access agreement (June 14, 2022).** It gives "secure, API-based financial access for more than 14 million RBC digital clients". Plaid was to replace screen scraping of RBC with an API and stop storing passwords once the shift was done. Plaid opened a Toronto office at the same time. — [Plaid blog, June 14 2022](https://plaid.com/blog/plaid-expands-presence-in-canada/); [American Banker](https://www.americanbanker.com/news/plaid-royal-bank-of-canada-reach-data-sharing-agreement); [PR Newswire](https://www.prnewswire.com/news-releases/rbc-and-plaid-announce-agreement-to-bolster-client-security-and-increase-connection-to-financial-services-apps-301567535.html)
- **TD–Plaid North American data-access agreement (Dec 14, 2023).** Covers TD customers in Canada and the US. It uses APIs instead of credential sharing, and the announcement gave no implementation date. TD is an FDX member and has a seat on the FDX board. — [PR Newswire, Dec 14 2023](https://www.prnewswire.com/news-releases/td-bank-group-and-plaid-enter-into-north-american-data-access-agreement-302015904.html)
- **American Express–Plaid data-sharing agreement.** I did not confirm the date. The coverage is US-focused, and I found nothing saying it covers Amex Bank of Canada cards. — [Bloomberg Law](https://news.bloomberglaw.com/banking-law/american-express-plaid-reach-consumer-data-sharing-agreement)
- Plaid added coverage for Scotiabank, BMO, CIBC, Desjardins and National Bank. I found no announced *data-access agreements* with them; the search turned up only coverage announcements (older Plaid/BetaKit posts). — [BetaKit](https://betakit.com/silicon-valley-fintech-plaid-expands-coverage-in-canada/); [Plaid blog – Canadian coverage](https://plaid.com/blog/canadian-coverage-and-country-filter/)
- Plaid says 75% of its connections overall (not Canada-specific) go through APIs. — [Plaid blog – API progress update](https://plaid.com/blog/api-progress-update/)
- **Current Canadian reliability (Lunch Money's institution-issues page, which tracks Plaid known issues, Jul–Sep 2026):**
  - The page says "Canadian bank connections are particularly prone to bank syncing issues today, as many of Canada's major banks… are still operating on older authentication methods while awaiting final open banking and OAuth regulatory guidance."
  - BMO (Sep 2 2026): after BMO moved to a new authentication system, logins work but "data updates are currently failing for a broad set of BMO connections". No ETA.
  - CIBC KI123004 (Aug 9 2026): MFA is invalidated shortly after the Item is created, so background updates fail.
  - Tangerine KI122553 (Sep 5 2026): the same MFA-invalidation problem.
  - RBC (Sep 10 2026): "frequent relinking required".
  - PC Financial KI407194 (Jul 15 2026): high impact, waiting on the institution.
  - Coast Capital KI537252 (Sep 10 2026): moving to a new integration.
  - Canadian Tire Bank (Aug 28 2026): no longer supported and needs a rebuild.
  - Wealthsimple KI787097 (Aug 28 2026): broken.

  — [Lunch Money KB – Institution-specific issues](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)

**Flinks**
- Flinks lists supported institutions in Canada and the US. Investment ("wealth") institutions such as Questrade and Wealthsimple are Canada-only. — [Flinks – Supported Financial Institutions](https://docs.flinks.com/guides/connect/supported-institutions)
- **Live query, 2026-10-04,** of Flinks' public demo search (`demo-api.private.fin.ag/v4/…/BankingServices/searchInstitutions`, the endpoint behind the docs page's search widget). Each institution record has an `IsOauth` field, and **every** Canadian personal-banking institution returned `IsOauth: false`. All showed a username/password `Form`. The ones checked were RBC (Id 3), TD (4), BMO (1), Scotiabank (6), CIBC (5), National Bank (7), Desjardins (2), Tangerine (8), Simplii (17), EQ Bank (18), American Express (212), Rogers Bank (80017956), PC Financial (77), Vancity (15), Servus (23), Meridian (11), Coast Capital (13), ATB, Alterna, Affinity, Conexus, Steinbach, Motusbank, Laurentian, Manulife Bank, Neo, KOHO, Capital One, MBNA and Wealthsimple. Brim and Triangle (Canadian Tire) returned no results. — [Flinks supported-institutions page / demo API](https://docs.flinks.com/guides/connect/supported-institutions). *Caveat: this is the demo instance. A production customer's instance may route some institutions differently; I could not verify that.*
- Flinks' nightly-refresh guide says: "Most Canadian institutions now apply MFA on every login, so a significant share of connections will not refresh on their own. OAuth-connected institutions are the exception and refresh reliably." — [Flinks – Nightly Refreshes](https://docs.flinks.com/guides/connect/nightly-refresh)
- **Flinks + National Bank "Open Banking Environment" (BetaKit, Nov 24 2021).** Users authenticate directly with the bank, and the app then gets a token for API access "without the need for screen-scraping". National Bank holds 80% preferred-share equity in Flinks after a C$103M investment (Aug 2021). Flinks and NBC set interim accreditation criteria. — [BetaKit, Nov 2021](https://betakit.com/tired-of-waiting-flinks-launches-its-own-open-banking-environment-with-national-bank/)
- Flinks "Outbound" is a bank-side product ("Launch your Open Banking API"). It exposes FDX-v5 endpoints (`/api/fdx/5/accounts/{accountId}/transactions`) and OAuth authorize/token/revoke between Data Providers and Data Recipients. — [Flinks docs index](https://docs.flinks.com/llms.txt); [Flinks – Testing Environments (FDX end-to-end)](https://docs.flinks.com/guides/getting-started/testing-environments)
- **FirstOntario Credit Union** went live with Open Banking on FIS Everlink and Flinks on June 9, 2026. — [Finextra](https://www.finextra.com/pressarticle/110098/firstontario-credit-union-activates-open-banking-with-fis-everlink-payment-services-and-flinks); [FirstOntario PDF](https://www.firstontario.com/wp-content/uploads/2026/06/media_consumerdrivenbankinglaunch2026.pdf)
- EQ Bank has partnered with Flinks since 2022 and integrated its data-sharing technology. — [Retail Banker International, Oct 6 2025](https://www.retailbankerinternational.com/features/canada-prepares-for-open-banking/)

### Inferences
- Plaid's institution `oauth` flag is the documented per-institution signal. For Canada it is currently expected to be `false` everywhere, so it cannot tell RBC/TD "API" connections apart from scraped ones. Flinks has an equivalent `IsOauth` on `/Institutions` / `searchInstitutions`.
- Neither vendor offers a dependable, API-based feed across the big six for a household today. Expect frequent relinks and MFA prompts, especially for Tangerine, CIBC, BMO and RBC on Plaid.

### Gaps
- I could not find out how Plaid's RBC and TD agreements show up technically in Canada in 2026. Plaid's docs say no Canadian OAuth, yet the agreements describe API access. They may be API-backed with credential capture in Link, or still in transition. I found no 2024–2026 status update.
- I found no announced Plaid agreements with BMO, Scotiabank, CIBC, National Bank, Desjardins, Tangerine, Simplii, EQ, Rogers or PC Financial, and no Flinks bilateral agreements beyond NBC, EQ Bank and FirstOntario CU.
- Whether Plaid's Amex agreement covers Amex Canada is unverified.
- I did not query Plaid's `/institutions/get` for CA because I had no API keys. The per-institution `oauth` values and product support (Transactions, pending) for Canadian banks are unverified.

## 2. Credential handling and the stored token

### Takeaway
Both use a hosted widget (Plaid Link, Flinks Connect iframe), so the app never sees bank credentials. Plaid gives a permanent `access_token` per Item, revoked with `/item/remove`. Flinks gives a permanent `loginId`, under which Flinks itself stores the user's bank credentials indefinitely, until `/DeleteCard`.

### Cited Findings
- Plaid Link passes the app a `public_token`, which expires after 30 minutes. The app exchanges it for an `access_token`: "An `access_token` does not expire, but can be revoked by calling /item/remove." By default it "should be stored in a persistent, secure manner." — [Plaid API – Items](https://plaid.com/docs/api/items/)
- For subscription products such as Transactions, "calling /item/remove is required to end subscription billing". — [Plaid API – Items](https://plaid.com/docs/api/items/)
- Plaid re-authentication uses Link "update mode", triggered by an `ITEM_LOGIN_REQUIRED` error or a `PENDING_DISCONNECT` webhook (US/CA, sent 7 days before a scheduled disconnection). For OTP-expired Items, Link may ask only for a new OTP. — [Plaid Link – Update mode](https://plaid.com/docs/link/update-mode/); [Plaid API – Items](https://plaid.com/docs/api/items/)
- Flinks `loginId`: "a **permanent token** issued when a customer successfully authenticates through Flinks Connect". It "does not expire until you call /DeleteCard" and "remains the same even if the customer's banking password changes". "The `loginId` stores the customer's credentials, KYC data, and linked accounts. Flinks retains this data indefinitely unless you explicitly delete it." — [Flinks – Key Concepts](https://docs.flinks.com/guides/getting-started/key-concepts)
- Each data pull in Flinks needs a short-lived `requestId` from `/Authorize` with the `loginId`. It lasts 8 minutes of inactivity during authorization or 30 minutes during processing, and is consumed by `/GetAccountsDetail`. — [Flinks – Key Concepts](https://docs.flinks.com/guides/getting-started/key-concepts)
- Revoking in Flinks is `DELETE /v3/{customerId}/BankingServices/DeleteCard/{loginId}`, which "permanently removes all stored credentials, KYC information, and account data". It returns `CARD_IN_USE` if a session is active. — [Flinks – /DeleteCard](https://docs.flinks.com/api/connect/endpoints/account-linking/delete-card)
- A Flinks instance serves one country. Production uses a private instance (`{yourcompany}-api.private.fin.ag`) with a customer GUID and whitelisted redirect URLs. — [Flinks – Testing Environments](https://docs.flinks.com/guides/getting-started/testing-environments)

### Inferences
- For Manilla, either token is a long-lived secret equivalent to read access to a household's bank. It belongs in `.env`/`data/private`-style storage, never in the repo.
- Flinks explicitly holds credentials server-side. Plaid also must for non-OAuth Canadian connections to refresh in the background, but its docs say so less explicitly.

### Gaps
- I found no Plaid statement on how it stores Canadian credentials for non-OAuth Items in 2026.

## 3. Data model for deduplication

### Takeaway
Plaid has a mature sync model: `/transactions/sync` with cursors and added/modified/removed lists, pending transactions, and `pending_transaction_id` linking posted to pending. It uses `YYYY-MM-DD` `date`/`authorized_date`, and a positive amount means money out. Flinks returns **posted transactions only**: a full snapshot per pull (90 or 365 days) with a GUID `Id`, a `Date`, separate `Debit`/`Credit` numbers and a running `Balance`. There are no cursors or deltas, so Manilla must diff snapshots itself. Both return amounts as JSON decimals (`double`), so cents must be parsed from the string form, never via float arithmetic.

### Cited Findings
**Plaid**
- `/transactions/sync`: the first call has no cursor. Store `next_cursor` and loop while `has_more`. `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` means restart from the saved cursor. — [Plaid Transactions overview](https://plaid.com/docs/transactions/)
- Pending to posted: "A transaction begins its life as a pending transaction, then becomes posted once the funds have actually been transferred." This typically takes 1–5 business days and "up to fourteen days in rare situations". In `/transactions/sync` the pending ID shows up in `removed` and the posted one in `added`. These are "not guaranteed to be in the same page, but should happen within the same overall update". The posted transaction carries `pending_transaction_id`. — [Plaid – Transaction states](https://plaid.com/docs/transactions/transactions-data/)
- Some institutions (Capital One, USAA) don't give pending data, so `pending_transaction_id` is `null`. Capital One gives only 90 days of history. — [Plaid – Transaction states](https://plaid.com/docs/transactions/transactions-data/); [Plaid – Transactions troubleshooting](https://plaid.com/docs/transactions/troubleshooting/)
- `transaction_id`: "The unique ID of the transaction… case sensitive." Pending and posted versions have different IDs. — [Plaid API – Transactions](https://plaid.com/docs/api/products/transactions/)
- `date`: "For pending transactions, the date that the transaction occurred; for posted transactions, the date that the transaction posted… (`YYYY-MM-DD`)". `authorized_date` is when the transaction was authorized, and is "generally preferable" for display. `datetime` and `authorized_datetime` are ISO-8601 timestamps. — [Plaid API – Transactions](https://plaid.com/docs/api/products/transactions/)
- `amount`: "Positive values when money moves out of the account; negative values when money moves in. For example, debit card purchases are positive; credit card payments, direct deposits, and refunds are negative." Format is `double`. — [Plaid API – Transactions](https://plaid.com/docs/api/products/transactions/)
- Balances:
  - `available` for depository accounts ≈ current − pending outflows + pending inflows, excluding overdraft.
  - For credit accounts, `available` ≈ limit − current.
  - `available` may be `null`.
  - Values are cached unless `/accounts/balance/get` is called.

  — [Plaid API – Transactions (account balances)](https://plaid.com/docs/api/products/transactions/)
- History: `days_requested` defaults to 90 and maxes at 730. History then grows as Plaid keeps new transactions. — [Plaid Transactions overview](https://plaid.com/docs/transactions/)
- Duplicates are sometimes real (for example, a double charge). Otherwise you file a ticket with the `transaction_id`s. — [Plaid – Transactions troubleshooting](https://plaid.com/docs/transactions/troubleshooting/)

**Flinks**
- "The Flinks API returns **posted transactions only**… Pending transactions… are not included in the API response. However, the **Available Balance** on an account may reflect pending transactions." — [Flinks – Key Concepts](https://docs.flinks.com/guides/getting-started/key-concepts)
- `/GetAccountsDetail` takes `DaysOfTransactions` set to `Days90` (default) or `Days365`. Each transaction has these fields:
  - `Id` (string GUID)
  - `Date` (e.g. `'2025-01-31'`)
  - `Description`
  - `Debit` and `Credit` (separate numbers)
  - `Balance` (running balance)
  - `Code`

  Accounts carry a `Balance` object (with `Available`, `Current`, …), `Currency`, `Category` and `AccountType`. A `202` response means poll `/GetAccountsDetailAsync` every 10 s, for up to 30 min. — [Flinks – /GetAccountsDetail](https://docs.flinks.com/api/connect/endpoints/account-linking/get-accounts-detail)
- Cached mode (`/Authorize` with `MostRecentCached: true`) returns the most recently processed data without a live bank connection. — [Flinks – Key Concepts](https://docs.flinks.com/guides/getting-started/key-concepts)

### Inferences
- Plaid's `removed`+`added`+`pending_transaction_id` maps well onto Manilla's "suggestions stored apart from confirmed lines". A pending line can be held as provisional and replaced by its posted successor.
- With Flinks, Manilla would never see pending transactions. Each pull is a window, not a delta, so dedup must key on Flinks `Id`, if stable, or on (date, amount, description, running balance).
- Plaid `date` is already a calendar date string, which fits the "dates are `YYYY-MM-DD` strings" rule. Do not derive dates from `datetime`. Flinks `Date` also appears to be `YYYY-MM-DD`.
- Both send amounts as JSON numbers. A plain `JSON.parse` yields a float, so to obey "integer cents, never a float", take amounts from the raw text (e.g. a reviver or a JSON parser that keeps number text) and run them through `parseAmount`. Plaid's sign is opposite to the usual "inflow positive", so flip it consistently.

### Gaps
- Flinks does not document whether a transaction `Id` stays the same across refreshes/re-pulls of the same posted transaction. This is essential for dedup and is unverified.
- Plaid's guarantee that a posted `transaction_id` never changes is not stated beyond "unique ID". Its behaviour in Canada, and whether major Canadian banks give pending data via Plaid, is unverified.

## 4. Refresh: automatic, on-demand, webhooks, MFA re-auth in Canada

### Takeaway
Plaid checks for transactions 1–4 times a day per Item. It fires `SYNC_UPDATES_AVAILABLE` webhooks and offers an on-demand `/transactions/refresh`, which is included in the Trial plan. Flinks offers an opt-in Nightly Refresh, run 04:00–08:00 UTC. Flinks itself warns that most Canadian institutions now demand MFA on every login, so unattended refresh often fails and a user-present "Refresh" button is the guaranteed path. Field reports from 2026 show Plaid has the same Canadian MFA problem.

### Cited Findings
- Plaid: "The frequency of transactions update checks is typically between one and four times per day, depending on the institution." `/transactions/refresh` is an add-on for on-demand updates. — [Plaid Transactions overview](https://plaid.com/docs/transactions/)
- Plaid webhooks: `SYNC_UPDATES_AVAILABLE` fires on any change after the first sync call, with `initial_update_complete` (≥30 days available) and `historical_update_complete` (up to 24 months). Plaid recommends a refresh button backed by `/transactions/refresh`. — [Plaid – Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- Plaid fires `PENDING_DISCONNECT` 7 days before a scheduled disconnection; "currently, this webhook is fired only for US or Canadian institutions". — [Plaid API – Items](https://plaid.com/docs/api/items/)
- Plaid Canadian MFA problems (2026): Tangerine KI122553 and CIBC KI123004 have "MFA… invalidated shortly after… initial Item creation, causing background data updates to fail". RBC needs frequent relinking. — [Lunch Money KB](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)
- Flinks: "A nightly refresh runs without the end user present… When the institution requires a one-time password, a push notification approval, or another challenge that only the end user can answer, the refresh cannot be completed. Most Canadian institutions now apply MFA on every login, so a significant share of connections will not refresh on their own." Flinks advises: "Plan for partial coverage", "Check the age of the data", and implement a "Refresh" button. — [Flinks – Nightly Refreshes](https://docs.flinks.com/guides/connect/nightly-refresh)
- Flinks Nightly Refresh needs:
  - `scheduleRefresh=true` in the iframe, or a `/SetScheduledRefresh` call.
  - A successful refresh in the last 7 days.
  - For non-webhook integrations, a cached call in the past 7 days.

  It runs 04:00–08:00 UTC. "Enhanced MFA" (auto-answering security questions) is deprecated because Canadian banks moved to OTP/push. — [Flinks – Nightly Refreshes](https://docs.flinks.com/guides/connect/nightly-refresh)
- Flinks on-demand refresh: call `/Authorize` with `MostRecentCached:false`, `Save:true`, `directRefresh:true`. A `203` means MFA is required, so relaunch Flinks Connect with the `requestId` and a fresh `authorizeToken`, which is valid for 15 minutes. — [Flinks – Reconnect](https://docs.flinks.com/guides/connect/resume-and-reconnect)
- Flinks has webhooks with HMAC-SHA256 signatures. — [Flinks docs index](https://docs.flinks.com/llms.txt)

### Inferences
- For a self-hosted app, webhooks need a publicly reachable HTTPS endpoint. Both vendors also support polling: Plaid by calling `/transactions/sync` on a schedule, Flinks with cached `/Authorize` plus `/GetAccountsDetail`. Polling suits a home server better.
- Canadian MFA cadence is effectively "frequently, institution-dependent". Manilla should show data age per account, which matches AGENTS.md: "what has not been reviewed says so on screen".

### Gaps
- I found no quantified MFA re-auth frequency (e.g. days between relinks) per Canadian bank for either vendor.
- Flinks institution-level Nightly Refresh coverage is available only "from your Flinks Representative".

## 5. Access and pricing for individuals and small developers

### Takeaway
Plaid is now realistic for one household. Since Apr 15 2026, new US/Canada teams can get a **free Trial plan with 10 lifetime Production Items**, including Transactions, Transactions Refresh, Balance and Investments. Plaid labels Trial and Pay-as-you-go "most appropriate for hobbyist use", and both are self-serve. Flinks is not realistic. Its public pricing is **C$500/month minimum (Connect Starter, 200 unique connections) on a 1-year term**, with no self-serve trial and no pay-as-you-go. Only the shared Toolbox sandbox is free.

### Cited Findings
**Plaid**
- Plans: "**Trial** – Free access. Limited to 10 Items… Most appropriate for hobbyist use, or for evaluating and learning more about Plaid." "**Pay-as-you-go** – No minimum spend or commitment. Most appropriate for hobbyist use, or for early-stage small businesses." Growth has a minimum spend and annual commitment, for up to $6,000/month of usage. Custom/Scale has higher minimums. — [Plaid – Pricing and billing](https://plaid.com/docs/account/billing/)
- "Free Trial plans are available to new Plaid teams (US/Canada only) created on or after April 15, 2026." You sign up via the Dashboard, verify email and apply at dashboard.plaid.com/trial-plan. — [Plaid – Pricing and billing](https://plaid.com/docs/account/billing/)
- "You can create 10 Production Items on a Trial plan… Removing Items created on a Trial plan (using /item/remove) will _not_ allow you to create more Items." Trial products are Auth, Transactions (incl. Refresh), Balance, Identity, Assets, Liabilities, Investments (incl. Refresh) and Statements. When upgrading, subscription products on existing Items start billing. — [Plaid – Pricing and billing](https://plaid.com/docs/account/billing/); [Plaid support – Trial plan (search snippet)](https://support.plaid.com/hc/en-us/articles/39994173227159-What-is-the-Plaid-Trial-plan)
- "Limited Production has been replaced with Trial plans for all Plaid teams created on or after April 15, 2026… unlike Limited Production, [Trial plans] provide access to almost all institutions prior to full Production approval." — [Plaid – Sandbox overview](https://plaid.com/docs/sandbox/). *Conflict: plaid.com/pricing still says "Limited Production… up to 200 API calls with each available product using live data", which looks like stale marketing copy.* — [Plaid pricing page](https://plaid.com/pricing/)
- Pay-as-you-go per-Item prices are not published. "To view pricing, apply for Production access… Pricing information for Pay-as-you-go and Growth plans will be displayed on the last page before you submit your request." Transactions is billed as a monthly subscription per Item. — [Plaid – Pricing and billing](https://plaid.com/docs/account/billing/)
- The pricing page header reads "Pricing – United States & Canada". — [Plaid pricing page](https://plaid.com/pricing/)
- Production in the US/Canada needs a Link use-case description for accounts created after Oct 31 2024. The OAuth registration requirements list "Plaid Master Services Agreement (MSA) – (US/CA only)" and "Plaid security questionnaire – (US/CA only)". — [Plaid – Sandbox](https://plaid.com/docs/sandbox/); [Plaid OAuth guide](https://plaid.com/docs/link/oauth/)
- The free Sandbox has test data, special endpoints (`/sandbox/item/fire_webhook`) and a Sandbox MCP server. It "does not reflect institution-specific… quirks". — [Plaid – Sandbox](https://plaid.com/docs/sandbox/)
- The billing doc mentions sole proprietorships in the context of Plaid Check eligibility. — [Plaid – Pricing and billing](https://plaid.com/docs/account/billing/)

**Flinks**
- Connect: Starter "$500/month" with "200 monthly unique connections". Scale "$1,250/month" with 1,100. Enterprise is custom, from 20,000. "Our standard contracts include a monthly minimum commitment and a 1-year term." On a trial: "We don't offer a self-serve free trial, but you can register for free access to our sandbox environment." On pay-as-you-go: "No." — [Flinks Pricing](https://www.flinks.com/pricing)
- The Toolbox API sandbox uses shared public credentials, published in the docs, against a dummy bank "Flinks Capital". Test users are `Greatday`/`Everyday` with MFA, and `greatday_nomfa` without. Production needs "Unique credentials from Flinks" given during onboarding. — [Flinks – Testing Environments](https://docs.flinks.com/guides/getting-started/testing-environments)

### Inferences
- A household with ≤10 bank logins (each Item is one institution login and can hold several accounts) fits Plaid Trial for free. Each Item creation counts for good, so re-linking via **update mode** (which keeps the Item) matters, and delete-and-re-add burns the allowance. Each self-hoster would sign up for their own Plaid team and get their own 10.
- Flinks' C$6,000/year minimum rules it out for Manilla unless a sales exception exists.

### Gaps
- Plaid support articles on eligibility returned 403, so I could not confirm whether an individual with no company can pass Trial or Pay-as-you-go onboarding, or what the Production form asks for (legal entity, website, privacy policy).
- Pay-as-you-go per-Item Transactions pricing for Canada is unverified because it is shown only in the Dashboard.
- I did not read Plaid's Developer Policy / MSA or Flinks' terms. Clauses on personal use, self-hosting, or letting third parties run an app with your keys are unverified.

## 6. Position on Canada's consumer-driven banking (CDB) framework

### Takeaway
The Consumer-Driven Banking Act received Royal Assent on Mar 26 2026. Draft regulations were published Jun 27 2026, with comments closing Aug 26 and final regulations targeted for late 2026/early 2027. The Bank of Canada accredits participants. Flinks says it will seek accreditation as an Accredited Third-Party Service Provider (ATPSP). Plaid publicly backs a tiered accreditation model and Bank of Canada governance, but I found no explicit Plaid statement that it will apply. The screen-scraping ban's timing is unsettled.

### Cited Findings
- The Act received Royal Assent on Mar 26 2026. Proposed regulations appeared in Canada Gazette I on Jun 27 2026, with a 60-day comment period to Aug 26 2026. — [DLA Piper](https://www.dlapiper.com/en-pl/insights/publications/2026/04/the-new-consumer-driven-banking-act-explained); [Canada Gazette I, Jun 27 2026](https://gazette.gc.ca/rp-pr/p1/2026/2026-06-27/html/reg3-eng.html); [Blakes](https://www.blakes.com/insights/proposed-consumer-driven-banking-regulations-released-for-comment/)
- Data sharing will be phased by product complexity: deposit/payment accounts first, then lending, then registered and non-registered investments. The Bank of Canada accredits participants and ATPSPs and keeps a public registry. — [Open Banking Expo](https://www.openbankingexpo.com/news/canadas-proposed-consumer-driven-banking-regulations-what-do-we-know/); [Bank of Canada CDB advisory committee notes, Jul 21 2026](https://www.bankofcanada.ca/wp-content/uploads/2026/08/CDB-AD-COM-2026-summary-July-21-2026.pdf)
- Flinks (blog, Jul 20 2026) says it will pursue ATPSP accreditation. It says it has "acted as an access and accreditation partner, vetting fintechs seeking API connections for banks". It backs "One technical standard, one designated technical standards body". Its blog describes Phase 1 (read access to deposit/payment accounts) as 2026 and Phase 2 (write) as mid-2027, and says scraping prohibition timing is unclear. — [Flinks blog](https://www.flinks.com/blog/open-banking-canada-2026-launch-fintech-institutions). *Conflict: other sources put final regulations in late 2026/early 2027, so a 2026 data-sharing go-live looks optimistic.*
- Plaid (spokesperson Freya Petersen, Oct 6 2025) advocates "a tiered accreditation model that considers a participant's size, use case, and risk profile, rather than a 'one-size-fits-all' approach that would create significant barriers for smaller fintechs". Plaid wants the Bank of Canada, not FCAC, as primary governor. — [Retail Banker International, Oct 6 2025](https://www.retailbankerinternational.com/features/canada-prepares-for-open-banking/)
- FDX: TD is an FDX member and board co-chair, which comes up in the context of the Plaid agreement. Flinks Outbound implements FDX v5 endpoints. — [PR Newswire (TD–Plaid)](https://www.prnewswire.com/news-releases/td-bank-group-and-plaid-enter-into-north-american-data-access-agreement-302015904.html); [Flinks docs index](https://docs.flinks.com/llms.txt)
- Lunch Money attributes Canadian sync problems to banks "awaiting final open banking and OAuth regulatory guidance". — [Lunch Money KB](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)

### Inferences
- Once CDB data sharing is live, accredited aggregators should get bank APIs for deposit accounts first. That should fix the MFA/refresh problem for chequing and savings before credit cards and investments. Individuals will almost certainly reach it only through an accredited intermediary such as Plaid or Flinks, not directly.

### Gaps
- I found no Plaid statement explicitly committing to apply for accreditation, and no confirmation of Plaid's FDX membership for Canada.
- Whether the final framework will let unaccredited "personal use" apps consume data via an accredited provider is unclear.

## 7. Self-hosted / open-source projects using Plaid or Flinks in Canada

### Takeaway
I found no self-hosted or open-source budgeting project with a documented working Flinks integration. Among the well-known self-hosted apps, Maybe Finance used Plaid. Actual Budget uses SimpleFIN in North America, and Firefly III users in Canada often fall back to PDF/CSV import. Hosted budgeting apps on Plaid (Lunch Money) report chronic Canadian breakage in 2026 and point users to MX/Finicity-based alternatives.

### Cited Findings
- Actual Budget's North American bank sync is SimpleFIN ($15/year). Firefly III is recommended for Canada partly for PDF-statement parsing, because "most Canadian banks struggle to properly export CSV with all transactions". The original Maybe app "used many external services including Plaid" and needs work to run self-hosted. — [beancount.io comparison, Jul 2026](https://beancount.io/blog/2026/07/26/firefly-iii-vs-actual-budget-self-hosted-open-source-budgeting-guide); [selfhostable.dev](https://selfhostable.dev/blog/firefly-iii-vs-actual-budget-self-hosted-finance/); [AlternativeTo](https://alternativeto.net/software/firefly-iii/?platform=self-hosted) (aggregated summaries; secondary sources)
- `mbafford/plaid-sync` is an open-source personal Plaid sync tool (US-oriented). — [GitHub](https://github.com/mbafford/plaid-sync)
- Lunch Money, a hosted app on Plaid, lists Canadian failures (BMO, CIBC, Tangerine, RBC, PC Financial, Coast Capital, Canadian Tire, Wealthsimple). It recommends "Lunch Flow" (MX/Finicity) or CSV/PDF import as alternatives. — [Lunch Money KB](https://support.lunchmoney.app/guides/automatic-imports/institution-specific-issues)

### Inferences
- If Manilla adds Plaid, it should be an optional, per-install integration where each self-hoster brings their own Trial keys. CSV/OFX/PDF import should remain the primary, always-works path for Canadian institutions.

### Gaps
- I found no r/PersonalFinanceCanada, r/selfhosted or r/ynab threads with specific 2026 first-hand Plaid or Flinks self-hosting experience in Canada; search returned none.
- I found no Canadian user reports of the new Plaid Trial plan.
