import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildRead } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    path: string;
    matcher?: string;
    lineRange?: LineMarker;
    tags?: string[];
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.read", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.path !== "string" || p.path.length === 0) throw new Error("op.read requires params.path: string");
            const statement = buildRead(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "READ — fetch an entry's body or a slice of it.",
        params: {
            path: "string — entry path",
            matcher: "string? — body matcher (glob/regex/xpath/jsonpath; dialect determined by leading chars)",
            lineRange: "LineMarker? — line range slice",
            tags: "string[]? — tag filter",
        },
        requiresInit: true,
    });
};
