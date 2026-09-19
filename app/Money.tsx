/** Renders integer cents. The only place money becomes a string for display. */
export function Money({ cents, plain = false }: { cents: number; plain?: boolean }) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const text = `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
  const tone = plain ? '' : cents < 0 ? ' neg' : cents > 0 ? ' pos' : '';
  return <span className={`money${tone}`}>{text}</span>;
}
