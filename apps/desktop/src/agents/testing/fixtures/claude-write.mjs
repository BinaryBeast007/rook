// Fake `claude -p --output-format json` for drafting git text. Records its arguments, folder and
// prompt to FAKE_WRITE_LOG; FAKE_WRITE_ERROR=1 answers like a signed-out CLI.
import { writeFileSync } from "node:fs";

let prompt = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  if (process.env.FAKE_WRITE_LOG)
    writeFileSync(
      process.env.FAKE_WRITE_LOG,
      JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }),
    );
  if (process.env.FAKE_WRITE_ERROR === "1") {
    console.log(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Not logged in · Please run /login",
      }),
    );
    process.exit(1);
  }
  const answer = '```json\n{"title": "Add the widget.", "body": "Because."}\n```';
  console.log(
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer }),
  );
});
