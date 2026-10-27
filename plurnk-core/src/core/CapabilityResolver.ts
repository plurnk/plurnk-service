import {
    CapabilityAdmission,
    type CapabilityDescriptor,
    type CapabilityPolicy,
    type CapabilityProjection,
    type PlurnkStatement,isExecution,isExecutionOp,type RuntimeTag,type ParsedPath
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import SessionOwners from "./SessionOwners.ts";
import ToolResources from "./ToolResources.ts";
import { isGeneratedPathname, schemeNameOf } from "./plurnk-uri.ts";
import { execRouteOf } from "../schemes/exec-runtime.ts";
import { coreRepresentationProvider } from "./CoreSchemeServices.ts";
import type { SchemeManifest, WriterTier } from "@plurnk/plurnk-schemes";

// {§capability-policy-cascade} A denial names the ring that refused.
type CapabilityScope = "service" | "workspace" | "owner";

export interface CapabilityLayer {
    readonly scope: CapabilityScope;
    readonly policy: CapabilityPolicy;
}

export interface CapabilityDenial {
    readonly descriptor: CapabilityDescriptor;
    readonly scope: CapabilityScope;
}

// RuntimeTag is Lowercase<string>: a runtime the registry or a family's manager names is lowercase by
// {§executor-runtime-declaration} and the functionality family name rule.
const isLowercase = (name: string): name is RuntimeTag => name === name.toLowerCase();

export default class CapabilityResolver {
    // {§pinned-wording-core} The owner ring is the one refusal the model can act on.
    static readonly UNATTENDED_RECOVERY =
        "Nobody is present to answer. Decide from what you already have, or conclude stating what you could not resolve.";

    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #executors: () => ExecutorRegistry | undefined;

    constructor(db: Db, schemes: SchemeRegistry, executors: () => ExecutorRegistry | undefined) {
        this.#db = db;
        this.#schemes = schemes;
        this.#executors = executors;
    }

    descriptors(
        statement: PlurnkStatement,
        workspaceId: number,
        writer: WriterTier = "model",
        observeManifest?: (target: ParsedPath) => SchemeManifest | undefined,
    ): readonly CapabilityDescriptor[] {
        const describe = (
            operation: CapabilityDescriptor["operation"],
            access: CapabilityDescriptor["access"],
            target: ParsedPath | null,
        ): CapabilityDescriptor[] | null => {
            const scheme = schemeNameOf(target);
            if (access === "observe" && target !== null && scheme !== null && observeManifest !== undefined) {
                const manifest = observeManifest(target);
                return manifest === undefined ? null : [{ operation, access, scheme, traits: [...(manifest.traits ?? [])].toSorted() }];
            }
            if (scheme === null || !this.#schemes.has(scheme, workspaceId)) return null;
            // {§session-scheme}: owned-state mutation is intrinsic;
            // observation and unrelated effects retain their independent demands.
            if (writer === "_plurnk" && access !== "observe" && scheme === "workspace"
                && target?.kind === "url" && isGeneratedPathname(target.pathname)) return [];
            return [this.#schemeDescriptor(operation, access, scheme, workspaceId)];
        };
        const demands = (...items: readonly (CapabilityDescriptor[] | null)[]): CapabilityDescriptor[] =>
            items.flatMap((item) => item ?? []);
        const composedDemands = (...items: readonly (CapabilityDescriptor[] | null)[]): CapabilityDescriptor[] =>
            items.every((item) => item !== null)
                ? demands(...items)
                : [];

        // An execution's operation is its runtime tag; the capability route is the runtime's.
        if (isExecution(statement)) {
            const executors = this.#executors();
            const route = execRouteOf(statement);
            const runtime = route.runtime;
            const entry = executors?.entry(runtime, workspaceId);
            if (entry === undefined || !entry.available) return [];
            const registry = executors?.toolRegistry(runtime, workspaceId) ?? null;
            const target = route.target === null ? null : route.target.raw;
            const tool = registry?.tools.find((candidate) => candidate.target === target)?.target ?? null;
            // A finite tool registry owns exact target resolution. Missing
            // and unknown targets must reach that owner as ordinary
            // tool-required/tool-not-enabled failures; policy cannot
            // misrepresent absence as denied authority.
            if (registry !== null && tool === null) return [];
            const required: CapabilityDescriptor[] = [this.#runtimeDescriptor(runtime, tool, workspaceId)];
            const targetKind = entry.invocation.target?.kind;
            const execTarget = route.target;
            if ((targetKind === "resource" || targetKind === "script") && execTarget === null) {
                if (entry.invocation.target?.required === true) return [];
            } else if ((targetKind === "resource" || targetKind === "script") && execTarget !== null) {
                const targetDemand = describe(statement.runtime, "observe", execTarget);
                if (targetDemand === null) return [];
                required.push(...targetDemand);
            }
            return required;
        }
        switch (statement.op) {
            case "FIND":
            case "READ":
                return demands(describe(statement.op, "observe", statement.target));
            case "EDIT":
                return demands(describe(statement.op, "mutate", statement.target));
            case "COPY":
                return composedDemands(
                    describe("COPY", "observe", statement.source.target),
                    describe("COPY", "mutate", statement.destination.target),
                );
            case "MOVE":
                return composedDemands(
                    describe("MOVE", "observe", statement.source.target),
                    describe("MOVE", "mutate", statement.source.target),
                    describe("MOVE", "mutate", statement.destination.target),
                );
            case "WORK":
            case "FORK":
                return demands(describe(statement.op, "control", statement.target));
            case "BARE":
                return demands(
                    [{ operation: "BARE", access: "execute", traits: [] }],
                    describe("BARE", "observe", statement.target),
                );
            case "KILL": {
                const scheme = schemeNameOf(statement.target);
                if (scheme === "log") return [];
                const control = scheme === "session" || (scheme !== null && this.#executors()?.entry(scheme, workspaceId) !== undefined);
                return demands(describe("KILL", control ? "control" : "mutate", statement.target));
            }
            case "NOTE":
            case "WAIT":
                return [];
            case "SEND": {
                if (statement.target === null) return [];
                const scheme = schemeNameOf(statement.target);
                const control = scheme === "session" || (scheme !== null && this.#executors()?.entry(scheme, workspaceId) !== undefined);
                return demands(describe("SEND", control ? "control" : "mutate", statement.target));
            }
        }
    }

    // {§owner-interaction-ring} The interaction capabilities this session's owner would not receive.
    async #unreceived(workspaceId: number, sessionId: number): Promise<ReadonlyArray<{ readonly runtime: string; readonly tool?: string }>> {
        const executors = this.#executors();
        const candidates: Array<{ readonly runtime: string; readonly tool?: string; readonly name: string }> = [];
        for (const runtime of executors?.availableRuntimes(workspaceId) ?? []) {
            if (this.#runtimeDescriptor(runtime, null, workspaceId).access === "interact") {
                candidates.push({ runtime, name: runtime });
                continue;
            }
            for (const registered of executors?.toolRegistry(runtime, workspaceId)?.tools ?? []) {
                if (this.#runtimeDescriptor(runtime, registered.target, workspaceId).access === "interact") {
                    candidates.push({ runtime, tool: registered.target, name: registered.target });
                }
            }
        }
        if (candidates.length === 0) return [];
        const owner = await SessionOwners.read(this.#db, sessionId);
        return candidates
            .filter(({ name }) => !SessionOwners.receives(owner, name))
            .map(({ runtime, tool }) => ({ runtime, ...(tool === undefined ? {} : { tool }) }));
    }

    // {§owner-interaction-ring} An asking session adds its owner's ring inside the shared cascade.
    async layers(workspaceId: number, sessionId?: number): Promise<readonly CapabilityLayer[]> {
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        const unreceived = sessionId === undefined ? [] : await this.#unreceived(workspaceId, sessionId);
        return unreceived.length === 0 ? layers : [...layers, {
            scope: "owner",
            policy: { deny: unreceived.map(({ runtime, tool }) => ({ access: "interact", runtime, ...(tool === undefined ? {} : { tool }) })) },
        }];
    }

    // {§owner-interaction-ring} The session's face of the shared reserved tree: the documents of a
    // runtime or tool its owner ring denies are absent.
    async referenceVisibility(workspaceId: number, sessionId: number): Promise<(pathname: string) => boolean> {
        const executors = this.#executors();
        const unreceived = await this.#unreceived(workspaceId, sessionId);
        const hidden = unreceived.map(({ runtime, tool }) => {
            const resourcesPath = executors?.entry(runtime, workspaceId)?.resourcesPath;
            if (tool === undefined) return ToolResources.documents(runtime, resourcesPath);
            const tools = executors?.toolRegistry(runtime, workspaceId)?.tools ?? [];
            const allToolsUnreceived = tools.length > 0 && tools.every((candidate) =>
                unreceived.some((denied) => denied.runtime === runtime && denied.tool === candidate.target));
            if (allToolsUnreceived) return ToolResources.documents(runtime, resourcesPath);
            const toolDoc = ToolResources.toolDocumentPath(runtime, tool, resourcesPath);
            return (pathname: string) => pathname === toolDoc;
        });
        return (pathname) => !hidden.some((documents) => documents(pathname));
    }

    async denial(
        statement: PlurnkStatement,
        workspaceId: number,
        writer: WriterTier = "model",
        resolveResource?: (target: ParsedPath) => Promise<SchemeManifest | undefined>,
        sessionId?: number,
    ): Promise<CapabilityDenial | null> {
        const manifests = new Map<ParsedPath, SchemeManifest | undefined>();
        if (resolveResource !== undefined) {
            // Derive read operands through the same operation-demand mapping;
            // resolve their backend manifests without borrowing owner policy.
            this.descriptors(statement, workspaceId, writer, (target) => {
                manifests.set(target, undefined);
                return undefined;
            });
            for (const target of manifests.keys()) manifests.set(target, await resolveResource(target));
        }
        const descriptors = this.descriptors(statement, workspaceId, writer,
            resolveResource === undefined ? undefined : (target) => manifests.get(target));
        // The owner ring subtracts only interaction; other demands never read the owner.
        const asker = descriptors.some(({ access }) => access === "interact") ? sessionId : undefined;
        const layers = await this.layers(workspaceId, asker);
        for (const descriptor of descriptors) {
            const denied = layers.find((layer) => !CapabilityAdmission.allows(layer.policy, descriptor));
            if (denied !== undefined) return { descriptor, scope: denied.scope };
        }
        return null;
    }

    async projection(workspaceId: number): Promise<CapabilityProjection> {
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        const policy = (scope: (typeof layers)[number]["scope"]): CapabilityPolicy => {
            const layer = layers.find((candidate) => candidate.scope === scope);
            if (layer === undefined) throw new Error(`Capability policy layer '${scope}' is missing.`);
            return layer.policy;
        };
        return {
            service: policy("service"),
            workspace: policy("workspace"),
            effective: CapabilityAdmission.intersect(layers.map((layer) => layer.policy)),
        };
    }

    allowsAcross(
        statement: PlurnkStatement,
        workspaceId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        return this.descriptors(statement, workspaceId)
            .every((descriptor) => CapabilityAdmission.allowsAcross(policies, descriptor));
    }

    // {§schemes-directory} References describe the whole scheme; any admitted
    // resource capability makes that reference useful. Examples are not policy.
    allowsSchemeAcross(
        scheme: string,
        workspaceId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        const manifest = this.#schemes.manifestFor(scheme, workspaceId);
        const handler = this.#schemes.get(scheme, workspaceId);
        if (manifest?.modelVisible !== true || handler === undefined) return false;
        const allows = (operation: CapabilityDescriptor["operation"], access: CapabilityDescriptor["access"]): boolean =>
            CapabilityAdmission.allowsAcross(policies, this.#schemeDescriptor(operation, access, scheme, workspaceId));
        const entryBearing = manifest.category === "data";
        const readable = entryBearing || coreRepresentationProvider(handler) !== null;
        // An execution observing this scheme is keyed by its runtime: the registered runtimes when a
        // registry is present, else the runtimes the policies themselves name.
        const runtimes = (this.#executors()?.availableRuntimes(workspaceId)
            ?? policies.flatMap((policy) => [...(policy.only ?? []), ...(policy.deny ?? [])]).map((selector) => selector.operation)).filter(isExecutionOp);
        const observers: readonly CapabilityDescriptor["operation"][] = ["READ", "COPY", "BARE", ...runtimes];
        if (readable && observers.some((operation) => allows(operation, "observe"))) return true;
        if ((entryBearing || typeof handler.find === "function") && allows("FIND", "observe")) return true;
        if (!manifest.writableBy.includes("model")) return false;
        if (entryBearing && allows("COPY", "mutate")) return true;
        if (typeof handler.editBatch === "function" && allows("EDIT", "mutate")) return true;
        const access = scheme === "session" ? "control" : "mutate";
        if (typeof handler.send === "function" && allows("SEND", access)) return true;
        if (entryBearing || typeof handler.kill === "function") {
            if (scheme === "log" || allows("KILL", access)) return true;
            if (readable && allows("MOVE", "observe") && allows("MOVE", "mutate")) return true;
        }
        return scheme === "session" && (allows("WORK", "control") || allows("FORK", "control"));
    }

    #schemeDescriptor(
        operation: CapabilityDescriptor["operation"],
        access: CapabilityDescriptor["access"],
        scheme: string,
        workspaceId: number,
    ): CapabilityDescriptor {
        return { operation, access, scheme, traits: this.#traits(scheme, workspaceId) };
    }

    async allowsRuntime(
        runtime: string,
        tool: string | null,
        workspaceId: number,
    ): Promise<boolean> {
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        return CapabilityAdmission.allowsAcross(
            layers.map((layer) => layer.policy),
            this.#runtimeDescriptor(runtime, tool, workspaceId),
        );
    }

    allowsRuntimeAcross(
        runtime: string,
        tool: string | null,
        workspaceId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        return CapabilityAdmission.allowsAcross(policies, this.#runtimeDescriptor(runtime, tool, workspaceId));
    }

    #runtimeDescriptor(runtime: string, tool: string | null, workspaceId: number): CapabilityDescriptor {
        if (!isLowercase(runtime)) throw new TypeError(`'${runtime}' names no runtime: runtime tags and family names are lowercase.`);
        const toolTraits = tool === null
            ? []
            : (this.#executors()?.toolRegistry(runtime, workspaceId)?.tools.find((candidate) => candidate.target === tool)?.traits ?? []);
        const traits = [...new Set([
            ...this.#traits("exec", workspaceId),
            ...this.#traits(runtime, workspaceId),
            ...toolTraits,
        ])].toSorted();
        return {
            operation: runtime,
            scheme: "exec",
            runtime,
            access: traits.includes("interaction") ? "interact" : "execute",
            traits,
            ...(tool === null ? {} : { tool }),
        };
    }

    static effective(policies: readonly CapabilityPolicy[]): CapabilityPolicy {
        return CapabilityAdmission.intersect(policies);
    }

    #traits(scheme: string | null, workspaceId: number): string[] {
        if (scheme === null) return [];
        return [...(this.#schemes.manifestFor(scheme, workspaceId)?.traits ?? [])].toSorted();
    }

}
