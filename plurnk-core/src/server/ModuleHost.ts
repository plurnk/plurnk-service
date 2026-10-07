// The host's side of the module seam. Modules code against `@plurnk/plurnk-modules` and the slices
// the frameworks own ({§module-seam-slices}); the daemon implements every slice and passes itself.
// The capability-provider functions are the Functionality coordinator's host interface: core's own,
// not part of the published contract.
import type { WorkspacePluginsSeam } from "@plurnk/plurnk-agent-plugins";
import type { ProvidedSkillsSeam } from "@plurnk/plurnk-agent-skills";
import type { WorkspaceCapabilityGate, WorkspaceCapabilityIdentity } from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { FunctionalityAdapter, FunctionalitySeam, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet, SchemeRegistrationSeam, ResourceTreeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { AgentRootScope } from "./AgentRoots.ts";

// A family as the host's coordinator receives it: the runtimes a resident family prepares are
// executor registrations, and the face its manager may expose is a scheme facet.
export type HostFunctionalityAdapter = FunctionalityAdapter<RuntimeRegistration, RuntimeSchemeFacet>;

interface WorkspaceCapabilityContext extends WorkspaceCapabilityIdentity {
    retain(): () => void;
}

// {§module-workspace-provider}
export interface WorkspaceCapabilityProvider {
    activate(context: WorkspaceCapabilityContext): void | Promise<void>;
    deactivate(identity: WorkspaceCapabilityIdentity): void | Promise<void>;
}

// {§module-workspace-capabilities}
export interface WorkspaceCapabilityReplacement extends WorkspaceCapabilityIdentity {
    readonly namespaceOwner: string;
    readonly state: unknown | null;
    readonly runtimes: readonly RuntimeRegistration[];
}

export interface WorkspaceCapabilityPublication {
    readonly gate?: WorkspaceCapabilityGate;
    // Publish the coordinator's view in the same synchronous commit as the registries.
    // The returned undo runs before failed-publication document reconciliation.
    readonly publish?: () => () => void;
}

// {§module-host-capabilities} — the coordinator's host interface.
export interface CapabilityProviderSeam {
    registerRuntimes(registrations: readonly RuntimeRegistration[]): Promise<void>;
    registerWorkspaceCapabilityProvider(namespaceOwner: string, provider: WorkspaceCapabilityProvider): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown | null>;
    replaceWorkspaceCapabilities(replacement: WorkspaceCapabilityReplacement): Promise<void>;
}

// Everything the daemon hands a module at setup: every published slice, and core's own interface.
export type HostSetupSeam = ModuleSetupSeam
    & FunctionalitySeam<RuntimeRegistration, RuntimeSchemeFacet>
    & SchemeRegistrationSeam
    & ResourceTreeRegistrationSeam
    & WorkspacePluginsSeam<AgentRootScope>
    & ProvidedSkillsSeam
    & CapabilityProviderSeam;
