export type PluginOutcome = "rejected" | "invalid" | "skipped" | "ignored" | "shadowed";

// {§agent-plugins-reports} One finding: the plugin directory, the path within it, the section, and what the loader did.
export interface PluginReport {
    readonly root: string;
    readonly path: string;
    readonly section: string;
    readonly outcome: PluginOutcome;
    readonly message: string;
}

export interface Finding {
    readonly section: string;
    readonly message: string;
}
