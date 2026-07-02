import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import Dsl from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    source: string;
    destination?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export default class OpMoveMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.move", {
            longRunning: true, // a proposal-capable write pauses on human review — exempt from PLURNK_RPC_TIMEOUT (§operator-config-rpc-timeout)
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.source !== "string" || p.source.length === 0) throw new Error("op.move requires params.source: string");
                const statement = Dsl.buildMove(p);
                return DispatchAsClient.dispatch(ctx, statement);
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
    }
}
