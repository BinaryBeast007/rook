// Fake ACP agent. FAKE_ACP_PROTOCOL: 1 | 2. FAKE_ACP_METHOD: agent | terminal |
// env_var. FAKE_ACP_ELICIT=1 asks the client to open a sign-in page during login.
import { readLines, readState, writeState } from "./state.mjs";

const protocol = Number(process.env.FAKE_ACP_PROTOCOL ?? "1");
const methodType = process.env.FAKE_ACP_METHOD ?? "agent";
let nextId = 1000;
const pending = new Map();
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

function authMethod() {
  const base = protocol === 2 ? { methodId: "login" } : { id: "login" };
  if (methodType === "terminal")
    return { ...base, name: "Log in", type: "terminal", args: ["--login"] };
  if (methodType === "env_var")
    return { ...base, name: "API key", type: "env_var", vars: [{ name: "FAKE_API_KEY" }] };
  return { ...base, name: "Log in", ...(protocol === 2 ? { type: "agent" } : {}) };
}

if (process.argv.includes("--login")) {
  // The terminal login: writes credentials and exits.
  writeState({ authenticated: true });
  process.exit(0);
}

readLines(async (message) => {
  if (message.method === undefined) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  const state = readState({ authenticated: false });
  const reply = (result) => send({ id: message.id, result });
  const fail = (code, text) => send({ id: message.id, error: { code, message: text } });
  switch (message.method) {
    case "initialize":
      reply(
        protocol === 2
          ? {
              protocolVersion: 2,
              info: { name: "fake-acp", version: "1.0.0" },
              capabilities: {},
              authMethods: [authMethod()],
            }
          : {
              protocolVersion: 1,
              agentInfo: { name: "fake-acp", version: "1.0.0" },
              agentCapabilities: { loadSession: true, auth: { logout: {} } },
              authMethods: [authMethod()],
            },
      );
      break;
    case "authenticate":
    case "auth/login": {
      const expected = protocol === 2 ? "auth/login" : "authenticate";
      if (message.method !== expected) return fail(-32601, "wrong method name");
      if (process.env.FAKE_ACP_ELICIT === "1") {
        const answer = await ask("elicitation/create", {
          mode: "url",
          url: "https://example.com/login?s=1",
          message: "Sign in",
        });
        if (answer?.action !== "accept") return fail(-32000, "Sign-in declined");
      }
      if (process.env.FAKE_LOGIN === "fail") return fail(-32603, "SUBSCRIPTION_REQUIRED");
      writeState({ authenticated: true });
      reply({});
      break;
    }
    case "logout":
    case "auth/logout":
      writeState({ authenticated: false });
      reply({});
      break;
    case "session/new":
      if (!state.authenticated) return fail(-32000, "Authentication required");
      reply({ sessionId: "s1" });
      break;
    default:
      fail(-32601, "not found");
  }
});
