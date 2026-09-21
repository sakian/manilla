import { formatMoney } from '../src/money.ts';

/**
 * Integer cents, rendered and coloured.
 *
 * The string comes from `formatMoney` in src/money.ts, which is where the
 * currency symbol lives. This file used to claim to be "the only place money
 * becomes a string for display" while eight other files held their own copy of
 * the same four lines - so changing the symbol meant finding all nine.
 */
export function Money({ cents, plain = false }: { cents: number; plain?: boolean }) {
  const tone = plain ? '' : cents < 0 ? ' neg' : cents > 0 ? ' pos' : '';
  return <span className={`money${tone}`}>{formatMoney(cents)}</span>;
}

/**
 * A month's net spending for one envelope, labelled by which way it actually went.
 *
 * `spentCents` is net: refunds reduce it, so a month where money came *back* into
 * an envelope reads negative. "spent -$2,571.84" is a sentence nobody parses on
 * the first read, so the label changes with the sign and the figure is shown as a
 * positive number - the same principle the reports use. Coloured as well as
 * relabelled, so a month that ran backwards is visible without reading the word.
 */
export function Spend({ cents, label = 'spent' }: { cents: number; label?: string }) {
  const received = cents < 0;
  return (
    <span className={`figure${received ? ' received' : ''}`}>
      <span className="figure-label">{received ? 'received' : label}</span>
      <Money cents={Math.abs(cents)} plain />
    </span>
  );
}
