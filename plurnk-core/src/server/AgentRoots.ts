// {§agent-roots} — configuration roots this daemon reads, nearest first.
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import type { WorkspacePaths } from "@plurnk/plurnk-modules";
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

export const workspacePaths = (paths: HostPaths, projectRoot: string | null): WorkspacePaths => {
    const selected = agentRootScopes();
    return {
        home: paths.home,
        projectRoot,
        configurationRoots: AGENT_ROOT_SCOPES.flatMap((scope) => {
            if (!selected.has(scope)) return [];
            const directory = scope === "global" ? paths.globalAgentsDir
                : scope === "plurnk" ? paths.configDir
                    : projectRoot === null ? null : paths.projectAgentsDir(projectRoot);
            return directory === null ? [] : [{ scope, directory }];
        }),
    };
};
