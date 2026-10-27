import { configuredDefinitions, validateConfiguration as validateMcp } from "@plurnk/plurnk-mcp";
import { validateConfiguration as validateSchedule } from "@plurnk/plurnk-schedule";

// {§observability-boundary} — the offline check validates the default modules' own settings; the
// modules themselves load by discovery ({§module-lifecycle}).
export default class ServiceModules {
    static async validateConfiguration(directories: readonly string[]): Promise<void> {
        validateMcp();
        await configuredDefinitions(directories);
        validateSchedule();
    }
}
