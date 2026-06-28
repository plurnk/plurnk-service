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
                const p = params as Params;
                if (typeof p.text !== "string" || p.text.length === 0) throw new Error("op.parse requires params.text: string");
                const { statements, errors } = Dsl.parseAllStatements(p.text);
                const results: Array<{ status: number; [k: string]: unknown }> = [];
                for (const statement of statements) {
                    results.push(await DispatchAsClient.dispatch(ctx, statement));
                }
                // Surface parse failures (error items + an unterminated tail) as 400 results — the
                // client has no model row to point at, so the locator rides the result itself. §methods
                for (const e of errors) {
                    results.push({ status: 400, error: e.message, position: { type: "content-offset", line: e.line, column: e.column } });
                }
                return { results };
            },
            description: "Parse raw DSL text via the grammar parser; dispatch each statement; return a result per statement, plus a 400 result per parse failure (error or unterminated tail) with its line:col.",
            params: {
                text: "string — DSL text (one or more HEREDOC statements)",
            },
            requiresInit: true,
        });
    }
}
