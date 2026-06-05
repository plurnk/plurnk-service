import type MethodRegistry from "../MethodRegistry.ts";
import { buildExec } from "../dsl.ts";
import DispatchAsClient from "./_dispatchAsClient.ts";

interface Params {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export default class OpExecMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("op.exec", {
            handler: async (params, ctx) => {
                const p = (params ?? {}) as Params;
                const statement = buildExec(p);
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
