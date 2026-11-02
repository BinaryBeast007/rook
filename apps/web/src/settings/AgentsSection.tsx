import { Action, AgentRow, RegistryList } from "../AgentControls.tsx";
import { desktop } from "../desktop.ts";
import { useAgents } from "../useAgents.ts";
import { Section } from "./rows.tsx";

/** Every agent's install and sign-in status with its actions, then more from the ACP registry. */
export function AgentsSection() {
  const snapshot = useAgents();
  const bridge = desktop?.agents;

  if (!bridge)
    return <p className="py-4 text-xs text-neutral-500">Available in the Rook desktop app.</p>;

  return (
    <>
      <Section title="Agents" action={<Action onClick={() => bridge.refresh()}>Refresh</Action>}>
        {snapshot === null ? (
          <p className="py-4 text-xs text-neutral-500">Checking agents…</p>
        ) : (
          <ul className="divide-y divide-white/6">
            {snapshot.agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} bridge={bridge} />
            ))}
          </ul>
        )}
      </Section>
      {snapshot && <RegistryList entries={snapshot.registry} bridge={bridge} />}
    </>
  );
}
