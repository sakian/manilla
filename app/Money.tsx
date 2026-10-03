'use client';

import { useEffect, useRef, useState } from 'react';
import { amountToCopy, formatMoney } from '../src/money.ts';
import { copyText } from './clipboard.ts';

/**
 * Integer cents, rendered and coloured - and copied when pressed (#44).
 *
 * The string comes from `formatMoney` in src/money.ts, which is where the
 * currency symbol lives. This file used to claim to be "the only place money
 * becomes a string for display" while eight other files held their own copy of
 * the same four lines - so changing the symbol meant finding all nine.
 *
 * Pressing an amount copies the figure a bank's amount box wants (see
 * `amountToCopy`), because the number on this screen is so often the one about
 * to be typed into another app. It is a real button, so it can be reached by
 * keyboard, and it sits above a card's stretched link: on a phone, a tap on the
 * amount copies and a tap anywhere else on the card still opens it. A short
 * "Copied" says it worked, and a failure says so rather than nothing.
 *
 * `copy={false}` where the amount is already inside a link or a label, which
 * may not hold a button.
 */
export function Money({
  cents,
  plain = false,
  sign,
  copy = true,
}: {
  cents: number;
  plain?: boolean;
  /** As `formatMoney`: mark the money coming in rather than going out. */
  sign?: 'incoming';
  copy?: boolean;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const tone = plain ? '' : cents < 0 ? ' neg' : cents > 0 ? ' pos' : '';
  const shown = formatMoney(cents, sign ? { sign } : {});
  if (!copy) return <span className={`money${tone}`}>{shown}</span>;

  const text = amountToCopy(cents);
  return (
    <button
      type="button"
      className={`money money-copy${tone}`}
      title={`Copy ${text}`}
      onClick={async (event) => {
        // Not a press of whatever row or card it sits on.
        event.preventDefault();
        event.stopPropagation();
        const copied = await copyText(text);
        setSaid(copied ? 'Copied' : 'Couldn’t copy');
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setSaid(null), 1600);
      }}
    >
      {shown}
      <span className="money-copied" role="status">
        {said}
      </span>
    </button>
  );
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
