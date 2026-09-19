/** Shared shapes for the categorization pipeline (section 5 of the requirements). */

export type LabeledTransaction = {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The description exactly as the bank or GoodBudget wrote it. */
  payeeRaw: string;
  amountCents: number;
  /** Ground truth: the envelope this ended up in. */
  envelope: string;
  account?: string;
  memo?: string;
};

/** A transaction awaiting a suggestion: the same shape minus the answer. */
export type UnlabeledTransaction = Omit<LabeledTransaction, 'envelope'>;

export type Candidate = {
  envelope: string;
  confidence: number;
};

export type Layer = 'rule' | 'history' | 'ai' | 'none';

export type Suggestion = {
  /** `null` means no layer was willing to guess; the review queue shows it uncategorized. */
  envelope: string | null;
  /** 0..1. The band thresholds live in `confidence.ts`. */
  confidence: number;
  layer: Layer;
  /** Shown on the review row so a suggestion is never unexplained (CA-9). */
  reason: string;
  alternatives: Candidate[];
};

export const NO_SUGGESTION: Suggestion = {
  envelope: null,
  confidence: 0,
  layer: 'none',
  reason: 'No rule or history for this payee',
  alternatives: [],
};
