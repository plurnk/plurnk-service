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
import LoopPolicyReader from "./LoopPolicyReader.ts";
import { isGeneratedPathname, schemeNameOf } from "./plurnk-uri.ts";
import { execRouteOf } from "../schemes/exec-runtime.ts";
import { coreRepresentationProvider } from "./CoreSchemeServices.ts";
import type { SchemeHandler, WriterTier } from "@plurnk/plurnk-schemes";

type CapabilityScope = "service" | "workspace" | "worker-bound" | "worker" | "loop";

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

    descriptors(statement: PlurnkStatement, workerId: number, writer: WriterTier = "model"): readonly CapabilityDescriptor[] {
        const describe = (
            operation: CapabilityDescriptor["operation"],
            access: CapabilityDescriptor["access"],
            target: ParsedPath | null,
        ): CapabilityDescriptor[] | null => {
            const scheme = schemeNameOf(target);
            if (scheme === null || !this.#schemes.has(scheme, workerId)) return null;
            // {§worker-generated-subtree}: owned-state mutation is intrinsic;
            // observation and unrelated effects retain their independent demands.
            if (writer === "_plurnk" && access !== "observe" && scheme === "worker"
                && target?.kind === "url" && isGeneratedPathname(target.pathname)) return [];
            return [this.#schemeDescriptor(operation, access, scheme, workerId)];
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
                const control = scheme === "worker" || (scheme !== null && this.#executors()?.entry(scheme, workerId) !== undefined);
                return demands(describe("KILL", control ? "control" : "mutate", statement.target));
            }
            case "TASK":
                return [];
            case "SEND": {
                if (statement.target === null) return [];
                const scheme = schemeNameOf(statement.target);
                const control = scheme === "worker" || (scheme !== null && this.#executors()?.entry(scheme, workerId) !== undefined);
                return demands(describe("SEND", control ? "control" : "mutate", statement.target));
            }
            case "EXEC": {
                const executors = this.#executors();
                const route = execRouteOf(statement);
                const runtime = route.runtime;
                const entry = executors?.entry(runtime, workerId);
                if (entry === undefined) return [];
                const registry = executors?.toolRegistry(runtime, workerId) ?? null;
                const target = route.target === null ? null : route.target.raw;
                const tool = registry?.tools.find((candidate) => candidate.target === target)?.target ?? null;
                // A finite tool registry owns exact target resolution. Missing
                // and unknown targets must reach that owner as ordinary
                // tool-required/tool-not-enabled failures; policy cannot
                // misrepresent absence as denied authority.
                if (registry !== null && tool === null) return [];
                const demands: CapabilityDescriptor[] = [this.#runtimeDescriptor(runtime, tool, workerId)];
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
        workerId: number,
        loopId: number,
        writer: WriterTier = "model",
    ): Promise<CapabilityDenial | null> {
        const policy = await LoopPolicyReader.read(this.#db, loopId);
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId, workerId, policy);
        for (const descriptor of this.descriptors(statement, workerId, writer)) {
            const denied = layers.find((layer) => !CapabilityAdmission.allows(layer.policy, descriptor));
            if (denied !== undefined) return { descriptor, scope: denied.scope };
        }
        return null;
    }

    async projection(workspaceId: number, workerId: number): Promise<CapabilityProjection> {
        const layers = await CapabilityPolicies.workerLayers(this.#db, workspaceId, workerId);
        const policy = (scope: (typeof layers)[number]["scope"]): CapabilityPolicy => {
            const layer = layers.find((candidate) => candidate.scope === scope);
            if (layer === undefined) throw new Error(`Capability policy layer '${scope}' is missing.`);
            return layer.policy;
        };
        return {
            service: policy("service"),
            workspace: policy("workspace"),
            workerBound: policy("worker-bound"),
            worker: policy("worker"),
            effective: CapabilityAdmission.intersect(layers.map((layer) => layer.policy)),
        };
    }

    allowsAcross(
        statement: PlurnkStatement,
        workerId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        return this.descriptors(statement, workerId)
            .every((descriptor) => CapabilityAdmission.allowsAcross(policies, descriptor));
    }

    // {§schemes-directory} References describe the whole scheme; any admitted
    // resource capability makes that reference useful. Examples are not policy.
    allowsSchemeAcross(
        scheme: string,
        workerId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        const manifest = this.#schemes.manifestFor(scheme, workerId);
        const handler = this.#schemes.get(scheme, workerId) as SchemeHandler | undefined;
        if (manifest?.modelVisible !== true || handler === undefined) return false;
        const allows = (operation: CapabilityDescriptor["operation"], access: CapabilityDescriptor["access"]): boolean =>
            CapabilityAdmission.allowsAcross(policies, this.#schemeDescriptor(operation, access, scheme, workerId));
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
        workerId: number,
    ): CapabilityDescriptor {
        return { operation, access, scheme, traits: this.#traits(scheme, workerId) };
    }

    async allowsRuntime(
        runtime: string,
        tool: string | null,
        workspaceId: number,
        workerId: number,
        loopId: number,
    ): Promise<boolean> {
        const policy = await LoopPolicyReader.read(this.#db, loopId);
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId, workerId, policy);
        return CapabilityAdmission.allowsAcross(
            layers.map((layer) => layer.policy),
            this.#runtimeDescriptor(runtime, tool, workerId),
        );
    }

    allowsRuntimeAcross(
        runtime: string,
        tool: string | null,
        workerId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        return CapabilityAdmission.allowsAcross(policies, this.#runtimeDescriptor(runtime, tool, workerId));
    }

    #runtimeDescriptor(runtime: string, tool: string | null, workerId: number): CapabilityDescriptor {
        const traits = [...new Set([
            ...this.#traits("exec", workerId),
            ...this.#traits(runtime, workerId),
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

    #traits(scheme: string | null, workerId: number): string[] {
        if (scheme === null) return [];
        return [...(this.#schemes.manifestFor(scheme, workerId)?.traits ?? [])].toSorted();
    }

}
