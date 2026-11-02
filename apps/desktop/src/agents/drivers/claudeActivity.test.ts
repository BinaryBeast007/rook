import { mkdir, utimes, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { ACTIVITY_DAYS } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { tempDir } from "../testing/fakeBin.ts";
import { localDate } from "../usage.ts";
import { readClaudeActivity } from "./claudeActivity.ts";

const DAY = 24 * 60 * 60 * 1000;

function assistant(id: string, model: string, tokens: number[], timestamp = new Date()) {
  const [input, output, cacheRead, cacheWrite] = tokens;
  return JSON.stringify({
    type: "assistant",
    requestId: `req_${id}`,
    timestamp: timestamp.toISOString(),
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  });
}

test("sums deduplicated assistant usage per day and model from recent transcripts", async () => {
  const dir = await tempDir();
  const session = NodePath.join(dir, "F--project", "session");
  await mkdir(NodePath.join(session, "subagents"), { recursive: true });
  const yesterday = new Date(Date.now() - DAY);
  await writeFile(
    NodePath.join(dir, "F--project", "session.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      assistant("a", "claude-opus", [1, 2, 3, 4], yesterday),
      assistant("a", "claude-opus", [1, 2, 3, 4], yesterday), // Streamed again: counted once.
      assistant("s", "<synthetic>", [100, 100, 100, 100]),
      assistant("old", "claude-opus", [100, 100, 100, 100], new Date(Date.now() - 40 * DAY)),
      '{"type":"assistant","message":', // Cut short mid-write.
      assistant("b", "claude-sonnet", [10, 20, 30, 40]),
    ].join("\n"),
  );
  await writeFile(
    NodePath.join(session, "subagents", "agent-1.jsonl"),
    `${assistant("c", "claude-opus", [1, 1, 1, 1])}\r\n`,
  );
  // An old file is skipped unread, even if it holds in-range lines.
  const stale = NodePath.join(dir, "F--project", "stale.jsonl");
  await writeFile(stale, assistant("d", "claude-haiku", [5, 5, 5, 5]));
  const longAgo = new Date(Date.now() - 60 * DAY);
  await utimes(stale, longAgo, longAgo);

  const activity = await readClaudeActivity(dir, AbortSignal.timeout(10_000));
  expect(activity.source).toBe("local");
  expect(activity.summary).toBeNull();
  expect(activity.totals).toEqual({ input: 12, output: 23, cacheRead: 34, cacheWrite: 45 });
  expect(activity.models).toEqual([
    { model: "claude-sonnet", requests: 1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    { model: "claude-opus", requests: 2, input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
  ]);
  expect(activity.days).toHaveLength(ACTIVITY_DAYS);
  expect(activity.days.at(-1)).toEqual({ date: localDate(new Date()), tokens: 104 });
  expect(activity.days.find((day) => day.date === localDate(yesterday))?.tokens).toBe(10);
});

test("a missing projects folder is empty activity; an abort stops the scan", async () => {
  const dir = await tempDir();
  const empty = await readClaudeActivity(
    NodePath.join(dir, "missing"),
    AbortSignal.timeout(10_000),
  );
  expect(empty.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(empty.models).toEqual([]);
  expect(empty.days.every((day) => day.tokens === 0)).toBe(true);

  await writeFile(NodePath.join(dir, "a.jsonl"), assistant("a", "claude-opus", [1, 1, 1, 1]));
  await expect(readClaudeActivity(dir, AbortSignal.abort())).rejects.toThrow();
});
