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

export default class OpHideMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.hide", {
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("op.hide requires params.target: string");
                const statement = Dsl.buildHide(p);
                return DispatchAsClient.dispatch(ctx, statement);
            },
            description: "HIDE — collapse a log row to its path (drop its body from the render).",
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
