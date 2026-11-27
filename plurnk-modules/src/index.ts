// The daemon module contract ({§module-contract}): the lifecycle a module implements and the base
// setup seam it receives. Each framework owns the slice for what modules contribute to its kind
// ({§module-seam-slices}); this package depends on contracts alone (ARCHITECTURE.md § Package principles).
import type {
    ApplicationActionContext,
    ApplicationActionDescriptor,
    ApplicationPersonaProjection,
    CredentialAuthority,
    FunctionalityCaller,
    FunctionalityCandidate,
    FunctionalityAdmission,
    FunctionalityDefinitionSource,
    FunctionalityDiscoverInput,
    FunctionalityDiscoverPage,
    FunctionalityDiscoverQuery,
    FunctionalityFamilyHandle,
    FunctionalityIdentity,
    FunctionalityPreparation,
    FunctionalityPrepared,
    FunctionalityScope,
    FunctionalityServiceDefinition,
    JsonSchema,
    Notice,
    PlurnkStatement,
    ProjectRootConfinement,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";

export type ModuleActionScope = "daemon" | "workspace" | "session";

export type ModuleActionContext = ApplicationActionContext;

export type ModuleActionHandler = (
    params: Readonly<Record<string, unknown>>,
    context: ModuleActionContext,
) => unknown;

// {§module-seam-slices}
export interface ModuleActionRegistration {
    readonly name: string;
    readonly scope: ModuleActionScope;
    readonly residency: "required" | "none";
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
    readonly handler: ModuleActionHandler;
}

export type ModuleActionDescriptor = ApplicationActionDescriptor;

// {§functionality-adapter} — the discovery a family serves: the shared query's inputs it reads,
// any subset that is always required, and whether a request naming none lists everything.
// The coordinator advertises exactly these alongside pagination controls `cursor` and `limit`.
export interface FunctionalityDiscovery {
    readonly inputs: readonly FunctionalityDiscoverInput[];
    readonly required?: readonly FunctionalityDiscoverInput[];
    readonly emptyListsAll?: true;
    // The family's own `discover` teaching beneath the generic verb summary.
    readonly details?: string;
}

// {§functionality-replacement} — a family whose definitions are named by their own content rather than
// by a caller-chosen alias. The coordinator still keys state by alias, under the family's own alias
// grammar; the family's verbs name it: `add` takes this input and `admit` returns one admission per
// definition it names, and enable, disable and remove take the select input. Such a family serves
// no `replace`: when the name is the definition, there is nothing to reassign.
export interface FunctionalityAddressing {
    // The exact `add` input.
    readonly add: JsonSchema;
    // The exact `enable`, `disable` and `remove` input.
    readonly select: JsonSchema;
    // The alias a select input names.
    alias(input: object): string;
}

// {§functionality-adapter} — one family of managed Functionality beneath the host's coordinator.
// `Runtime` is what a resident family prepares and `SchemeFacet` the face its manager may expose;
// both default to none, and the frameworks that own those types name them ({§module-seam-slices}).
// `Definition` is what the family's `definitionSchema` admits and `Snapshot` what its preparation
// commits; the family names both ({§functionality-adapter}).
export interface FunctionalityAdapter<Runtime = never, SchemeFacet = never, Definition extends object = object, Snapshot = unknown> {
    readonly scheme?: SchemeFacet;
    // {§functionality-adapter} — semantic traits declared by the family's runtime and scheme face.
    readonly traits?: readonly string[];
    // The action segment (`workspace.<family>.<verb>`, or `session.<family>.<verb>` for a
    // session-scoped family) and the name of the family's runtime.
    readonly family: string;
    // {§functionality-coordinator} Supported mutable scopes (`service`, `workspace`, `session`).
    // Absent means `["workspace"]`. The first non-`service` scope is the model default;
    // `service` registers strictly client-only `service.<family>.*` actions.
    readonly scopes?: readonly FunctionalityScope[];
    // The alias grammar the coordinator enforces for this family. Absent means the shared default
    // (`[a-z][a-z0-9-]*`); a family whose alias is case-sensitive, or whose alias is the definition's
    // own content ({§functionality-replacement}), declares its own.
    readonly aliasPattern?: RegExp;
    // {§functionality-replacement} Absent: a caller-chosen alias names a definition, `add` and `replace`
    // take `{ alias?, definition }`, and the other mutations take `{ alias }`.
    readonly addressing?: FunctionalityAddressing;
    // The one publication owner for this family's runtimes and state.
    readonly namespaceOwner: string;
    readonly summary: string;
    // The exact definition the coordinator persists: what `add`/`replace` accept, or what an addressing
    // family's `admit` produces from its own `add` input.
    readonly definitionSchema: JsonSchema;
    // Teaching for the family's generated document ({§functionality-model-projection}): one exact
    // `add` input.
    readonly example?: object;
    // Absent: the family serves no discovery, and implements no `discover`.
    readonly discovery?: FunctionalityDiscovery;
    // {§functionality-model-projection} — the adapter's package directory; its `docs/<family>.md` is the
    // authored teaching beneath the runtime document's generated header.
    readonly docsDir?: string;
    available(identity: FunctionalityIdentity): Promise<readonly FunctionalityServiceDefinition<Definition>[]>;
    // Current partial-source diagnostics; independent valid definitions remain available.
    configurationNotices?(identity: WorkspaceCapabilityIdentity): readonly Notice[];
    // Receives only a query the family's declared discovery admits. May return a full candidate list
    // (paged deterministically by the coordinator) or an explicit FunctionalityDiscoverPage.
    discover?(query: FunctionalityDiscoverQuery, identity: FunctionalityIdentity): Promise<readonly FunctionalityCandidate[] | FunctionalityDiscoverPage>;
    // One admission, or, for an addressing family's `add`, one per definition the input names.
    admit(input: unknown, identity: FunctionalityIdentity, caller?: FunctionalityCaller): Promise<FunctionalityAdmission<Definition> | readonly FunctionalityAdmission<Definition>[]>;
    prepare(preparation: FunctionalityPreparation<Definition, Snapshot>): Promise<FunctionalityPrepared<Runtime, Snapshot>>;
    teardown(snapshot: Snapshot, identity: WorkspaceCapabilityIdentity): Promise<void>;
    // Release what the workspace or service definition installed or provisioned, before the coordinator
    // forgets it on `remove`; a failure rejects the removal.
    forget?(definition: FunctionalityDefinitionSource<Definition>, identity: FunctionalityIdentity): Promise<void>;
    // {§functionality-inspection} — republish when what `available` reads changed out of band; called
    // under the workspace turn gate before packet assembly.
    refreshIfChanged?(identity: WorkspaceCapabilityIdentity): Promise<void>;
    // {§operator-config-workspace-settings} — optional operator-enforced policy summary exposed to clients.
    policy?(): object | undefined;
}

// {§module-seam-slices} — host placement, not a module-owned discovery cascade.
export interface WorkspacePaths {
    readonly home: string;
    readonly projectRoot: string | null;
    readonly projectRootConfinement?: ProjectRootConfinement;
    readonly workspaceName?: string;
    readonly configurationRoots: readonly {
        readonly scope: string;
        readonly directory: string;
    }[];
}

// {§module-seam-slices} — the base setup slice: what every host offers every module.
export interface ClientToolCallInput {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly aside?: string;
}

export interface ModuleSetupSeam {
    // {§credential-authority} — the daemon's credential authority, offered at setup so modules can
    // register confidential OAuth 2.1 clients or publish the issuing face before start().
    readonly credentials: CredentialAuthority;
    // {§http-host} — the address of the listener bound by the host before setup().
    httpAddress(): { readonly host: string; readonly port: number };
    // {§module-seam-slices}
    workspacePaths(workspaceId: number): Promise<WorkspacePaths>;
    // {§module-seam-slices} Daemon-level paths (non-project configuration roots, projectRoot: null).
    servicePaths?(): WorkspacePaths;
    // {§mcp-module} Ambient launch base, before the module's explicit bindings:
    // excludes reserved names ({§execution-output-identity}) without applying the model-command ceiling.
    operatorEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
    // {§execution-output-identity} Service-tier runtime env overlay over an admitted ambient base
    // (host env files + `service.env`, without workspace/session overrides).
    readServiceEnvironment?(): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§execution-output-identity} The workspace layer over admitted ambient values, or over a supplied
    // reference-resolution environment. Never includes session overrides.
    readWorkspaceEnvironment(workspaceId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§execution-output-identity} The same layers with the Session's own overrides on top ({§functionality-coordinator}).
    readSessionEnvironment(workspaceId: number, sessionId: number): Promise<(ambient?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv>;
    // {§module-seam-slices} The host owns placement; the module owns the contents.
    workspaceStateDirectory(workspaceId: number, namespaceOwner: string): Promise<string>;
    // {§module-seam-slices} Daemon-level operational state directory outside SQLite (`0700`).
    serviceStateDirectory?(namespaceOwner: string): Promise<string>;
    readServiceModuleState?(namespaceOwner: string): Promise<unknown>;
    readWorkspaceModuleState?(workspaceId: number, namespaceOwner: string): Promise<unknown>;
    writeWorkspaceModuleState?(workspaceId: number, namespaceOwner: string, state: unknown): Promise<void>;
    lowerClientCalls?(calls: readonly ClientToolCallInput[], workspaceId?: number): Promise<readonly PlurnkStatement[]>;
    registerModuleAction(registration: ModuleActionRegistration): void;
    invokeModuleAction?(
        name: string,
        params: Readonly<Record<string, unknown>>,
        context: ModuleActionContext,
    ): Promise<unknown>;
}

// {§module-seam-slices} — registers one family beneath the host's coordinator.
export interface FunctionalitySeam<Runtime = never, SchemeFacet = never> {
    registerFunctionalityAdapter<Definition extends object = object, Snapshot = unknown>(
        adapter: FunctionalityAdapter<Runtime, SchemeFacet, Definition, Snapshot>,
    ): FunctionalityFamilyHandle;
}

// {§module-seam-slices} — registers the workspace persona reader consumed by session binding and listPersonas.
export interface PersonaRegistrySeam {
    registerPersonaReader(reader: (workspaceId: number) => Promise<readonly ApplicationPersonaProjection[]>): void;
}

// {§module-seam-slices} — read-only call identity offered to a provider metadata contributor before
// an outbound model call is dispatched; projected `X-Plurnk-Meta-*` headers remain gated by operator opt-in.
export interface ProviderMetadataContext {
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly sessionId: number;
    readonly sessionName: string;
    readonly actor: string | null;
    readonly loopId: number;
    readonly turnId: number;
    readonly provider: string;
    readonly model: string;
    readonly callKind: "emission" | "bare";
}

export type ProviderMetadataContributor = (
    context: ProviderMetadataContext,
) => Readonly<Record<string, string>> | undefined | Promise<Readonly<Record<string, string>> | undefined>;

// {§module-seam-slices} — registers a daemon-module contributor of outbound provider metadata headers
// (`X-Plurnk-Meta-<key>`), transmitted only on routes explicitly opting into `module`.
export interface ProviderMetadataSeam {
    registerProviderMetadataContributor(contributor: ProviderMetadataContributor): void;
}

// {§module-contract} One setting a module contained: it withheld the part the setting
// configures and kept the rest working.
export interface ContainedConfiguration {
    readonly key: string;
    readonly message: string;
}

export interface StartedModule {
    // {§module-shutdown-order} Producers settle before observers are released.
    stop?(): void | Promise<void>;
    close?(): void | Promise<void>;
}

// {§module-contract} `setup` establishes every capability the host may demand during recovery;
// `start` opens exterior ingress only after durable recovery is complete ({§module-lifecycle}).
export interface DaemonModule<SetupSeam = ModuleSetupSeam, StartSeam = ApplicationPort> extends StartedModule {
    // {§module-contract} The HTTP route prefixes this module mounts at `start`, claimed before any
    // module sets up.
    readonly mounts?: readonly string[];
    // {§module-contract} Settings this module contained, read by the host at registration.
    readonly contained?: readonly ContainedConfiguration[];
    setup?(seam: SetupSeam): void | Promise<void>;
    start?(seam: StartSeam): void | StartedModule | Promise<void | StartedModule>;
}
