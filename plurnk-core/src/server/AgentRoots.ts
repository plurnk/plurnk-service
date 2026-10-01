// {§agent-roots} — configuration roots this daemon reads, nearest first.
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import type HostPaths from "../core/HostPaths.ts";

export const AGENT_ROOT_SCOPES = ["project", "plurnk", "global"] as const;
export type AgentRootScope = typeof AGENT_ROOT_SCOPES[number];

const isScope = (value: string): value is AgentRootScope => (AGENT_ROOT_SCOPES as readonly string[]).includes(value);

export const agentRootScopes = (environment: NodeJS.ProcessEnv = process.env): ReadonlySet<AgentRootScope> => {
    const listed = Knob.list("PLURNK_SERVICE_ROOTS", environment);
    const unknown = listed.filter((scope) => !isScope(scope));
    if (unknown.length > 0) {
        throw new ConfigurationError("PLURNK_SERVICE_ROOTS", `PLURNK_SERVICE_ROOTS names ${unknown.map((scope) => `'${scope}'`).join(", ")}; each root is one of ${AGENT_ROOT_SCOPES.join(", ")}.`);
    }
    return new Set(listed.filter(isScope));
};

export const configurationDirectories = (paths: HostPaths, projectRoot: string | null): readonly string[] => {
    const selected = agentRootScopes();
    return AGENT_ROOT_SCOPES.flatMap((scope) => {
        if (!selected.has(scope)) return [];
        if (scope === "global") return [paths.globalAgentsDir];
        if (scope === "plurnk") return [paths.configDir];
        return projectRoot === null ? [] : [paths.projectAgentsDir(projectRoot)];
    });
};
