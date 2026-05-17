import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildMove } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    source: string;
    destination?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.move", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.source !== "string" || p.source.length === 0) throw new Error("op.move requires params.source: string");
            const statement = buildMove(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "MOVE — relocate an entry (or delete if destination omitted).",
        params: {
            source: "string — source entry path",
            destination: "string? — destination entry path (omit to delete)",
            tags: "string[]? — tag set on the destination",
            lineRange: "LineMarker? — line range to move",
        },
        requiresInit: true,
    });
};
