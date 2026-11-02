// Shared by the fake agents: a JSON state file that outlives each process, so a
// login in one process is visible to the next status check, like a real CLI.
import { readFileSync, writeFileSync } from "node:fs";

export function readState(defaults) {
  try {
    return { ...defaults, ...JSON.parse(readFileSync(process.env.FAKE_STATE_FILE, "utf8")) };
  } catch {
    return defaults;
  }
}

export function writeState(state) {
  writeFileSync(process.env.FAKE_STATE_FILE, JSON.stringify(state));
}

/** Calls `onMessage` for each JSON line on stdin; exits when stdin closes. */
export function readLines(onMessage) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
