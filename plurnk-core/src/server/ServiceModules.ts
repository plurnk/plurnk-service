import { OutboundModule as A2aOutboundModule } from "@plurnk/plurnk-a2a";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import type Daemon from "./Daemon.ts";

// {§service-worker-composition} — listeners and host hooks remain launcher-owned.
export default class ServiceModules {
    static registerWorkspaceCapabilities(daemon: Pick<Daemon, "registerModule">): void {
        daemon.registerModule(McpModule.init());
        daemon.registerModule(A2aOutboundModule.init());
    }
}
