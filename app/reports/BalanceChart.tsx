'use client';

/**
 * An envelope's balance over the report's period, as a line (VW-4, #4).
 *
 * The app's first chart, and kept to what the figure needs: one stepped line -
 * a balance holds between the days it changes - on hairline gridlines with zero
 * always on the axis, the closing balance written at the end, and month labels
 * along the bottom. A crosshair finds the balance on any day under the pointer
 * or the arrow keys, read out on a line above the plot, and the same figures are
 * in a table beneath it, so nothing is only reachable by hovering.
 *
 * Drawn at the width it is given rather than scaled, so text stays its own size
 * on a phone.
 */

import { useEffect, useRef, useState } from 'react';
import type { BalanceSeries } from '../../src/reports/balance.ts';
import { monthEndBalances } from '../../src/reports/balance.ts';
import { daysBetween, monthTicks, niceTicks } from '../../src/reports/chart.ts';
import { addDays, displayDate, monthLabel } from '../../src/budget/month.ts';
import { formatMoney } from '../../src/money.ts';

const HEIGHT = 200;
const PAD = { top: 22, right: 12, bottom: 26, left: 10 };

/** A tick or the end label: whole dollars when the cents are zero, which on a round tick they are. */
function short(cents: number): string {
  return formatMoney(cents).replace(/\.00$/, '');
}

export function BalanceChart({ series, name }: { series: BalanceSeries; name: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** Which point the crosshair is on, or null when it is not showing. */
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { points, start, end } = series;
  const values = points.map((point) => point.balanceCents);
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 5);

  // The value axis's widest label decides the left margin, roughly: 7px a character.
  const left = PAD.left + Math.max(...ticks.map((tick) => short(tick).length)) * 7;
  const plotWidth = Math.max(1, width - left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const span = Math.max(1, daysBetween(start, end));
  const low = ticks[0]!;
  const high = ticks[ticks.length - 1]!;

  const x = (date: string) => left + (daysBetween(start, date) / span) * plotWidth;
  const y = (cents: number) => PAD.top + (high === low ? plotHeight / 2 : ((high - cents) / (high - low)) * plotHeight);

  const path = points
    .map((point, index) =>
      index === 0
        ? `M${x(point.date)},${y(point.balanceCents)}`
        : `H${x(point.date)}V${y(point.balanceCents)}`,
    )
    .join('');

  const months = monthTicks(start, end, Math.max(2, Math.floor(plotWidth / 64)));
  const last = points[points.length - 1]!;
  const lowest = points.reduce((min, point) => (point.balanceCents < min.balanceCents ? point : min));
  const summary =
    `${name}'s balance from ${displayDate(start)} to ${displayDate(end)}: ` +
    `${formatMoney(points[0]!.balanceCents)} to ${formatMoney(last.balanceCents)}, ` +
    `lowest ${formatMoney(lowest.balanceCents)} on ${displayDate(lowest.date)}.`;

  /** The point in force on the day under the pointer: the last change on or before it. */
  const pointAt = (clientX: number) => {
    const box = frame.current!.getBoundingClientRect();
    const day = ((clientX - box.left - left) / plotWidth) * span;
    let found = 0;
    points.forEach((point, index) => {
      if (daysBetween(start, point.date) <= day) found = index;
    });
    return found;
  };

  const shown = at === null ? null : points[at]!;
  // A step's value holds until the day before the next change, so the tooltip
  // says for how long; the last one holds to the end of the line.
  // The closing point only repeats the last balance at the end date, so it is
  // not a change to stop at.
  const next = at === null ? undefined : points[at + 1];
  const closing = next !== undefined && at === points.length - 2 && next.balanceCents === points[at!]!.balanceCents;
  const until = at === null ? null : next && !closing ? addDays(next.date, -1) : end;

  return (
    <div className="balance-chart">
      {/* A readout line above the plot rather than a floating tooltip: it
          covers nothing, and reads the same under a finger as a pointer. */}
      <p className="balance-chart-readout" aria-live="polite">
        {shown ? (
          <>
            <strong className="money">{formatMoney(shown.balanceCents)}</strong>{' '}
            <span className="muted">
              {until && until > shown.date
                ? `${displayDate(shown.date)} – ${displayDate(until)}`
                : displayDate(shown.date)}
            </span>
          </>
        ) : (
          <span className="muted">Point at the line, or use the arrow keys, for any day&rsquo;s balance</span>
        )}
      </p>
      <div
        ref={frame}
        className="balance-chart-frame"
        tabIndex={0}
        role="img"
        aria-label={summary}
        onPointerMove={(event) => setAt(pointAt(event.clientX))}
        onPointerLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            const step = event.key === 'ArrowRight' ? 1 : -1;
            setAt((current) =>
              Math.min(points.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : points.length)) + step)),
            );
          } else if (event.key === 'Escape') {
            setAt(null);
          }
        }}
      >
        {width > 0 && (
          <svg width={width} height={HEIGHT} aria-hidden="true">
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  className={tick === 0 && low < 0 ? 'zero' : 'grid'}
                  x1={left}
                  x2={left + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text className="axis" x={left - 6} y={y(tick)} dy="0.32em" textAnchor="end">
                  {short(tick)}
                </text>
              </g>
            ))}
            {months.map((month) => (
              <text
                key={month.date}
                className="axis"
                x={x(month.date)}
                y={HEIGHT - 8}
                textAnchor="middle"
              >
                {month.label}
              </text>
            ))}

            <path className="line" d={path} />
            <circle className="end" cx={x(last.date)} cy={y(last.balanceCents)} r={4} />
            <text
              className="end-label"
              x={x(last.date)}
              y={Math.max(12, y(last.balanceCents) - 10)}
              textAnchor="end"
            >
              {formatMoney(last.balanceCents)}
            </text>

            {shown && (
              <g className="crosshair">
                <line x1={x(shown.date)} x2={x(shown.date)} y1={PAD.top} y2={PAD.top + plotHeight} />
                <circle cx={x(shown.date)} cy={y(shown.balanceCents)} r={4} />
              </g>
            )}
          </svg>
        )}

      </div>

      <details className="balance-chart-table">
        <summary>As a table</summary>
        <table className="trend">
          <thead>
            <tr>
              <th>Month</th>
              <th>Balance at its end</th>
            </tr>
          </thead>
          <tbody>
            {monthEndBalances(series).map((row) => (
              <tr key={row.month}>
                <td>{monthLabel(row.month)}</td>
                <td className="money">{formatMoney(row.balanceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
