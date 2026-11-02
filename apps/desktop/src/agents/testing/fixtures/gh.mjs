// Fake GitHub CLI. FAKE_GH_AUTH=0: signed out. FAKE_GH_PR: the pull request's JSON, else none.
// FAKE_GH_LOG: a file that records each call's arguments.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${args.join(" ")}\n`);

if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_GH_AUTH === "0") {
    console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login");
    process.exit(1);
  }
  console.log(
    "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token: gho_****",
  );
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  if (process.env.FAKE_GH_PR) {
    console.log(process.env.FAKE_GH_PR);
    process.exit(0);
  }
  console.error(`no pull requests found for branch "${args[2]}"`);
  process.exit(1);
}
console.error(`unexpected: ${args.join(" ")}`);
process.exit(2);
