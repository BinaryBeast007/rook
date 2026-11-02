// Claude Code activity from its local transcripts (<config>/projects/**/*.jsonl).
// Only this computer's sessions: the CLI keeps no account-wide history Rook can read.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import type { UsageActivity } from "@rook/contracts";

import { activityDays, activityStart, localDate } from "../usage.ts";

// Transcripts can add up to gigabytes; a few files at a time keeps the disk busy without flooding it.
const CONCURRENCY = 8;

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelTotals = Tokens & { model: string; requests: number };

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const sum = (tokens: Tokens) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

/** Sums assistant token usage per day and model since `activityStart(now)`. */
export async function readClaudeActivity(
  projectsDir: string,
  signal: AbortSignal,
  now = new Date(),
): Promise<UsageActivity> {
  const start = activityStart(now);
  const byDate = new Map<string, number>();
  const totals = zero();
  const models = new Map<string, ModelTotals>();
  // Streaming writes one message several times (once per content block); the first counts.
  const seen = new Set<string>();

  const add = (record: Record<string, unknown>) => {
    const message = record.message as Record<string, unknown> | undefined;
    const model = message?.model;
    if (typeof model !== "string" || model === "<synthetic>") return;
    const time = new Date(record.timestamp as string);
    if (!(time >= start)) return;
    if (typeof message?.id === "string") {
      const key = `${message.id}:${String(record.requestId)}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    const usage = (message?.usage ?? {}) as Record<string, unknown>;
    const tokens: Tokens = {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    };
    const date = localDate(time);
    byDate.set(date, (byDate.get(date) ?? 0) + sum(tokens));
    const entry = models.get(model) ?? { model, requests: 0, ...zero() };
    entry.requests += 1;
    for (const key of Object.keys(tokens) as (keyof Tokens)[]) {
      entry[key] += tokens[key];
      totals[key] += tokens[key];
    }
    models.set(model, entry);
  };

  const scan = async (file: string) => {
    if ((await stat(file)).mtime < start) return;
    const lines = createInterface({
      input: createReadStream(file, { encoding: "utf8", signal }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record?.type === "assistant") add(record);
      } catch {
        // A line cut short by a crash or a write in progress.
      }
    }
  };

  let files: string[];
  try {
    files = (await readdir(projectsDir, { recursive: true }))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => NodePath.join(projectsDir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      signal.throwIfAborted();
      // A file deleted or locked mid-scan costs only its own lines.
      // oxlint-disable-next-line no-await-in-loop -- each worker reads one file at a time
      await scan(files[next++]!).catch((error: unknown) => {
        if (signal.aborted) throw error;
      });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return {
    source: "local",
    days: activityDays(byDate, now),
    totals,
    models: [...models.values()].toSorted((a, b) => sum(b) - sum(a)),
    summary: null,
  };
}
