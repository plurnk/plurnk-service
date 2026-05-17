import type MethodRegistry from "../MethodRegistry.ts";

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("discover", {
        handler: async (_params, ctx) => ctx.registry.catalog(),
        description: "Returns the protocol version plus the method and notification catalog.",
    });
};
