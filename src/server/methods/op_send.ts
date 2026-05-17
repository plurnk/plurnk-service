import type MethodRegistry from "../MethodRegistry.ts";
import { buildSend } from "../dsl.ts";
import { dispatchAsClient } from "./_dispatchAsClient.ts";

interface Params {
    status: number;
    recipient?: string;
    body?: string;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("op.send", {
        handler: async (params, ctx) => {
            const p = (params ?? {}) as Params;
            if (typeof p.status !== "number") throw new Error("op.send requires params.status: number");
            const statement = buildSend(p);
            return dispatchAsClient(ctx, statement);
        },
        description: "SEND — talk to a recipient or broadcast a terminal status.",
        params: {
            status: "number — HTTP status code (200 terminal, 410 delete, 499 cancel, etc.)",
            recipient: "string? — recipient URI (omit for broadcast)",
            body: "string? — message body",
        },
        requiresInit: true,
    });
};
