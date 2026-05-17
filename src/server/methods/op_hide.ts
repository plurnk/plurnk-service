import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildHide } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    path: string;
    matcher?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.hide", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.path !== "string" || p.path.length === 0) throw new Error("op.hide requires params.path: string");
            const statement = buildHide(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "HIDE — demote an entry from the active index to the archive.",
        params: {
            path: "string — entry path",
            matcher: "string? — body matcher (glob/regex/xpath/jsonpath)",
            tags: "string[]? — tag filter",
            lineRange: "LineMarker? — result range",
        },
        requiresInit: true,
    });
};
