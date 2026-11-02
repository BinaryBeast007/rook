// Fake `grok`: --version and `models`. FAKE_GROK: in | out | expired. "expired"
// prints the signed-out line once, then is signed in (a token refresh).
import { readState, writeState } from "./state.mjs";

const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  console.log("grok 1.0.70");
} else if (args === "models") {
  const mode = process.env.FAKE_GROK;
  const state = readState({ calls: 0 });
  writeState({ calls: state.calls + 1 });
  const signedIn = mode === "in" || (mode === "expired" && state.calls > 0);
  console.log(signedIn ? "You are logged in as me@example.com\ngrok-4" : "You are not logged in.");
}
