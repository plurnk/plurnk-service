import { OutboundModule as A2aOutboundModule, validateConfiguration as validateA2a } from "@plurnk/plurnk-a2a";
import { configuredDefinitions, validateConfiguration as validateMcp } from "@plurnk/plurnk-mcp";
import { validateConfiguration as validateSchedule } from "@plurnk/plurnk-schedule";
import type Daemon from "./Daemon.ts";

// {§service-worker-composition} — listeners and host hooks remain launcher-owned.
export default class ServiceModules {
    static async validateConfiguration(directories: readonly string[]): Promise<void> {
        validateMcp();
        await configuredDefinitions(directories);
        validateA2a();
        validateSchedule();
    }

    static registerWorkspaceCapabilities(daemon: Pick<Daemon, "registerModule">): void {
        daemon.registerModule(A2aOutboundModule.init(), "@plurnk/plurnk-a2a");
    }
}
