import { OutboundModule as A2aOutboundModule, validateConfiguration as validateA2a } from "@plurnk/plurnk-a2a";
import { Module as McpModule, validateConfiguration as validateMcp } from "@plurnk/plurnk-mcp";
import { Module as ScheduleModule, validateConfiguration as validateSchedule } from "@plurnk/plurnk-schedule";
import type Daemon from "./Daemon.ts";

// {§service-worker-composition} — listeners and host hooks remain launcher-owned.
export default class ServiceModules {
    static validateConfiguration(): void {
        validateMcp();
        validateA2a();
        validateSchedule();
    }

    static registerWorkspaceCapabilities(daemon: Pick<Daemon, "registerModule">): void {
        ServiceModules.validateConfiguration();
        daemon.registerModule(McpModule.init());
        daemon.registerModule(A2aOutboundModule.init());
        daemon.registerModule(ScheduleModule.init());
    }
}
