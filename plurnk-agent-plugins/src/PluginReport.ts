export type PluginOutcome = "rejected" | "invalid" | "skipped" | "ignored" | "shadowed";

// {§agent-plugins-reports} One finding: the plugin directory, the path within it, the section, and what the loader did.
export interface PluginReport {
    readonly root: string;
    readonly path: string;
    readonly section: string;
    readonly outcome: PluginOutcome;
    readonly message: string;
}

export type { Finding } from "@plurnk/plurnk-meta/agent-plugin";
// Only filesystem failures cross the installation boundary as reports; programming errors still throw.
export const isFileError = (cause: unknown): cause is NodeJS.ErrnoException => cause instanceof Error
    && typeof (cause as NodeJS.ErrnoException).code === "string"
    && typeof (cause as NodeJS.ErrnoException).syscall === "string";
