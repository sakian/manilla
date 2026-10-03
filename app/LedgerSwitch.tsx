import Link from 'next/link';
import { switchLedgerAction } from './actions.ts';
import { MAX_LEDGERS, type Ledger } from '../src/ledgers/config.ts';

/** Each ledger's colour, by its place in the list: one each, since there are four of both. */
export function toneOf(ledgers: Ledger[], ledger: Ledger): string {
  const index = Math.max(0, ledgers.findIndex((candidate) => candidate.key === ledger.key));
  return `ledger-tone-${index % MAX_LEDGERS}`;
}

/**
 * Which ledger is open, and the way to the others (#23).
 *
 * Shown only when there is more than one. The name sits beside the wordmark in
 * the ledger's own colour, and the header's rule takes the same colour, so the
 * books being looked at are named on every screen: importing a business
 * statement into the household ledger is the mistake most worth making hard.
 *
 * A <details> rather than a menu with state, so it needs no script and works
 * before the page has hydrated.
 */
export default function LedgerSwitch({ ledgers, current }: { ledgers: Ledger[]; current: Ledger }) {
  const others = ledgers.filter((ledger) => ledger.key !== current.key);
  return (
    <details className={`ledger-switch ${toneOf(ledgers, current)}`}>
      <summary aria-label={`${current.name} ledger. Switch ledger`}>
        <span className="ledger-dot" aria-hidden="true" />
        {current.name}
      </summary>
      <form action={switchLedgerAction} className="ledger-menu">
        <span className="ledger-menu-label">Switch to</span>
        {others.map((ledger) => (
          <button
            key={ledger.key}
            type="submit"
            name="ledger"
            value={ledger.key}
            className={toneOf(ledgers, ledger)}
          >
            <span className="ledger-dot" aria-hidden="true" />
            {ledger.name}
          </button>
        ))}
        {ledgers.length < MAX_LEDGERS && (
          <Link href="/settings#ledgers" className="ledger-menu-new">
            New ledger…
          </Link>
        )}
      </form>
    </details>
  );
}
