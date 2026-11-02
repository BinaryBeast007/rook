import {
  ACTIVITY_DAYS,
  type UsageActivity,
  type UsageDay,
  type UsageTokenTotals,
} from "@rook/contracts";
import { useId, useState, type KeyboardEvent } from "react";

import { activitySummary, formatCompact, formatDay, sumTokens } from "./format.ts";

const SUBHEADING = "text-xs font-medium text-neutral-400";

/** Daily token bars, one series: a single quiet hue, no legend, a tooltip per day. */
function DailyBars({ days }: { days: readonly UsageDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const summary = activitySummary(days);
  if (!summary)
    return (
      <p className="text-xs text-neutral-500">No activity in the last {ACTIVITY_DAYS} days.</p>
    );

  const max = summary.busiest.tokens;
  const label = `Daily tokens. ${formatCompact(summary.total)} tokens in total; busiest day ${formatDay(
    summary.busiest.date,
  )} with ${formatCompact(max)}.`;
  const shown = active === null ? null : days[active];
  const last = days.length - 1;
  // Near either end the tooltip hangs inward so it never leaves the chart.
  const tooltip =
    active === null
      ? null
      : active < 4
        ? { left: (active / days.length) * 100, shift: "" }
        : active > last - 4
          ? { left: ((active + 1) / days.length) * 100, shift: "-translate-x-full" }
          : { left: ((active + 0.5) / days.length) * 100, shift: "-translate-x-1/2" };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(last);
    else if (step) setActive((index) => Math.min(Math.max((index ?? last) + step, 0), last));
    else return;
    event.preventDefault();
  };

  return (
    <figure>
      <figcaption className="text-xs text-neutral-400">
        <span className="text-neutral-200 tabular-nums">{formatCompact(summary.total)}</span> tokens
        · busiest {formatDay(summary.busiest.date)} (
        <span className="tabular-nums">{formatCompact(max)}</span>)
      </figcaption>
      {/* One tab stop; arrow keys move the tooltip between days. */}
      <div
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((index) => index ?? last)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="relative mt-3 rounded-sm focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
      >
        <div className="flex h-24 items-end gap-0.5 border-b border-white/10">
          {days.map((day, index) => (
            <div
              key={day.date}
              onPointerEnter={() => setActive(index)}
              className="flex h-full min-w-0 flex-1 items-end"
            >
              {day.tokens > 0 && (
                <div
                  className={`min-h-0.5 w-full rounded-t-sm transition-colors motion-reduce:transition-none ${
                    index === active ? "bg-neutral-200" : "bg-neutral-500"
                  }`}
                  style={{ height: `${(day.tokens / max) * 100}%` }}
                />
              )}
            </div>
          ))}
        </div>
        {shown && tooltip && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute bottom-full mb-1.5 rounded-md border border-white/8 bg-neutral-900 px-2 py-1 text-xs whitespace-nowrap text-neutral-300 shadow-lg ${tooltip.shift}`}
            style={{ left: `${tooltip.left}%` }}
          >
            {formatDay(shown.date)} ·{" "}
            <span className="text-neutral-100 tabular-nums">{formatCompact(shown.tokens)}</span>{" "}
            tokens
          </div>
        )}
      </div>
      <div aria-hidden="true" className="mt-1 flex justify-between text-2xs text-neutral-500">
        <span>{days[0] && formatDay(days[0].date)}</span>
        <span>{days[last] && formatDay(days[last].date)}</span>
      </div>
    </figure>
  );
}

// The theme's status hues, so the bars match every theme and stay readable on its canvas.
const TOKEN_TYPES: readonly { key: keyof UsageTokenTotals; label: string; color: string }[] = [
  { key: "input", label: "Input", color: "bg-sky-400" },
  { key: "output", label: "Output", color: "bg-violet-400" },
  { key: "cacheRead", label: "Cache read", color: "bg-emerald-400" },
  { key: "cacheWrite", label: "Cache write", color: "bg-amber-400" },
];

const percentOf = (value: number, total: number) =>
  `${total > 0 ? Math.round((value / total) * 100) : 0}%`;

function TokenBreakdown({ totals }: { totals: UsageTokenTotals }) {
  const total = sumTokens(totals);
  if (total === 0) return null;
  return (
    <div>
      <h4 className={SUBHEADING}>By token type</h4>
      <div aria-hidden="true" className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full">
        {TOKEN_TYPES.map(
          ({ key, color }) =>
            totals[key] > 0 && (
              <div key={key} className={color} style={{ flexGrow: totals[key], flexBasis: 0 }} />
            ),
        )}
      </div>
      <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-4 gap-y-1 text-xs">
        {TOKEN_TYPES.map(({ key, label, color }) => (
          <li key={key} className="flex items-center gap-2">
            <span aria-hidden="true" className={`size-2 shrink-0 rounded-xs ${color}`} />
            <span className="text-neutral-400">{label}</span>
            <span className="ml-auto text-neutral-200 tabular-nums">
              {formatCompact(totals[key])}
            </span>
            <span className="w-8 text-right text-neutral-500 tabular-nums">
              {percentOf(totals[key], total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelTable({ models }: { models: UsageActivity["models"] }) {
  const total = models.reduce((sum, model) => sum + sumTokens(model), 0);
  const cell = "py-1.5 text-right tabular-nums";
  return (
    <div>
      <h4 className={SUBHEADING}>By model</h4>
      <table className="mt-1 w-full table-fixed text-xs">
        <thead className="text-neutral-500">
          <tr className="border-b border-white/6">
            <th scope="col" className="py-1.5 text-left font-normal">
              Model
            </th>
            <th scope="col" className={`${cell} w-20 font-normal`}>
              Requests
            </th>
            <th scope="col" className={`${cell} w-16 font-normal`}>
              Tokens
            </th>
            <th scope="col" className={`${cell} w-14 font-normal`}>
              Share
            </th>
          </tr>
        </thead>
        <tbody className="text-neutral-300">
          {models.map((model) => (
            <tr key={model.model} className="border-b border-white/4 last:border-0">
              <th scope="row" className="truncate py-1.5 text-left font-normal" title={model.model}>
                {model.model}
              </th>
              <td className={cell}>{formatCompact(model.requests)}</td>
              <td className={cell}>{formatCompact(sumTokens(model))}</td>
              <td className={`${cell} text-neutral-500`}>{percentOf(sumTokens(model), total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const formatDays = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

function StatTiles({ summary }: { summary: NonNullable<UsageActivity["summary"]> }) {
  const tiles = [
    ["Lifetime tokens", summary.lifetimeTokens, formatCompact],
    ["Peak day", summary.peakDailyTokens, formatCompact],
    ["Current streak", summary.currentStreakDays, formatDays],
    ["Longest streak", summary.longestStreakDays, formatDays],
  ] as const;
  const known = tiles.filter(([, value]) => value !== null);
  if (known.length === 0) return null;
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
      {known.map(([label, value, format]) => (
        <div key={label} className="rounded-lg border border-white/6 px-3 py-2">
          <dt className="text-xs text-neutral-500">{label}</dt>
          <dd className="mt-0.5 text-sm text-neutral-100 tabular-nums">{format(value ?? 0)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The last 30 days of activity, with whichever breakdowns the source reports. */
export function Activity({
  activity,
  agentName,
  provider,
}: {
  activity: UsageActivity;
  agentName: string;
  provider: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-5">
      <div>
        <h3 id={headingId} className="text-sm font-medium text-neutral-200">
          Activity <span className="font-normal text-neutral-500">· last {ACTIVITY_DAYS} days</span>
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          {activity.source === "account"
            ? `From your ${provider} account`
            : `From ${agentName} transcripts on this computer`}
        </p>
      </div>
      {activity.summary && <StatTiles summary={activity.summary} />}
      <DailyBars days={activity.days} />
      {activity.totals && <TokenBreakdown totals={activity.totals} />}
      {activity.models.length > 0 && <ModelTable models={activity.models} />}
    </section>
  );
}
