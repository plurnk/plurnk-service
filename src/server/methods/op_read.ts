import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import { buildRead } from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    target: string;
    matcher?: string;
    lineRange?: LineMarker;
    tags?: string[];
}

export default class OpReadMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.read", {
            handler: async (params, ctx) => {
                const p = (params ?? {}) as Params;
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("op.read requires params.target: string");
                const statement = buildRead(p);
                return DispatchAsClient.dispatch(ctx, statement);
            },
            description: "READ — fetch an entry's body or a slice of it.",
            params: {
                target: "string — entry path",
                matcher: "string? — body matcher (glob/regex/xpath/jsonpath; dialect determined by leading chars)",
                lineRange: "LineMarker? — line range slice",
                tags: "string[]? — tag filter",
            },
            requiresInit: true,
        });
    }
}
