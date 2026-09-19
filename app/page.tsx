// Smoke page: proves the Phase 0 domain modules import cleanly into the Next
// build with their explicit .ts extensions. Replaced by the dashboard (VW-1).
import { formatCents } from '../src/money.ts';
import { normalizePayee } from '../src/categorize/normalize.ts';

export default function Page() {
  return (
    <main>
      <h1>Manilla</h1>
      <p>{formatCents(482194)}</p>
      <p>{normalizePayee('SHELL #4471 CALGARY AB').display}</p>
    </main>
  );
}
