// Fake `claude` CLI: --version, auth status --json, auth login, auth logout, and
// the stream-json control channel (initialize, get_usage).
import { readLines, readState, writeState } from "./state.mjs";

const args = process.argv.slice(2).join(" ");
const state = readState({ loggedIn: false });
const send = (message) => console.log(JSON.stringify(message));

if (args === "--version") {
  console.log("2.1.310 (Claude Code)");
} else if (args === "auth status --json") {
  const status = state.loggedIn
    ? {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "me@example.com",
        subscriptionType: "max",
      }
    : { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
  console.log(JSON.stringify(status, null, 2));
  process.exitCode = state.loggedIn ? 0 : 1;
} else if (args === "auth login") {
  console.log("Opening browser to sign in…");
  console.log(
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc",
  );
  process.stdout.write("Paste code here if prompted > ");
  if (process.env.FAKE_LOGIN === "callback") {
    // The browser redirect reached the CLI's own listener.
    setTimeout(() => {
      writeState({ loggedIn: true });
      process.exit(0);
    }, 100);
  } else {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (line) => {
      if (line.trim() === "good-code") {
        writeState({ loggedIn: true });
        process.exit(0);
      }
      console.error("Invalid code");
      process.exit(1);
    });
  }
} else if (args === "auth logout") {
  writeState({ loggedIn: false });
} else if (args.startsWith("-p --input-format stream-json")) {
  const reply = (requestId, response) =>
    send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  // Hooks print before anything else; the reader must skip them.
  send({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" });
  readLines((message) => {
    if (message.type !== "control_request") throw new Error("Rook must not start a turn");
    const id = message.request_id;
    if (message.request.subtype === "initialize") return reply(id, { commands: [], models: [] });
    if (process.env.FAKE_USAGE === "error")
      return send({
        type: "control_response",
        response: { subtype: "error", request_id: id, error: "Not signed in" },
      });
    const resetsAt = "2026-10-24T22:49:59.881706+00:00";
    reply(id, {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 30, resets_at: resetsAt },
        seven_day: { utilization: 31, resets_at: resetsAt },
        extra_usage: { is_enabled: false, utilization: null },
        limits: [
          { kind: "session", percent: 30, severity: "normal", resets_at: resetsAt, scope: null },
          { kind: "weekly_all", percent: 31, severity: "normal", resets_at: resetsAt, scope: null },
          {
            kind: "weekly_scoped",
            percent: 0,
            severity: "normal",
            resets_at: resetsAt,
            scope: { model: { id: null, display_name: "Fable" }, surface: null },
          },
        ],
      },
    });
  });
} else {
  process.exitCode = 2;
}
