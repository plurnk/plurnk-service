import type MethodRegistry from "../MethodRegistry.ts";
import VersionInfo from "../version-info.ts";

export default class DiscoverMethod {
    static register(registry: MethodRegistry): void {
        // discover returns the protocol version + the method/notification catalog, plus
        // versions (installed self-report + best-effort cached npm poll) for the client's
        // update notifier — the daemon polls so a one-shot CLI does zero registry IO. §discovery
        registry.registerMethod("discover", {
            handler: async (_params, ctx) => ({ ...ctx.registry.catalog(), versions: await VersionInfo.get() }),
            description: "Returns the protocol version, the method/notification catalog, and versions (service installed + best-effort npm-latest for service & client).",
        });
    }
}
