import {
    CapabilityAdmission,
    PlurnkParser,
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
import { schemeNameOf } from "./plurnk-uri.ts";

export type CapabilityScope = "service" | "workspace" | "worker-bound" | "worker" | "loop";

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

    descriptors(statement: PlurnkStatement, workerId: number): readonly CapabilityDescriptor[] {
        const describe = (
            operation: CapabilityDescriptor["operation"],
            access: CapabilityDescriptor["access"],
            target: ParsedPath | null,
        ): CapabilityDescriptor | null => {
            const scheme = schemeNameOf(target);
            if (scheme === null || !this.#schemes.has(scheme, workerId)) return null;
            return {
                operation,
                access,
                traits: this.#traits(scheme, workerId),
                scheme,
            };
        };
        const demands = (...items: readonly (CapabilityDescriptor | null)[]): CapabilityDescriptor[] =>
            items.filter((item): item is CapabilityDescriptor => item !== null);
        const composedDemands = (...items: readonly (CapabilityDescriptor | null)[]): CapabilityDescriptor[] =>
            items.every((item) => item !== null)
                ? items as CapabilityDescriptor[]
                : [];

        switch (statement.op) {
            case "PLAN":
            case "OPEN":
            case "FOLD":
                return [];
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
                return [{ operation: "BARE", access: "execute", traits: [] }];
            case "KILL": {
                const scheme = schemeNameOf(statement.target);
                if (scheme === "log") return [];
                return demands(describe("KILL", scheme === "worker" ? "control" : "mutate", statement.target));
            }
            case "SEND": {
                if (statement.target === null) return [];
                const scheme = schemeNameOf(statement.target);
                return demands(describe("SEND", scheme === "worker" ? "control" : "mutate", statement.target));
            }
            case "EXEC": {
                const runtime = typeof statement.signal === "string" && statement.signal.length > 0
                    ? statement.signal
                    : "sh";
                const executors = this.#executors();
                const entry = executors?.entry(runtime, workerId);
                if (entry === undefined) return [];
                const registry = executors?.toolRegistry(runtime, workerId) ?? null;
                const target = statement.target?.raw ?? null;
                const tool = registry?.tools.find((candidate) => candidate.target === target)?.target ?? null;
                // A finite tool registry owns exact target resolution. Missing
                // and unknown targets must reach that owner as ordinary
                // tool-required/tool-not-enabled failures; policy cannot
                // misrepresent absence as denied authority.
                if (registry !== null && tool === null) return [];
                const demands: CapabilityDescriptor[] = [this.#runtimeDescriptor(runtime, tool, workerId)];
                const targetKind = entry.invocation.target?.kind;
                if (targetKind === "resource" && statement.target === null) {
                    if (entry.invocation.target?.required === true) return [];
                } else if (targetKind === "resource" && statement.target !== null) {
                    const targetDemand = describe("EXEC", "observe", statement.target);
                    if (targetDemand === null) return [];
                    demands.push(targetDemand);
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
    ): Promise<CapabilityDenial | null> {
        const policy = await LoopPolicyReader.read(this.#db, loopId);
        const layers = await CapabilityPolicies.layers(this.#db, workspaceId, workerId, policy);
        for (const descriptor of this.descriptors(statement, workerId)) {
            const denied = layers.find((layer) => !CapabilityAdmission.allows(layer.policy, descriptor));
            if (denied !== undefined) return { descriptor, scope: denied.scope };
        }
        return null;
    }

    async allows(
        statement: PlurnkStatement,
        workspaceId: number,
        workerId: number,
        loopId: number,
    ): Promise<boolean> {
        return await this.denial(statement, workspaceId, workerId, loopId) === null;
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

    async allowsExample(
        source: string,
        workspaceId: number,
        workerId: number,
        loopId: number,
    ): Promise<boolean> {
        const parsed = PlurnkParser.parseStatements(source);
        const errors = parsed.items.filter((item) => item.kind === "error");
        if (errors.length > 0 || parsed.unparsedTail !== undefined) {
            throw new Error("Registered capability example is not valid PLURNK syntax.");
        }
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        for (const statement of statements) {
            if (!(await this.allows(statement, workspaceId, workerId, loopId))) return false;
        }
        return true;
    }

    allowsExampleAcross(
        source: string,
        workerId: number,
        policies: readonly CapabilityPolicy[],
    ): boolean {
        const parsed = PlurnkParser.parseStatements(source);
        const errors = parsed.items.filter((item) => item.kind === "error");
        if (errors.length > 0 || parsed.unparsedTail !== undefined) {
            throw new Error("Registered capability example is not valid PLURNK syntax.");
        }
        return parsed.items.every((item) => item.kind !== "statement"
            || this.allowsAcross(item.statement, workerId, policies));
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
