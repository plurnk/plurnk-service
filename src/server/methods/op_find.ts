import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildFind } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    scope: string;
    matcher?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.find", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.scope !== "string" || p.scope.length === 0) throw new Error("op.find requires params.scope: string");
            const statement = buildFind(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "FIND — search within a scope by tags and/or matcher.",
        params: {
            scope: "string — path-scope (e.g. known://)",
            matcher: "string? — body matcher (glob/regex/xpath/jsonpath; dialect determined by leading chars)",
            tags: "string[]? — tag filter",
            lineRange: "LineMarker? — result range",
        },
        requiresInit: true,
    });
};
