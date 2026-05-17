import type MethodRegistry from "../MethodRegistry.ts";
import { parseAllStatements } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    text: string;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.parse", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.text !== "string" || p.text.length === 0) throw new Error("op.parse requires params.text: string");
            const statements = parseAllStatements(p.text);
            const results = [];
            for (const statement of statements) {
                results.push(await dispatchAsClient(ctx, statement));
            }
            return { results };
        },
        description: "Parse raw DSL text via the grammar parser; dispatch each statement; return results.",
        params: {
            text: "string — DSL text (one or more HEREDOC statements)",
        },
        requiresInit: true,
    });
};
