// The host's side of the module seam. Modules code against `@plurnk/plurnk-modules` and the slices
// the frameworks own ({§module-seam-slices}); the daemon implements every slice and passes itself.
// The capability-provider functions are the Functionality coordinator's host interface: core's own,
// not part of the published contract.
import type { WorkspacePluginsSeam } from "@plurnk/plurnk-agent-plugins";
import type { ProvidedSkillsSeam } from "@plurnk/plurnk-agent-skills";
import type { WorkspaceCapabilityGate, WorkspaceCapabilityIdentity } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { FunctionalityAdapter, FunctionalitySeam, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import type { RuntimeSchemeFacet, SchemeRegistrationSeam, ResourceTreeRegistrationSeam } from "@plurnk/plurnk-schemes";
import type { ConfigurationRootScope } from "./AgentRoots.ts";

// A family as the host's coordinator receives it: the runtimes a resident family prepares are
// executor registrations, and the face its manager may expose is a scheme facet.
export type HostFunctionalityAdapter = FunctionalityAdapter<RuntimeRegistration, RuntimeSchemeFacet>;

interface WorkspaceCapabilityContext extends WorkspaceCapabilityIdentity {
    readonly retain: () => () => void;
}

// {§module-lifecycle}
export interface WorkspaceCapabilityProvider {
    activate(context: WorkspaceCapabilityContext): void | Promise<void>;
    deactivate(identity: WorkspaceCapabilityIdentity): void | Promise<void>;
}

interface WorkspaceSchemeRegistration {
    readonly name: string;
    readonly facet: RuntimeSchemeFacet;
    readonly traits?: readonly string[];
}

// {§module-lifecycle}
export interface WorkspaceCapabilityReplacement extends WorkspaceCapabilityIdentity {
    readonly namespaceOwner: string;
    readonly state: unknown;
    readonly runtimes: readonly RuntimeRegistration[];
    readonly schemes?: readonly WorkspaceSchemeRegistration[];
}

export interface WorkspaceCapabilityPublication {
    readonly gate?: WorkspaceCapabilityGate;
    // Publish the coordinator's view in the same synchronous commit as the registries.
    // The returned undo runs before failed-publication document reconciliation.
    readonly publish?: () => () => void;
}

// {§module-lifecycle} — the coordinator's host interface.
interface CapabilityProviderSeam {
    registerRuntimes(registrations: readonly RuntimeRegistration[]): Promise<void>;
    registerWorkspaceCapabilityProvider(namespaceOwner: string, provider: WorkspaceCapabilityProvider): void;
    readWorkspaceModuleState(workspaceId: number, namespaceOwner: string): Promise<unknown>;
    replaceWorkspaceCapabilities(replacement: WorkspaceCapabilityReplacement): Promise<void>;
}

// Everything the daemon hands a module at setup: every published slice, and core's own interface.
export type HostSetupSeam = ModuleSetupSeam
    // {§credential-authority} — the issuing module publishes the authority's face at setup, and reads
    // there the address of the listener the host bound before any module set up ({§http-host}).
    & Pick<ApplicationPort, "credentials" | "httpAddress">
    & FunctionalitySeam<RuntimeRegistration, RuntimeSchemeFacet>
    & SchemeRegistrationSeam
    & ResourceTreeRegistrationSeam
    & WorkspacePluginsSeam<ConfigurationRootScope>
    & ProvidedSkillsSeam
    & CapabilityProviderSeam;
