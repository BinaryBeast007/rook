// Fake `pi`: --version and `--mode rpc` answering get_available_models.
import { readLines } from "./state.mjs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.FAKE_PI_VERSION ?? "0.81.0");
} else if (args.includes("rpc")) {
  const count = Number(process.env.FAKE_PI_MODELS ?? "0");
  readLines((message) => {
    const models = Array.from({ length: count }, (_, i) => ({
      provider: "anthropic",
      id: `model-${i}`,
    }));
    process.stdout.write(
      `${JSON.stringify({ type: "response", id: message.id, command: message.type, success: true, data: { models } })}\n`,
    );
  });
}
