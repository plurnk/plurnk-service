import type MethodRegistry from "../MethodRegistry.ts";

export default class DiscoverMethod {
    static register(registry: MethodRegistry): void {
        // discover returns the protocol version + the method/notification catalog. §discovery-discover
        registry.registerMethod("discover", {
            handler: async (_params, ctx) => ctx.registry.catalog(),
            description: "Returns the protocol version plus the method and notification catalog.",
        });
    }
}
