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

export default class OpFoldMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.fold", {
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("op.fold requires params.target: string");
                const statement = Dsl.buildFold(p);
                return DispatchAsClient.dispatch(ctx, statement);
            },
            description: "FOLD — collapse a log row to its path (drop its body from the render).",
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
