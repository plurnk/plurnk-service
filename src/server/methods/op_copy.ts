import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildCopy } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    source: string;
    destination: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.copy", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.source !== "string" || p.source.length === 0) throw new Error("op.copy requires params.source: string");
            if (typeof p.destination !== "string" || p.destination.length === 0) throw new Error("op.copy requires params.destination: string");
            const statement = buildCopy(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "COPY — clone an entry to a new path.",
        params: {
            source: "string — source entry path",
            destination: "string — destination entry path",
            tags: "string[]? — tag set on the destination (replaces source tags if provided)",
            lineRange: "LineMarker? — line range to copy",
        },
        requiresInit: true,
    });
};
