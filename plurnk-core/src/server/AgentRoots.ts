// {§agent-roots} — the Agent Skills and Agent Plugins roots this daemon reads, nearest first.
import { Knob } from "@plurnk/plurnk-meta";

export const AGENT_ROOT_SCOPES = ["project", "plurnk", "global"] as const;
export type AgentRootScope = typeof AGENT_ROOT_SCOPES[number];

const isScope = (value: string): value is AgentRootScope => (AGENT_ROOT_SCOPES as readonly string[]).includes(value);

export const agentRootScopes = (): ReadonlySet<AgentRootScope> => {
    const listed = Knob.list("PLURNK_SERVICE_ROOTS");
    const unknown = listed.filter((scope) => !isScope(scope));
    if (unknown.length > 0) {
        throw new Error(`PLURNK_SERVICE_ROOTS names ${unknown.map((scope) => `'${scope}'`).join(", ")}; each root is one of ${AGENT_ROOT_SCOPES.join(", ")}.`);
    }
    return new Set(listed.filter(isScope));
};
