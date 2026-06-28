import type MethodRegistry from "../MethodRegistry.ts";
import Dsl from "../dsl.ts";
import Envelope from "../envelope.ts";

interface Params {
    text: string;
}

export default class OpLookMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.look", {
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.text !== "string" || p.text.length === 0) throw new Error("op.look requires params.text: string");
                if (ctx.session === null) throw new Error("op.look requires an attached session");
                const statement = Dsl.parseSingleStatement(p.text);
                if (statement.op !== "READ") throw new Error(`op.look resolves READ only; got ${statement.op}`);
                const { sessionId, runId } = ctx.session;
                // log:///<L>/<T>/<S> coordinates resolve run-relative; the client loop
                // is the requesting connection's run context. No turn/log row is minted.
                if (ctx.session.clientLoopId === null) ctx.session.clientLoopId = await Envelope.ensureClientLoop(ctx.db, runId);
                return ctx.engine.look({ statement, sessionId, runId, loopId: ctx.session.clientLoopId });
            },
            description: "LOOK — resolve a READ's target via the full scheme resolver and return its content, writing NO log entry. The client's off-run inspection primitive: forward the LOOK statement with the op token rewritten LOOK→READ; the resolution is invisible to the model.",
            params: {
                text: "string — a single READ DSL statement (the client's LOOK, op token rewritten LOOK→READ)",
            },
            requiresInit: true,
        });
    }
}
