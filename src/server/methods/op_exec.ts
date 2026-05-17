import type MethodRegistry from "../MethodRegistry.ts";
import { buildExec } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.exec", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            const statement = buildExec(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "EXEC — invoke a subprocess.",
        params: {
            cwd: "string? — working directory",
            runtime: "string? — runtime tag (sh, node, python, etc.)",
            command: "string? — command or code",
        },
        requiresInit: true,
    });
};
