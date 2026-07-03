import type MethodRegistry from "../MethodRegistry.ts";
import Dsl from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export default class OpExecMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.exec", {
            longRunning: true, // a proposal-capable write pauses on human review — exempt from PLURNK_SERVICE_RPC_TIMEOUT (§operator-config-rpc-timeout)
            handler: async (params, ctx) => {
                const p = params as Params;
                const statement = Dsl.buildExec(p);
                return DispatchAsClient.dispatch(ctx, statement);
            },
            description: "EXEC — invoke a subprocess.",
            params: {
                cwd: "string? — working directory",
                runtime: "string? — runtime tag (sh, node, python, etc.)",
                command: "string? — command or code",
            },
            requiresInit: true,
        });
    }
}
