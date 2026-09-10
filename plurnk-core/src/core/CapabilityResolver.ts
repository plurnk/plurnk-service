import {
    CapabilityAdmission,
    type CapabilityDescriptor,
    type CapabilityPolicy,
    type CapabilityProjection,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import CapabilityPolicies from "./CapabilityPolicies.ts";
import { isGeneratedPathname, schemeNameOf } from "./plurnk-uri.ts";
import { execRouteOf } from "../schemes/exec-runtime.ts";
import { coreRepresentationProvider } from "./CoreSchemeServices.ts";
import type { SchemeHandler, SchemeManifest, WriterTier } from "@plurnk/plurnk-schemes";

type CapabilityScope = "service" | "workspace";

export interface CapabilityDenial {
    readonly descriptor: CapabilityDescriptor;
    readonly scope: CapabilityScope;
}

export default class CapabilityResolver {
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
            // {§worker-generated-subtree}: owned-state mutation is intrinsic;
            // observation and unrelated effects retain their independent demands.
            if (writer === "_plurnk" && access !== "observe" && scheme === "worker"
                && target?.kind === "url" && isGeneratedPathname(target.pathname)) return [];
            return [this.#schemeDescriptor(operation, access, scheme, workspaceId)];
        };
        const demands = (...items: readonly (CapabilityDescriptor[] | null)[]): CapabilityDescriptor[] =>
            items.flatMap((item) => item ?? []);
        const composedDemands = (...items: readonly (CapabilityDescriptor[] | null)[]): CapabilityDescriptor[] =>
            items.every((item) => item !== null)
                ? demands(...items)
                : [];

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
                const control = scheme === "worker" || (scheme !== null && this.#executors()?.entry(scheme, workspaceId) !== undefined);
                return demands(describe("KILL", control ? "control" : "mutate", statement.target));
            }
            case "TASK":
                return [];
            case "SEND": {
                if (statement.target === null) return [];
                const scheme = schemeNameOf(statement.target);
                const control = scheme === "worker" || (scheme !== null && this.#executors()?.entry(scheme, workspaceId) !== undefined);
                return demands(describe("SEND", control ? "control" : "mutate", statement.target));
            }
            case "EXEC": {
                const executors = this.#executors();
                const route = execRouteOf(statement);
                const runtime = route.runtime;
                const entry = executors?.entry(runtime, workspaceId);
                if (entry === undefined) return [];
                const registry = executors?.toolRegistry(runtime, workspaceId) ?? null;
                const target = route.target === null ? null : route.target.raw;
                const tool = registry?.tools.find((candidate) => candidate.target === target)?.target ?? null;
                // A finite tool registry owns exact target resolution. Missing
                // and unknown targets must reach that owner as ordinary
                // tool-required/tool-not-enabled failures; policy cannot
                // misrepresent absence as denied authority.
                if (registry !== null && tool === null) return [];
                const demands: CapabilityDescriptor[] = [this.#runtimeDescriptor(runtime, tool, workspaceId)];
                const targetKind = entry.invocation.target?.kind;
                const execTarget = route.target;
                if ((targetKind === "resource" || targetKind === "script") && execTarget === null) {
                    if (entry.invocation.target?.required === true) return [];
                } else if ((targetKind === "resource" || targetKind === "script") && execTarget !== null) {
                    const targetDemand = describe("EXEC", "observe", execTarget);
                    if (targetDemand === null) return [];
                    demands.push(...targetDemand);
                }
                return demands;
            }
        }
    }

    async denial(
        statement: PlurnkStatement,
        workspaceId: number,
        writer: WriterTier = "model",
        resolveResource?: (target: ParsedPath) => Promise<SchemeManifest | undefined>,
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
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId);
        for (const descriptor of this.descriptors(statement, workspaceId, writer,
            resolveResource === undefined ? undefined : (target) => manifests.get(target))) {
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
        const handler = this.#schemes.get(scheme, workspaceId) as SchemeHandler | undefined;
        if (manifest?.modelVisible !== true || handler === undefined) return false;
        const allows = (operation: CapabilityDescriptor["operation"], access: CapabilityDescriptor["access"]): boolean =>
            CapabilityAdmission.allowsAcross(policies, this.#schemeDescriptor(operation, access, scheme, workspaceId));
        const entryBearing = manifest.category === "data";
        const readable = entryBearing || coreRepresentationProvider(handler) !== null;
        if (readable && (["READ", "COPY", "EXEC", "BARE"] as const).some((operation) => allows(operation, "observe"))) return true;
        if ((entryBearing || typeof handler.find === "function") && allows("FIND", "observe")) return true;
        if (!manifest.writableBy.includes("model")) return false;
        if (entryBearing && allows("COPY", "mutate")) return true;
        if (typeof handler.editBatch === "function" && allows("EDIT", "mutate")) return true;
        const access = scheme === "worker" ? "control" : "mutate";
        if (typeof handler.send === "function" && allows("SEND", access)) return true;
        if (entryBearing || typeof handler.kill === "function") {
            if (scheme === "log" || allows("KILL", access)) return true;
            if (readable && allows("MOVE", "observe") && allows("MOVE", "mutate")) return true;
        }
        return scheme === "worker" && (allows("WORK", "control") || allows("FORK", "control"));
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
        const traits = [...new Set([
            ...this.#traits("exec", workspaceId),
            ...this.#traits(runtime, workspaceId),
        ])].toSorted();
        return {
            operation: "EXEC",
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
