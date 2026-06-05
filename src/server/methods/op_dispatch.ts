import type MethodRegistry from "../MethodRegistry.ts";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    statement: PlurnkStatement;
}

export default class OpDispatchMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.dispatch", {
            handler: async (params, ctx) => {
                const p = (params ?? {}) as Params;
                if (p.statement === undefined || p.statement === null) throw new Error("op.dispatch requires params.statement: PlurnkStatement");
                return DispatchAsClient.dispatch(ctx, p.statement);
            },
            description: "Low-level: dispatch a parsed PlurnkStatement AST directly. Use the op.* methods for clean-shape ergonomics.",
            params: {
                statement: "PlurnkStatement — parsed AST per grammar schema",
            },
            requiresInit: true,
        });
    }
}
