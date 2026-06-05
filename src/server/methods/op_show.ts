import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import Dsl from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    target: string;
    matcher?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export default class OpShowMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.show", {
            handler: async (params, ctx) => {
                const p = (params ?? {}) as Params;
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("op.show requires params.target: string");
                const statement = Dsl.buildShow(p);
                return DispatchAsClient.dispatch(ctx, statement);
            },
            description: "SHOW — promote an entry to the active index.",
            params: {
                target: "string — entry path",
                matcher: "string? — body matcher (glob/regex/xpath/jsonpath)",
                tags: "string[]? — tag filter",
                lineRange: "LineMarker? — result range",
            },
            requiresInit: true,
        });
    }
}
