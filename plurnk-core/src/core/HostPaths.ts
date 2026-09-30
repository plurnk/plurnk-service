import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type HostPathsOptions = {
    readonly env?: NodeJS.ProcessEnv;
    readonly home?: string;
};

type XdgVariable = "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME" | "XDG_RUNTIME_DIR";

const APP_DIRECTORY = "plurnk";

// {§host-path-layout} — one host-boundary resolver. Package-relative assets
// remain owned by ../Paths.ts; this class owns only user and runtime locations.
export default class HostPaths {
    readonly home: string;
    // {§state-root} — a private daemon's root for everything it writes; null is the XDG layout.
    readonly stateRoot: string | null;
    readonly configHome: string;
    readonly dataHome: string;
    readonly stateHome: string;
    readonly cacheHome: string;
    readonly runtimeHome: string | null;
    readonly invalidXdg: readonly XdgVariable[];

    readonly configDir: string;
    readonly dataDir: string;
    readonly stateDir: string;
    readonly cacheDir: string;
    readonly runtimeDir: string | null;
    readonly configFile: string;
    readonly policyFile: string;
    readonly databaseFile: string;
    readonly globalAgentsDir: string;
    readonly plurnkSkillsDir: string;
    readonly globalSkillsDir: string;
    readonly plurnkPluginsDir: string;
    readonly globalPluginsDir: string;
    readonly legacyDir: string;

    constructor({ env = process.env, home = homedir() }: HostPathsOptions = {}) {
        this.home = resolve(home);
        const invalid: XdgVariable[] = [];
        const base = (name: XdgVariable, fallback: string): string => {
            const value = env[name];
            if (value === undefined || value.length === 0) return resolve(this.home, fallback);
            if (isAbsolute(value)) return resolve(value);
            invalid.push(name);
            return resolve(this.home, fallback);
        };

        const root = env.PLURNK_SERVICE_STATE_ROOT;
        if (root === undefined || root.length === 0) {
            this.stateRoot = null;
        } else {
            const expanded = this.expandUserPath(root);
            if (!isAbsolute(expanded)) {
                throw new Error(`PLURNK_SERVICE_STATE_ROOT must be an absolute path (a leading ~/ expands); got ${JSON.stringify(root)}`);
            }
            this.stateRoot = resolve(expanded);
        }

        // Configuration is operator input and is never moved under a state root.
        this.configHome = base("XDG_CONFIG_HOME", ".config");
        if (this.stateRoot === null) {
            this.dataHome = base("XDG_DATA_HOME", join(".local", "share"));
            this.stateHome = base("XDG_STATE_HOME", join(".local", "state"));
            this.cacheHome = base("XDG_CACHE_HOME", ".cache");
            const runtime = env.XDG_RUNTIME_DIR;
            if (runtime === undefined || runtime.length === 0) {
                this.runtimeHome = null;
            } else if (isAbsolute(runtime)) {
                this.runtimeHome = resolve(runtime);
            } else {
                invalid.push("XDG_RUNTIME_DIR");
                this.runtimeHome = null;
            }
        } else {
            this.dataHome = join(this.stateRoot, "data");
            this.stateHome = join(this.stateRoot, "state");
            this.cacheHome = join(this.stateRoot, "cache");
            this.runtimeHome = join(this.stateRoot, "runtime");
        }
        this.invalidXdg = Object.freeze(invalid);

        this.configDir = join(this.configHome, APP_DIRECTORY);
        this.dataDir = join(this.dataHome, APP_DIRECTORY);
        this.stateDir = join(this.stateHome, APP_DIRECTORY);
        this.cacheDir = join(this.cacheHome, APP_DIRECTORY);
        this.runtimeDir = this.runtimeHome === null ? null : join(this.runtimeHome, APP_DIRECTORY);
        this.configFile = join(this.configDir, ".env");
        this.policyFile = join(this.configDir, "AGENTS.md");
        this.databaseFile = join(this.dataDir, "plurnk.db");
        // {§skills-functionality} — plurnk-only skills are configuration; the global
        // root is shared across agents and rooted independently of application
        // config and of any state root: a private daemon still reads the user's skills.
        this.plurnkSkillsDir = join(this.configDir, "skills");
        this.globalAgentsDir = join(this.home, ".agents");
        this.globalSkillsDir = join(this.globalAgentsDir, "skills");
        // {§agent-plugins-hosting} — plugins are configuration, found like skills; their data is data.
        this.plurnkPluginsDir = join(this.configDir, "plugins");
        this.globalPluginsDir = join(this.globalAgentsDir, "plugins");
        this.legacyDir = join(this.home, ".plurnk");
    }

    projectSkillsDir(projectRoot: string): string {
        return join(this.projectAgentsDir(projectRoot), "skills");
    }

    projectPluginsDir(projectRoot: string): string {
        return join(this.projectAgentsDir(projectRoot), "plugins");
    }

    projectAgentsDir(projectRoot: string): string {
        return join(resolve(projectRoot), ".agents");
    }

    // {§agent-plugins-hosting} — one plugin's PLUGIN_DATA, kept across its updates.
    pluginDataDir(pluginName: string): string {
        return join(this.dataDir, "plugins", pluginName);
    }

    expandUserPath(value: string): string {
        if (value === "~") return this.home;
        return value.startsWith("~/") ? resolve(this.home, value.slice(2)) : value;
    }
}
