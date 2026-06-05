import type MethodRegistry from "../MethodRegistry.ts";

export default class PingMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("ping", {
            handler: async () => ({}),
            description: "Liveness check. Returns an empty object.",
        });
    }
}
