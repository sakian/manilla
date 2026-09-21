# Design decisions worth knowing

The choices that would be expensive to reverse, and why each was made. Most exist
because the alternative produced a plausible wrong number rather than an error —
see [measurements.md](measurements.md) for the ones that came out of measurement.

**Money is integer cents everywhere.** `parseAmount` works on the digit string
rather than `parseFloat`, because `1234.56 * 100` is `123455.99999999999` in
floating point. Ambiguous input (`"1.234"`) is parsed and flagged, never
silently guessed.

**Dates are plain `YYYY-MM-DD` strings, not `Date` objects.** A bank posting
date is a calendar date, not an instant. Parsing `20250903000000[-6:MDT]` into a
`Date` and reading it elsewhere can shift a transaction into the previous day,
and therefore into the wrong budget month.

**Date *format* is decided per file, never per row.** The export this was built
against is D/M/Y despite being a North American file, which is exactly the trap:
a North American reading parses without complaint and moves thousands of
transactions into the wrong budget month. The format is inferred from the rows
that can only be read one way - a first component above 12 - and in that file
4,450 of them settle it. Guessing per row would have misdated the rest silently.

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
before each call rather than after, and a failed call stops the layer instead of
the import. Settings lists exactly what is sent: payee text, amount, date, the
memo when there is one, and your envelope names - never a balance, and nothing
from outside the transaction itself. The memo is the part worth knowing about,
because it is whatever your bank wrote there and banks write names and partial
account numbers into memos. It goes anyway: on a line like
`AMZN Mktp CA*5O3F50IB2` it is often the only thing that says what was bought.
The off switch is there for anyone who would rather it did not.

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
envelope balances do not (MG-7). The wizard says so before anything is written, and
closes the gap with dated adjustments you read off your old app rather than with
a number from nowhere.

**Sign-in is a passkey, and sessions have two clocks.** WebAuthn is bound to the
origin, so there is nothing to phish and nothing to reuse. The cookie holds a
random token whose hash is what the database stores; sessions lapse after 12 idle
hours and end for good after 30 days, however busy.
