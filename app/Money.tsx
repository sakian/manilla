/** Renders integer cents. The only place money becomes a string for display. */
export function Money({ cents, plain = false }: { cents: number; plain?: boolean }) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const text = `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
  const tone = plain ? '' : cents < 0 ? ' neg' : cents > 0 ? ' pos' : '';
  return <span className={`money${tone}`}>{text}</span>;
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
