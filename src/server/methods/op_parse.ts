import type MethodRegistry from "../MethodRegistry.ts";
import Dsl from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    text: string;
}

export default class OpParseMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.parse", {
            handler: async (params, ctx) => {
                const p = (params ?? {}) as Params;
                if (typeof p.text !== "string" || p.text.length === 0) throw new Error("op.parse requires params.text: string");
                const statements = Dsl.parseAllStatements(p.text);
                const results = [];
                for (const statement of statements) {
                    results.push(await DispatchAsClient.dispatch(ctx, statement));
                }
                return { results };
            },
            description: "Parse raw DSL text via the grammar parser; dispatch each statement; return results.",
            params: {
                text: "string — DSL text (one or more HEREDOC statements)",
            },
            requiresInit: true,
        });
    }
}
