import type MethodRegistry from "../MethodRegistry.ts";

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("ping", {
        handler: async () => ({}),
        description: "Liveness check. Returns an empty object.",
    });
};
