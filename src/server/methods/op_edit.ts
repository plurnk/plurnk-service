import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildEdit } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    path: string;
    content?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.edit", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.path !== "string" || p.path.length === 0) throw new Error("op.edit requires params.path: string");
            const statement = buildEdit(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "EDIT — write or update an entry's body.",
        params: {
            path: "string — entry path (e.g. known://france/capital)",
            content: "string? — entry body (empty/omitted clears)",
            tags: "string[]? — tag set",
            lineRange: "LineMarker? — insertion point or replace range",
        },
        requiresInit: true,
    });
};
