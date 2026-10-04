# Bank-data aggregators other than Flinks and Plaid for a small self-hosted Canadian budgeting app (as of October 2026)

Scope: MX, Mastercard Open Banking (Finicity), Yodlee, Salt Edge, Inverite, Wealthica, Akoya, Zūm Rails, VoPay, Interac, plus Questrade's own API and SnapTrade, which turned up for the investments phase. ValidiFI was not researched; see Gaps. Research date is 2026-10-04. Where the only source is older, its date is given.

A useful secondary source turned up: a research document in the open-source budgeting project Budgie, dated **2026-09-30**. It quotes each aggregator's own API docs and OpenAPI specs verbatim. Below it is cited as "[Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)", with the primary URL it quotes noted where useful. Its quotes look accurate, but I did not re-fetch every primary page.

## 1. Which Canadian institutions does each one actually reach, and how (API agreement or screen scraping)?

### Takeaway
Only MX and Yodlee have verified, sizeable Canadian bank coverage outside Flinks and Plaid, and each has one Big Six API agreement (MX with CIBC, Yodlee with RBC). Neither publishes a per-bank Canadian list. Finicity/Mastercard's current public API is effectively US-only. Salt Edge's Canadian coverage is negligible, and Akoya is US-only. Inverite, Zūm Rails and VoPay are Canadian but built for lenders and payments. Interac offers no aggregation API. Until consumer-driven banking (CDB) is live, almost all Canadian connections are credential-based.

