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
    readonly globalSkillsDir: string;
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

        this.configHome = base("XDG_CONFIG_HOME", ".config");
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
        this.invalidXdg = Object.freeze(invalid);

        this.configDir = join(this.configHome, APP_DIRECTORY);
        this.dataDir = join(this.dataHome, APP_DIRECTORY);
        this.stateDir = join(this.stateHome, APP_DIRECTORY);
        this.cacheDir = join(this.cacheHome, APP_DIRECTORY);
        this.runtimeDir = this.runtimeHome === null ? null : join(this.runtimeHome, APP_DIRECTORY);
        this.configFile = join(this.configDir, ".env");
        this.policyFile = join(this.configDir, "AGENTS.md");
        this.databaseFile = join(this.dataDir, "plurnk.db");
        // The upstream `skills` CLI's universal global target is deliberately
        // shared across agents and is rooted independently of application config.
        this.globalSkillsDir = join(this.home, ".agents", "skills");
        this.legacyDir = join(this.home, ".plurnk");
    }

    projectSkillsDir(projectRoot: string): string {
        return join(resolve(projectRoot), ".agents", "skills");
    }

    expandUserPath(value: string): string {
        if (value === "~") return this.home;
        return value.startsWith("~/") ? resolve(this.home, value.slice(2)) : value;
    }
}
