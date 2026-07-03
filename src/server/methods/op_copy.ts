import type MethodRegistry from "../MethodRegistry.ts";
import type { LineMarker } from "@plurnk/plurnk-grammar";
import Dsl from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    source: string;
    destination: string;
    tags?: string[];
    lineRange?: LineMarker;
}

export default class OpCopyMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.copy", {
            longRunning: true, // a proposal-capable write pauses on human review — exempt from PLURNK_SERVICE_RPC_TIMEOUT (§operator-config-rpc-timeout)
            handler: async (params, ctx) => {
                const p = params as Params;
                if (typeof p.source !== "string" || p.source.length === 0) throw new Error("op.copy requires params.source: string");
                if (typeof p.destination !== "string" || p.destination.length === 0) throw new Error("op.copy requires params.destination: string");
                const statement = Dsl.buildCopy(p);
                return DispatchAsClient.dispatch(ctx, statement);
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
    }
}