### Cited Findings
**Market-wide context**
- Plaid's docs say "OAuth connections are not currently used by financial institutions in Canada." Budgie's conclusion as of 2026-09-30: "Today every aggregator reaches Canadian banks by credentials" — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45), quoting [Plaid OAuth guide](https://plaid.com/docs/link/oauth/)
- Proposed Consumer-Driven Banking Regulations were pre-published 2026-06-26. They phase in "beginning with accreditation, followed by requirements related to common rules and assessment fees within one year of final publication." About nine million Canadians still share data by screen scraping — [Dept. of Finance news release, 2026-06](https://www.canada.ca/en/department-finance/news/2026/06/government-pre-publishes-regulations-to-prevent-fraud-and-facilitate-the-next-phase-of-consumer-driven-banking.html) (via Budgie)
- "The prohibition of screen scraping will come into force once the framework is fully operational" — [Budget 2025 CDB framework](https://www.canada.ca/en/department-finance/programs/financial-sector-policy/open-banking-implementation/budget-2025-canadas-framework-for-consumer-driven-banking.html) (via Budgie)
- Phase 1 is read access, phased in by account type: deposit and payment first, then lending, then registered and non-registered investment accounts. The comment period ran to 2026-08-26 — [Flinks blog on draft regs](https://www.flinks.com/blog/open-banking-canada-2026-launch-fintech-institutions) (search snippet; Flinks is an interested party)

**MX**
- MX claims "the most comprehensive coverage for demand deposit accounts across U.S. and Canada" but publishes no per-bank list — [MX Account Aggregation](https://www.mx.com/products/account-aggregation/) via [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)
- Big Six agreement: on 2022-08-08 CIBC signed a data access agreement with MX for API (non-credential) sharing for its ~11M clients. It was "the first in Canada for MX" — [MX press release](https://www.mx.com/news/cibc-to-enhance-secure-and-seamless-access-to-financial-tools-and-apps-for-clients-through-agreement-with-mx/); [Betakit](https://betakit.com/cibc-latest-big-six-bank-to-partner-with-a-fintech-on-private-open-banking-api/); [FinTech Futures](https://www.fintechfutures.com/2022/08/cibc-partners-mx-for-fintech-customer-data-access-agreement/)
- Other Canadian ties: a PFM partnership with Celero, which serves Canadian credit unions ([MX news](https://www.mx.com/news/celero-partners-for-personal-financial-management-tools/)); a Zūm Rails partnership using MX "Processor Tokens" for Canadian payments ([Open Banking Expo](https://www.openbankingexpo.com/news/zum-rails-partners-with-mx-to-enable-open-banking-capabilities-in-canada/), date not checked); sponsoring Open Banking Expo Canada 2026 ([MX events](https://www.mx.com/events/open-banking-expo-dinner-2026/))
- MX's own Budget 2025 blog post (2025-11-07) says nothing specific about its Canadian coverage, agreements or accreditation — [MX blog](https://www.mx.com/blog/canada-budget-2025/)

**Mastercard Open Banking / Finicity**
- TD signed a "North American" data access agreement with Finicity in 2020 (old) — [Mastercard/Finicity](https://www.finicity.com/in-the-news/td-creates-data-access-agreement-with-finicity/)
- Sources conflict on whether Canada is covered today. Fintable lists Finicity as covering the US, Canada, UK and Puerto Rico ([Fintable](https://fintable.io/coverage/providers/FINICITY)). Open Banking Tracker says Mastercard Open Banking "does not list Canada" among its markets (US, Australia, Brazil, Europe) ([Open Banking Tracker](https://www.openbankingtracker.com/embedded-finance/finicity-mastercard-open-banking), search snippet). Budgie checked the published OpenAPI spec: "Every one of the 142 region-tagged endpoints in the published US spec is marked US-only… I found no Canadian Open Finance API on developer.mastercard.com. Treat Finicity as not an option for Canadian banks" ([Budgie research](https://github.com/RobertG-H/budgie-src/pull/45), citing [Mastercard/open-banking-us-openapi](https://github.com/Mastercard/open-banking-us-openapi))
- The developer docs path is literally `developer.mastercard.com/open-finance-us/` — [Mastercard API reference](https://developer.mastercard.com/open-finance-us/documentation/api-reference/)

**Yodlee** (Envestnet sold it to private equity firm STG; the deal was expected to close in Q3 2025)
- Sale to STG — [PYMNTS](https://www.pymnts.com/acquisitions/2025/envestnet-to-sell-open-finance-subsidiary-yodlee-to-stg/); [STG](https://stg.com/news/envestnet-inc-announces-definitive-agreement-to-sell-yodlee-inc-to-stg/)
- Big Six agreement: on 2022-06-14 RBC and Envestnet | Yodlee agreed a direct API to replace credential sharing for RBC's 14M+ clients — [Newswire](https://www.newswire.ca/news-releases/rbc-and-envestnet-data-and-analytics-announce-agreement-to-provide-clients-with-greater-control-over-their-financial-data-830484763.html)
- The developer FAQ advertises coverage in "the United States, the U.K., and Australia" with "17,000+ data sources" and does not mention Canada — [Yodlee FAQ](https://developer.yodlee.com/resources/yodlee/faqs/docs/building_testing). Budgie: "Its docs mention Canadian provider sites" — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)
- Wealthica, a competitor, markets itself as the Canadian-investment complement to Yodlee, which suggests Yodlee's Canadian investment coverage is thin — [Wealthica blog](https://wealthica.com/blog/yodlee-vs-wealthca/) (vendor marketing)

**Salt Edge**
- Says it covers 73 countries including Canada, but no per-bank Canadian list rendered on [Salt Edge's Canada coverage page](https://www.saltedge.com/products/account_information/coverage/ca) when fetched. A search-result summary, apparently from a comparison site, said the page "lists exactly two connections as of August 23, 2026: American Express and Royal Bank of Canada". I could not verify this directly.
- Salt Edge's Spectre API is described as screen scraping — search snippet, [beaver README](https://github.com/tornikenats/beaver/blob/master/README.md) (old and unverified)

**Akoya**
- A US network owned by Fidelity, The Clearing House and 11 US banks — [Open Conversations](https://www.open-conversations.org/handpicked-headlines-archive/fidelity-and-pnc-lead-akoyas-us-open-banking-land-grab-cfpbs-chopra-not-amused-statements-indicate-jason-mikula-long-read-will-us-banks-try-to-force-akoya-as-the-only-data-access-option-dow/); "Participants include leading U.S. banks, credit unions…" — [Akoya](https://akoya.com/financial-institutions)
- Akoya registered the "Akoya Data Access Network" trademark in Canada on 2023-05-17 — [CIPO](https://ised-isde.canada.ca/cipo/trademark-search/pdf/2140069?lang=eng)
- "TD Bank joins Akoya" refers to TD's **US** arm — [TD Stories (US)](https://stories.td.com/us/en/article/td-bank-joins-the-akoya-data-access-network-to-accelerate-open-finance)

**Inverite** (Canadian)
- Claims support for 280+ Canadian financial institutions, including banks and credit unions, for account, transit and institution numbers and transaction history — search snippets from [Feathery](https://www.feathery.io/integrations/inverite) and [inverite.ca](https://inverite.ca/bank-verify/). That page now redirects to [inveriteinsights.com](https://inveriteinsights.com/)
- Explicitly positioned for lenders: onboarding, loan decisioning, cash-flow underwriting, tenant screening — [Inverite Insights](https://inveriteinsights.com/)

**Zūm Rails** (Canadian, founded 2019)
- An aggregation API returning accounts (chequing, savings, credit card), transactions with categories, and holder PII. Pitched for KYC and risk assessment — [Zūm Rails docs](https://docs.zumrails.com/api-reference/aggregation); [zumrails.com](https://zumrails.com/aggregation)

**VoPay** (Canadian payments)
- iQ11 uses "Open Banking technology" to verify ownership and balance and to return transaction history for an iQ11 token. It is a payments/EFT product — [VoPay docs](https://docs.vopay.com/reference/iq11transactionsget); [VoPay iQ11 tokenize](https://docs.vopay.com/reference/iq11tokenizepost). VoPay lists Inverite as a partner — [VoPay](https://vopay.com/en-us/partners/inverite/)

**Interac**
- The Interac + credit unions + Caspian One partnership (2025-06-26, updated 2025-09-22) is **identity verification** using online-banking logins at First West, Prospera, Affinity, Libro, Meridian and UNI. It offers no account or transaction data API for third parties — [Interac](https://www.interac.ca/en/content/news/interac-canadian-credit-unions-and-caspian-one-open-data-partner-to-expand-secure-digital-verification-for-canadians/)
- Interac has reportedly run pilots with third-party providers on shared open-banking services (identity, consent, secure transfer) — [NCFA](https://ncfacanada.org/what-role-will-interac-play-in-open-banking-in-canada/) (search snippet; undated)

### Inferences
- For a budgeting app needing chequing, savings and credit cards at the Big Six, Desjardins, Tangerine, EQ and credit unions, the realistic non-Flinks, non-Plaid candidates are MX (directly or via SimpleFIN, see Q6) and Yodlee. Neither publishes a Canadian institution list, so Desjardins, Tangerine, EQ and credit-union coverage must be tested by hand.
- Inverite, Zūm Rails and VoPay sell one-shot or underwriting-style pulls to lenders and payment businesses. They are not designed for a consumer's ongoing daily sync and are a poor fit for Manilla.
- Finicity, Akoya and Salt Edge can be ruled out for Canadian bank data today.

### Gaps
- No aggregator other than Flinks and Plaid publishes a verifiable per-institution Canadian list. Desjardins, Tangerine, EQ Bank, credit-union and card-issuer (e.g. Amex Canada, Rogers, PC Financial) coverage for MX and Yodlee is unknown.
- Whether the CIBC–MX and RBC–Yodlee APIs are live and used for all customers in 2026, rather than just announced in 2022, was not confirmed.
- Whether any of these APIs reports per connection if it is API-based or credential-based was not found for MX, Yodlee or the Canadian lender tools.
- **ValidiFI was not researched.** It is believed to be US-focused, but this is unverified.

## 2. Credential handling and revocation

### Takeaway
Every relevant vendor uses a hosted widget so the app never sees bank credentials: MX Connect, the Yodlee FastLink-style flow, the Wealthica Connect Widget, the Inverite iframe and the VoPay embed URL. The aggregator then holds the credentials (or the token, where a bank API exists) and refreshes daily. In Canada that mostly means stored credentials, so connections break on password change or MFA.

### Cited Findings
- SimpleFIN Bridge: "We outsource to MX to securely store and access your financial institutions… No bank account credentials ever touch our servers" — [SimpleFIN security](https://beta-bridge.simplefin.org/info/security)
- MX offers a Connect widget for linking — [MX Connect docs](https://docs.mx.com/connect/)
- Wealthica's Connect Widget has users enter institution credentials. "Most supported institutions will ask for your credentials," while Wealthsimple, Questrade and IB "are API-based and won't ask for credentials." A Wealthica user token is needed before opening the widget — [Wealthica Connect a user](https://wealthica.com/docs/connecting-a-user/); [Wealthica Authentication](https://wealthica.com/docs/authentication/) (search snippets)
- VoPay iQ11: the user picks an institution in an embed URL, logs in and picks an account, producing an "iQ11 token" for later use — [VoPay docs](https://docs.vopay.com/reference/iq11tokenizepost)
- Inverite integrates via API, iFrame or its own platform — [Inverite API PDF](https://s3-ca-central-1.amazonaws.com/inverite-static-montreal/api-docs/Inverite+Verification+API+(Bank+Iframe).pdf) (title only, not read)
- Credential-based Canadian connections "break when the user changes their password" (Plaid's case, which applies equally to the others) — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)
- The RBC–Yodlee and CIBC–MX agreements replace credential sharing with direct APIs for those banks — [RBC/Yodlee release](https://www.newswire.ca/news-releases/rbc-and-envestnet-data-and-analytics-announce-agreement-to-provide-clients-with-greater-control-over-their-financial-data-830484763.html); [CIBC/MX release](https://www.mx.com/news/cibc-to-enhance-secure-and-seamless-access-to-financial-tools-and-apps-for-clients-through-agreement-with-mx/)

### Inferences
- For Manilla, the self-hosted server stores only an aggregator-issued member, user or connection ID and API keys, never bank passwords. The trust boundary is the aggregator, which holds the credentials.
- Revocation is per vendor: delete the member or user via the API, or the user removes the app in their bank's connected-apps page, where an API agreement exists (CIBC/MX, RBC/Yodlee).

### Gaps
- I did not find documented revocation and deletion semantics for MX, Yodlee or Wealthica in Canada, e.g. whether deleting a member purges stored credentials immediately.
- Per-connection visibility of API versus scraping (see Q1) was not found.

## 3. Data model: stable transaction IDs, pending versus posted, refresh and webhooks, history depth

### Takeaway
MX has the richest model of the candidates. It has an MX-defined `guid` per transaction, a `PENDING`/`POSTED` status, `created`/`updated`/`deleted` webhooks and `from_updated_at` filtering. But a pending transaction usually gets deleted and replaced with a new guid when it posts. Yodlee also mints new IDs on posting by default. Finicity and SimpleFIN return date windows with no delta feed. Wealthica syncs daily. Initial history is typically 90 days (MX) and up to 24 months (Plaid, for comparison).

### Cited Findings
- **MX transaction fields** (OpenAPI `v20250224.yml`): `guid` ("Defined by MX"), partner `id`, `account_guid`, `member_guid`, unsigned `amount` plus `type` `CREDIT`/`DEBIT`, `status` `POSTED`/`PENDING`, `date`, `transacted_at`, `posted_at`, `description`, `original_description`, `category`, `updated_at`. List endpoints take `from_updated_at`/`to_updated_at` — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45) quoting [mxenabled/openapi](https://github.com/mxenabled/openapi/blob/master/openapi/v20250224.yml)
- **MX pending handling** (spec quote): "Many institutions do not provide data for pending transactions; transactions from those accounts always have a status of POSTED… a single transaction may be updated from PENDING to POSTED and keep the same guid… If a single transaction can't be updated, the PENDING transaction will often be deleted and replaced with a new POSTED transaction (with a new guid)… this is the most common scenario… All PENDING transactions are deleted after 14 days as a failsafe" — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)
- **MX webhooks and history**: transaction webhooks have `action` `created`/`updated`/`deleted` ([MX webhooks](https://docs.mx.com/resources/webhooks/)). An aggregation webhook fires when new data is available. Aggregation retrieves "90 days of data" — [MX Account Aggregation docs](https://docs.mx.com/products/connectivity/account-aggregation) (search snippet)
- **Finicity**: integer `id` plus `uniqueTransactionId`. `status` is "active", "pending" or "shadow"; "shadow" means seen earlier but no longer at the institution. Amounts are signed (deposits positive). Retrieval is by `fromDate`–`toDate` window with `includePending` defaulting false, and there is no delta feed. Accounts refresh "once per day" and apps "are not permitted to automate calls to the Refresh services" — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45) quoting [Mastercard docs](https://developer.mastercard.com/open-finance-us/documentation/products/manage/transaction-data/understanding-transaction-data/)
- **Yodlee**: `id` (unique with the account container), `amount` plus `baseType` `CREDIT`/`DEBIT`, `status` `POSTED`/`PENDING`/`SCHEDULED`, `transactionDate`, `postDate`. "The current behavior of the platform creates unique transaction IDs whenever a transaction transitions from Pending to Posted" unless a reconciliation config key is enabled (May 2025 release notes) — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45) quoting [Yodlee release notes](https://developer.yodlee.com/resources/yodlee/may-2025-release-notes)
- **SimpleFIN** (MX underneath): a read-only `GET /accounts?start-date=&end-date=&pending=1`. Transaction `id` is never reused within an account. Amounts are signed, positive meaning deposit, and `posted`=0 when pending. There is no delta or removal mechanism. Daily updates, about 24 requests a day, and at most 90 days per request — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45) quoting [SimpleFIN protocol](https://www.simplefin.org/protocol.html)
- **Wealthica**: "Data syncs automatically daily, with manual sync available". Webhooks exist in the docs nav — [Wealthica Get Started](https://wealthica.com/docs/get-started/)
- **Zūm Rails**: transactions include date, description, debit and credit amounts, running balance and category, with async ("background transaction scraping") status polling — [Zūm Rails docs](https://docs.zumrails.com/api-reference/aggregation)

### Inferences
- Whichever aggregator is chosen, Manilla should key imported lines on `(account, external_id)` and treat pending lines as replaceable or disappearing, or simply import only posted lines. Neither MX nor Yodlee keeps a pending ID reliably. This fits Manilla's "automation proposes; a person confirms" model: posted-only import avoids confirmed lines whose source vanishes.
- MX's `updated_at` filter plus deleted webhooks is the closest thing to Plaid's `/transactions/sync` among these vendors.
- Amount sign conventions differ (MX/Yodlee unsigned plus type, Finicity/SimpleFIN signed). Normalise to integer cents at the import boundary, as AGENTS.md already requires.

### Gaps
- History depth for Canadian connections at MX beyond the 90-day default was not confirmed, nor for Yodlee or Wealthica.
- Whether MX's Canadian institutions supply pending data at all is unknown.

## 4. Access for individuals and small developers: sandbox, production without a company, minimums, pricing

### Takeaway
Of the vendors here, only these are self-serve at hobby scale: MX's free developer tier (100 users, but at "top institutions", and production through sales), SimpleFIN Bridge (US$15/yr, a consumer product built on MX), SnapTrade (brokerages, free for 5 accounts) and Questrade's personal API. Yodlee, Finicity, Wealthica, Inverite, Zūm Rails and VoPay are all sales-gated business products. Salt Edge has a free tier, but its Canadian coverage is negligible.

### Cited Findings
- **MX**: free accounts include the developer environment and dashboard, with aggregation of transactions, balances and account info for "up to 100 users at some of the top financial institutions" ([Quiltt on MX](https://www.quiltt.dev/integrations/account-aggregation/mx); sign-up at [MX dashboard](https://dashboard.mx.com/sign_up)). Production access goes through MX sales ([MX API access](https://www.mx.com/api-access/) via [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45))
- **SimpleFIN Bridge**: US$1.50/month or US$15/year for up to 25 institutions. Built for individuals and used by Actual Budget for North American bank sync — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45); [SimpleFIN Bridge](https://beta-bridge.simplefin.org/); [actual-simplefin-sync](https://github.com/duplaja/actual-simplefin-sync)
- **Yodlee**: free sandbox with no time limit, but it "no longer supports linking to live sites". Live environments need paid tiers via sales — [Yodlee FAQ](https://developer.yodlee.com/resources/yodlee/faqs/docs/building_testing). Third-party estimates of $5,000–$15,000/month platform fees plus $0.10–$0.50 per user ([GetMonetizely](https://www.getmonetizely.com/articles/plaid-vs-yodlee-how-much-will-financial-data-apis-cost-your-fintech-in-2025)) are **low-quality, unverified estimates**
- **Finicity/Mastercard**: production through Mastercard sales. No Canadian product, see Q1 — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)
- **Salt Edge**: a Free tier with 100 live connections, Growth at $500/month, and Custom — [Finexer blog on Salt Edge pricing](https://blog.finexer.com/salt-edge-pricing/) (third-party, UK-focused, via search snippet). Other sources call pricing sales-gated with a free sandbox — [rfp.wiki](https://www.rfp.wiki/financial-services-banking-fintech/open-banking-platforms/salt-edge/enable-banking) (search snippet)
- **Wealthica**: "Get in touch with the team at sales@wealthica.com for pricing" ([Wealthica developers](https://wealthica.com/developers/)). API keys: "Contact Wealthica to get keys for different environments (e.g., staging, production)" ([Wealthica docs](https://wealthica.com/docs/get-started/)). The 2024-01-12 API launch offered "trial API Keys" via sales — [Newswire](https://www.newswire.ca/news-releases/unlocking-financial-connectivity-wealthica-launches-canada-s-most-comprehensive-financial-api-837576334.html)
- **Inverite**: sandbox on request and demo-led sales, aimed at lenders — [Inverite Insights](https://inveriteinsights.com/)
- **Zūm Rails**: one comparison site lists "$25 flat rate per month", unverified — [Capterra](https://www.capterra.ca/software/1035708/zm) (search snippet). It is a payments business account, not developer self-serve
- **SnapTrade** (brokerage aggregator): Build tier free for "5 connected accounts". Launch is $100/month plus $1/month per read-only daily-data connection, and "Personal/OAuth users are currently free for a limited time" — [SnapTrade pricing](https://snaptrade.com/pricing). It supports Questrade — [SnapTrade Questrade](https://snaptrade.com/brokerage-integrations/questrade-api)
- **Questrade API**: Questrade customers can "Register a personal app" in the API Centre to get keys. The API gives account data (balances, positions) and market data; retail customers cannot place trades via the API — [Questrade API](https://www.questrade.com/api); [Questrade authorization](https://www.questrade.com/api/documentation/authorization) (search snippets; the getting-started page returned 403)

### Inferences
- The only realistic non-Plaid route to live Canadian bank data for one household without a company is SimpleFIN Bridge, if its MX-backed Canadian coverage holds up in testing (Q6). MX's own free 100-user developer tier is a second option worth testing, since it may reach real institutions without a production contract. That is not confirmed for Canada.
- For investments, Questrade's personal API (if you bank there) and SnapTrade's free tier are far more accessible than Wealthica, which is sales-only.

### Gaps
- Whether MX's free developer tier can link real Canadian institutions (e.g. CIBC, RBC, Tangerine) was not confirmed.
- No published per-connection prices for MX, Yodlee, Wealthica or Inverite.
- Whether Questrade still accepts new personal-app registrations in 2026 was not confirmed; the docs page returned 403.

## 5. CDB accreditation intent, FDX membership and Canadian bank data-access agreements

### Takeaway
MX, Finicity/Mastercard, Yodlee and Inverite are FDX Canada members, as are Interac, Flinks and Plaid. Akoya is not listed. Known bank agreements in Canada are CIBC–MX (2022), RBC–Yodlee (2022) and TD–Finicity (2020). Accreditation under the Bank of Canada regime cannot have been granted yet, since the regulations were only pre-published in June 2026. No vendor here has publicly stated Canadian accreditation intent in a source I found.

### Cited Findings
- FDX Canada's initial members include Envestnet | Yodlee, Finicity, Mastercard, MX, Inverite, Interac Corp., Flinks, Plaid, plus banks (BMO, CIBC, Desjardins, EQ Bank, National Bank, RBC, Simplii, Tangerine, TD, Capital One) — [FDX press release](https://financialdataexchange.org/fdx-feed/leading-canadian-financial-services-firms-moving-to-adopt-the-fdx-technical-standards-for-secure-financial-data-sharing/) (search-snippet summary; release date not confirmed, likely 2021–22)
- Inverite cites alignment with SOC 2 Type II, DIACC, FDX and FDATA — [Inverite Insights](https://inveriteinsights.com/)
- CIBC–MX (2022-08-08), with both parties FDX members — [FinTech Futures](https://www.fintechfutures.com/2022/08/cibc-partners-mx-for-fintech-customer-data-access-agreement/)
- RBC–Envestnet | Yodlee (2022-06-14) — [Newswire](https://www.newswire.ca/news-releases/rbc-and-envestnet-data-and-analytics-announce-agreement-to-provide-clients-with-greater-control-over-their-financial-data-830484763.html)
- TD–Finicity "North American" agreement (2020) — [Finicity](https://www.finicity.com/in-the-news/td-creates-data-access-agreement-with-finicity/)
- The Bank of Canada is lead regulator per Budget 2025, covering accreditation and supervision — [Open Banking Tracker](https://www.openbankingtracker.com/regulation/canada-open-banking) (search snippet). Accreditation includes national-security screening, and "individual developers aren't addressed" — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45) summarising [Budget 2025 framework](https://www.canada.ca/en/department-finance/programs/financial-sector-policy/open-banking-implementation/budget-2025-canadas-framework-for-consumer-driven-banking.html)
- Wealthica's statements describe "opening our bank API to external partners" but mention no accreditation or FDX membership — [Newswire 2024-01-12](https://www.newswire.ca/news-releases/unlocking-financial-connectivity-wealthica-launches-canada-s-most-comprehensive-financial-api-837576334.html)

### Inferences
- A self-hosted app for one household will not be an accredited participant itself. Under CDB it will depend on an accredited aggregator offering an individual-friendly tier. MX (via SimpleFIN) and Plaid look likeliest, given their existing hobbyist channels.
- Since investments come last in the CDB phase-in, credential scraping (Wealthica) or broker-native APIs (Questrade, Wealthsimple via SnapTrade) will remain the only investment routes for some time.

### Gaps
- No public statement found from MX, Yodlee, Mastercard, Salt Edge or Wealthica on applying for Canadian CDB accreditation.
- I did not fetch the current FDX member list to confirm 2026 membership.

## 6. MX specifically: real Canadian coverage, or essentially US-only? (SimpleFIN Bridge uses MX)

### Takeaway
MX has real but undocumented Canadian coverage: a CIBC API agreement (2022), Canadian credit-union and payments partnerships, and a stated US-and-Canada deposit coverage claim. It publishes no Canadian institution list. SimpleFIN Bridge confirms it uses MX and says it supports "US/Canadian versions" of institutions, but nobody has published verified Canadian bank lists for it. Treat it as plausible, and test by hand.

### Cited Findings
- SimpleFIN outsources to MX: "We outsource to MX to securely store and access your financial institutions" — [SimpleFIN security](https://beta-bridge.simplefin.org/info/security)
- SimpleFIN Bridge supports "US/Canadian versions of internationally established institutions"; its institution search is interactive — [SimpleFIN institution search](https://beta-bridge.simplefin.org/search-institutions) (search snippet); Budgie: "CIBC coverage couldn't be confirmed… It's worth checking by hand, because it's the only hobby-priced option" — [Budgie research](https://github.com/RobertG-H/budgie-src/pull/45)
- MX's claim of "most comprehensive coverage for demand deposit accounts across U.S. and Canada", with 75%+ direct connections — [MX Account Aggregation](https://www.mx.com/products/account-aggregation/) (search snippet). The 75% figure is presumably dominated by US connections
- The CIBC–MX API agreement, MX's first in Canada (2022) — [MX](https://www.mx.com/news/cibc-to-enhance-secure-and-seamless-access-to-financial-tools-and-apps-for-clients-through-agreement-with-mx/)
- Celero (Canadian credit unions) uses MX for PFM, and Zūm Rails uses MX for Canadian open banking — [MX/Celero](https://www.mx.com/news/celero-partners-for-personal-financial-management-tools/); [Open Banking Expo](https://www.openbankingexpo.com/news/zum-rails-partners-with-mx-to-enable-open-banking-capabilities-in-canada/)
- Actual Budget's bank sync "in North America" is SimpleFIN at $15/year, with daily data updates — [actual-simplefin-sync](https://github.com/duplaja/actual-simplefin-sync) (search snippet)

### Inferences
- MX is not US-only. Its Canadian business is mostly B2B (bank PFM, payments partners), and coverage of Desjardins, Tangerine, EQ and smaller credit unions via scraping is unknown. A US$15 SimpleFIN subscription is the cheapest way to settle this empirically for the household's actual institutions.
- If SimpleFIN works for Canadian institutions, its plain protocol (date windows, signed amounts, no delta feed) is easy to implement but forces Manilla to diff by ID itself.

### Gaps
- No user reports (Reddit, forums, GitHub) were found confirming specific Canadian banks working via SimpleFIN. A Reddit search returned nothing relevant.
- Whether SimpleFIN passes through MX's pending data, and keeps IDs stable across pending-to-posted, is undocumented.

## 7. Wealthica specifically: a third-party API for Canadian investment accounts?

### Takeaway
Yes. Since January 2024 Wealthica has offered a public-facing API, the Wealthica Connect widget and JS SDKs covering 150–200+ Canadian institutions and brokerages. It provides balances, positions, holdings, transactions, cost basis and documents, with daily sync and webhooks. API keys and pricing are sales-only, and most institutions are credential-scraped (Wealthsimple, Questrade and IB are API-based). For a single household, Questrade's personal API or SnapTrade may be cheaper routes.

### Cited Findings
- Launched 2024-01-12: connects to "over 150 Canadian financial institutions and brokerages", with daily-updated account numbers, positions, balances, securities and cost basis, plus crypto via Vezgo. 50,000+ Canadian users and $33B aggregated — [Newswire](https://www.newswire.ca/news-releases/unlocking-financial-connectivity-wealthica-launches-canada-s-most-comprehensive-financial-api-837576334.html)
- The business site claims "200+ Canadian wealth integrations" and 350+ exchanges and wallets — [b.wealthica.com](https://b.wealthica.com/) (search snippet)
- Three access modes: (a) the free, open-source Wealthica.js add-on library, which runs inside Wealthica's own web app; (b) Wealthica Connect, where users authorize a third-party app to use their Wealthica data; (c) full API integration. Example institutions include Wealthsimple, Questrade, RBC Direct Investing and BMO InvestorLine — [Wealthica developers](https://wealthica.com/developers/)
- Existing third-party "Power-Ups" include Wealthscope, P/L Timeline Tracker, Yahoo Finance Export, Passiv Lite and Excel Export — [Wealthica developers](https://wealthica.com/developers/) (search snippet)
- Credentials: entered in the Connect Widget. Most institutions use credentials; Wealthsimple, Questrade and IB are API-based. A user token is needed — [Wealthica docs](https://wealthica.com/docs/connecting-a-user/) (search snippet)
- Staging and production keys come from Wealthica on contact, and pricing is via sales@wealthica.com. Daily auto-sync plus manual sync, and webhooks — [Wealthica Get Started](https://wealthica.com/docs/get-started/); [Wealthica developers](https://wealthica.com/developers/)
- Official SDK: [wealthica/wealthica-sdk-js](https://github.com/wealthica/wealthica-sdk-js)
- Alternatives for investments: the Questrade personal API (balances, positions, account data; register a personal app) — [Questrade API](https://www.questrade.com/api). SnapTrade's free 5-account Build tier, with Questrade supported — [SnapTrade pricing](https://snaptrade.com/pricing)

### Inferences
- Wealthica is the strongest Canadian investment aggregator by breadth, especially for bank-owned brokerages such as RBC DI and BMO InvestorLine. But its sales-gated keys make it uncertain for a hobby self-hosted app. The cheapest realistic test is to ask sales about a personal or developer key.
- The Wealthica.js add-on route is free, but runs inside Wealthica's app rather than feeding a self-hosted server, so it does not suit Manilla's architecture without an export step.
- Investment data is phased last under CDB, so Wealthica-style scraping will remain the only path for bank-owned brokerages for the foreseeable future.

### Gaps
- No Wealthica pricing, minimums or individual-developer policy found.
- Whether Wealthica covers bank chequing and credit cards (not just investments) well enough to serve as the whole solution is unverified. Its marketing mentions "budgeting" use cases but lists no banks.
- Wealthica transaction ID stability and history depth were not found.
