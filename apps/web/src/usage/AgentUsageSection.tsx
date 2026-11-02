import type {
  AgentAccess,
  AgentId,
  UsageBridge,
  UsageResetCredits,
  UsageWindow,
} from "@rook/contracts";
import { useId, useState } from "react";

import { ACTION } from "../AgentControls.tsx";
import { ipcErrorMessage } from "../agents.ts";
import { clockOptions, useSettings } from "../settings/settings.ts";
import { ExternalIcon } from "../icons.tsx";
import { Activity } from "./ActivityChart.tsx";
import {
  accountProvider,
  displayPercent,
  formatDateTime,
  formatDuration,
  meterTone,
  pace,
  PACE_LABEL,
  RESET_OUTCOME_MESSAGE,
  type MeterTone,
} from "./format.ts";
import { ResetCreditDialog } from "./ResetCreditDialog.tsx";
import type { UsageEntry } from "./useUsage.ts";

const H3 = "text-sm font-medium text-neutral-200";

const METER_FILL: Record<MeterTone, string> = {
  normal: "bg-neutral-300",
  warning: "bg-amber-400",
  critical: "bg-red-400",
};

function LimitMeter({ window, now }: { window: UsageWindow; now: number }) {
  const percent = displayPercent(window.usedPercent);
  const tone = meterTone(window.usedPercent);
  const hint = pace(window, now);
  const resetsIn = window.resetsAt === null ? null : Date.parse(window.resetsAt) - now;
  const clock = clockOptions(useSettings().settings.timeFormat);
  return (
    <li className="rounded-lg border border-white/6 bg-white/[0.015] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-neutral-200" title={window.label}>
          {window.label}
        </span>
        <span
          className={`shrink-0 text-xs tabular-nums ${tone === "normal" ? "text-neutral-300" : "font-medium text-neutral-100"}`}
        >
          {percent}% used
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${window.label} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% used`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"
      >
        <div
          className={`h-full rounded-full ${METER_FILL[tone]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 text-xs text-neutral-500">
        {window.resetsAt !== null && resetsIn !== null && !Number.isNaN(resetsIn) && (
          <span title={formatDateTime(window.resetsAt, clock)}>
            {resetsIn > 0 ? `Resets in ${formatDuration(resetsIn)}` : "Resetting now"}
          </span>
        )}
        {hint && (
          <span
            title={`About ${Math.round(hint.expectedPercent)}% would be used by now at an even pace`}
          >
            {PACE_LABEL[hint.pace]}
          </span>
        )}
      </div>
    </li>
  );
}

function ResetCredits({
  credits,
  now,
  busy,
  onUse,
}: {
  credits: UsageResetCredits;
  now: number;
  busy: boolean;
  onUse: () => void;
}) {
  const expiresIn = credits.nextExpiresAt === null ? NaN : Date.parse(credits.nextExpiresAt) - now;
  const clock = clockOptions(useSettings().settings.timeFormat);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/6 px-3 py-2.5">
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-neutral-200">
          {credits.available} reset {credits.available === 1 ? "credit" : "credits"}
          {credits.nextExpiresAt !== null && expiresIn > 0 && (
            <span className="text-neutral-500" title={formatDateTime(credits.nextExpiresAt, clock)}>
              {" "}
              · next expires in {formatDuration(expiresIn)}
            </span>
          )}
        </p>
        {credits.title && <p className="mt-0.5 text-neutral-500">{credits.title}</p>}
      </div>
      <button type="button" className={ACTION} disabled={busy} onClick={onUse}>
        {busy ? "Using credit…" : "Use reset credit"}
      </button>
    </div>
  );
}

/** Spends one reset credit and words the result. Never rejects; success only on "reset". */
async function redeemResetCredit(bridge: UsageBridge, id: AgentId): Promise<string> {
  try {
    return RESET_OUTCOME_MESSAGE[await bridge.useResetCredit(id)];
  } catch (cause) {
    return ipcErrorMessage(cause);
  }
}

/** One agent's plan limits, credits and activity. */
export function AgentUsageSection({
  agent,
  entry,
  now,
  bridge,
  onRefresh,
}: {
  agent: AgentAccess;
  entry: UsageEntry;
  now: number;
  bridge: UsageBridge;
  onRefresh: () => void;
}) {
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [outcome, setOutcome] = useState("");
  const { data, error, loading } = entry;
  const provider = accountProvider(agent);

  const redeem = async () => {
    setResetting(true);
    setOutcome("");
    setOutcome(await redeemResetCredit(bridge, agent.id));
    setResetting(false);
    onRefresh();
  };

  return (
    <section aria-labelledby={headingId} aria-busy={loading} className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={headingId} className="text-base font-medium text-neutral-100">
          {agent.name}
        </h2>
        {data?.plan && (
          <span className="rounded border border-white/10 px-1.5 py-px text-2xs text-neutral-300">
            {data.plan}
          </span>
        )}
        {agent.account && (
          <span className="min-w-0 truncate text-xs text-neutral-500" title={agent.account}>
            {agent.account}
          </span>
        )}
        {data?.manageUrl && (
          <a
            href={data.manageUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-0.5 rounded text-xs text-neutral-400 transition-colors hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
          >
            Manage usage
            <ExternalIcon className="size-3.5" />
            <span className="sr-only">(opens in your browser)</span>
          </a>
        )}
      </header>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className={ACTION} disabled={loading} onClick={onRefresh}>
            Try again
          </button>
        </div>
      )}

      {data === null && loading && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500">Reading usage…</p>
          <div className="h-16 rounded-lg bg-white/4 motion-safe:animate-pulse" />
          <div className="h-28 rounded-lg bg-white/3 motion-safe:animate-pulse" />
        </div>
      )}

      {data && (
        <div
          className={`flex flex-col gap-6 transition-opacity motion-reduce:transition-none ${loading ? "opacity-60" : ""}`}
        >
          <div className="flex flex-col gap-2">
            <h3 className={H3}>Limits</h3>
            {data.windows.length === 0 ? (
              <p className="text-xs text-neutral-500">No plan limits reported.</p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
                {data.windows.map((window) => (
                  <LimitMeter key={window.id} window={window} now={now} />
                ))}
              </ul>
            )}
            {data.credits && (data.credits.unlimited || data.credits.balance !== null) && (
              <p className="text-xs text-neutral-400">
                Credits ·{" "}
                <span className="text-neutral-200 tabular-nums">
                  {data.credits.unlimited ? "Unlimited" : data.credits.balance}
                </span>
              </p>
            )}
            {data.resetCredits && data.resetCredits.available > 0 && (
              <ResetCredits
                credits={data.resetCredits}
                now={now}
                busy={resetting}
                onUse={() => setConfirming(true)}
              />
            )}
            {/* Always mounted so screen readers announce the reset outcome when it lands. */}
            <p role="status" className="text-xs text-neutral-300 empty:hidden">
              {outcome}
            </p>
          </div>

          {data.activity && (
            <Activity activity={data.activity} agentName={agent.name} provider={provider} />
          )}

          {data.notices.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-amber-200/80">
              {data.notices.map((notice) => (
                <li key={notice} className="flex gap-2">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-400"
                  />
                  {notice}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {confirming && (
        <ResetCreditDialog
          provider={provider}
          title={data?.resetCredits?.title ?? null}
          onConfirm={redeem}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
