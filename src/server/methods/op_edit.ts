import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import Dsl from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    target: string;
    content?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export default class OpEditMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.edit", {
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.target !== "string" || p.target.length === 0) throw new Error("op.edit requires params.target: string");
                const statement = Dsl.buildEdit(p);
                return DispatchAsClient.dispatch(ctx, statement);
            },
            description: "EDIT — write or update an entry's body.",
            params: {
                target: "string — entry path (e.g. known://france/capital)",
                content: "string? — entry body (empty/omitted clears)",
                tags: "string[]? — tag set",
                lineRange: "LineMarker? — insertion point or replace range",
            },
            requiresInit: true,
        });
    }
}
