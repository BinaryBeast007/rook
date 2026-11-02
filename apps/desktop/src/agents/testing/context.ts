// Test support: a SignInContext that records what a driver showed and opened.
import type { AgentInteraction } from "@rook/contracts";

import type { InteractionHandlers, SignInContext } from "../driver.ts";
import { runCommand, type Env } from "../process.ts";
import { displayCommand, type TerminalCommand } from "../terminal.ts";

export function recordingContext(options: { signal?: AbortSignal; runTerminal?: boolean } = {}) {
  const interactions: AgentInteraction[] = [];
  const opened: string[] = [];
  const terminals: string[] = [];
  let handlers: InteractionHandlers = {};
  let verified = false;
  const context: SignInContext = {
    signal: options.signal ?? new AbortController().signal,
    interact(interaction, next = {}) {
      if (interaction) interactions.push(interaction);
      handlers = next;
    },
    verifying() {
      verified = true;
    },
    async openExternal(url) {
      opened.push(url);
    },
    // Stands in for the user finishing the login in a terminal window.
    async openTerminal(command: TerminalCommand, env?: Env) {
      const shown = displayCommand(command);
      terminals.push(shown);
      if (options.runTerminal && "file" in command)
        await runCommand(command.file, command.args, {
          env: { ...process.env, ...env },
          timeoutMs: 20_000,
        });
      return shown;
    },
  };
  return {
    context,
    interactions,
    opened,
    terminals,
    handlers: () => handlers,
    verified: () => verified,
  };
}
