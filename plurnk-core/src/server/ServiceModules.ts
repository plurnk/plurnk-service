import { validateConfiguration as validateA2a } from "@plurnk/plurnk-a2a";
import { configuredDefinitions, validateConfiguration as validateMcp } from "@plurnk/plurnk-mcp";
import { validateConfiguration as validateSchedule } from "@plurnk/plurnk-schedule";

// {§service-worker-composition} — the offline check validates the default modules' own settings; the
// modules themselves load by discovery ({§module-discovery}).
export default class ServiceModules {
    static async validateConfiguration(directories: readonly string[]): Promise<void> {
        validateMcp();
        await configuredDefinitions(directories);
        validateA2a();
        validateSchedule();
    }
}
