import { homeDb } from '../../../db/client.ts';
import { ledgerDb } from '../../ledger.ts';
import { requireUser } from '../../auth.ts';
import {
  SUGGESTION_COUNT_CAP,
  dismissedRuleSuggestions,
  listRules,
  suggestAndCount,
} from '../../../src/rules/rules.ts';
import { transferOptions } from '../../../src/envelopes/transfer.ts';
import { listAccounts } from '../../../src/accounts/manage.ts';
import { accuracy, aiSettings, aiUsage, unknownMerchantEstimate } from '../../../src/ai/ai.ts';
import SettingsHead from '../SettingsHead.tsx';
import RuleSuggestions from '../RuleSuggestions.tsx';
import Rules from '../Rules.tsx';
import AiPanel from '../AiPanel.tsx';

export const dynamic = 'force-dynamic';

/** What decides an envelope for a new transaction: your rules first, then the model. */
export default async function SortingSettings() {
  await requireUser();
  const connection = await ledgerDb();
  const [
    rules,
    { suggestions, total: suggestionTotal },
    declined,
    envelopeChoices,
    accountChoices,
    ai,
    usage,
    quality,
    unknown,
  ] = await Promise.all([
    listRules(connection),
    // Searched and counted together, so the notice that leads here always
    // agrees with what it finds.
    suggestAndCount(connection),
    dismissedRuleSuggestions(connection),
    transferOptions(connection),
    listAccounts(connection),
    // One budget for the account, covering every ledger (LG-5).
    aiSettings(homeDb()),
    aiUsage(homeDb(), undefined, connection),
    accuracy(connection),
    unknownMerchantEstimate(connection),
  ]);

  return (
    <>
      <SettingsHead slug="sorting" />

      <RuleSuggestions
        suggestions={suggestions}
        total={suggestionTotal}
        capped={suggestionTotal >= SUGGESTION_COUNT_CAP}
      />

      <Rules
        rules={rules}
        declined={declined}
        envelopes={envelopeChoices.map(({ id, name, groupName }) => ({ id, name, groupName }))}
        accounts={accountChoices.map(({ id, name }) => ({ id, name }))}
      />

      <AiPanel
        enabled={ai.enabled}
        budget={ai.monthlyCallBudget}
        usage={usage}
        accuracy={quality}
        unknownMerchants={unknown}
        keyPresent={Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)}
      />
    </>
  );
}
