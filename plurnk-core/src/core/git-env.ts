import { isRecord } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// {§membership-git-hermetic} — native Git receives no ambient GIT_* or
// global/system configuration, and the repository's own program-running keys are
// pinned off at the highest precedence: `core.fsmonitor` (a helper a supplied
// repository can name in `.git/config`, executed by index refresh) and
// `core.hooksPath`. Repository identity follows the explicit cwd. Other
// repository-local configuration is still read; inspecting a supplied
// repository never runs its configured programs as the daemon (#568).
const PINNED_CONFIG: ReadonlyArray<readonly [string, string]> = Object.freeze([
    ["core.fsmonitor", "false"],
    ["core.hooksPath", "/dev/null"],
]);

// {§membership-git-hermetic} The daemon user's excludes file is the one global setting native Git keeps, so a model
// sees what that user's git shows: the configured `core.excludesFile`, else git's default beneath the XDG
// configuration home (#1181). Resolved once per home.
const excludesFiles = new Map<string, string>();
export const excludesFile = (env: NodeJS.ProcessEnv = process.env): string => {
    const home = env.HOME ?? homedir();
    const xdg = env.XDG_CONFIG_HOME;
    const key = `${home}\u0000${xdg ?? ""}`;
    const known = excludesFiles.get(key);
    if (known !== undefined) return known;
    let configured = "";
    try {
        configured = execFileSync("git", ["-C", "/", "config", "--path", "--get", "core.excludesFile"], {
            env: Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_"))),
            encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch (cause) {
        // Exit 1 is an unset key; git absent leaves its default, and every later Git call reports its absence.
        if (!(isRecord(cause) && (cause.status === 1 || cause.code === "ENOENT"))) throw new Error("Git's excludes file could not be read.", { cause });
    }
    const resolved = configured.length > 0 ? configured : join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config"), "git", "ignore");
    excludesFiles.set(key, resolved);
    return resolved;
};

// `trusted` is the repository the daemon was pointed at, pinned as `safe.directory`: git's ownership
// check otherwise refuses a repository another account owns, which is exactly the shape when the
// model's commands own the workspace ({§executor-spawn-account}). The daemon trusts the root it
// was given, nothing wider; the blanked global and system configuration cannot grant it.
export const hermeticGitEnv = (trusted: string | null = null): NodeJS.ProcessEnv => {
    const kept: ReadonlyArray<readonly [string, string]> = [...PINNED_CONFIG, ["core.excludesFile", excludesFile()]];
    const pins = trusted === null ? kept : [...kept, ["safe.directory", trusted] as const];
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        // GIT_CONFIG_COUNT/KEY_n/VALUE_n rank with `-c`: above every configuration file.
        GIT_CONFIG_COUNT: String(pins.length),
        ...Object.fromEntries(pins.flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
        ])),
    };
};

// {§membership-git-hermetic} (#568): the pins above cannot cover a supplied
// repository's `filter.<name>.clean` / `filter.<name>.process` drivers — the
// name is arbitrary, and `git status` index refresh may run one as the daemon.
// Automatic inspection asks the repository's own config first and refuses when
// any such program is declared; user- and model-requested Git commands are on
// their explicit path and never consult this.
export const declaredFilterProgram = async (repository: string, signal?: AbortSignal): Promise<string | null> => {
    try {
        const { stdout } = await execFileP("git", ["config", "--get-regexp", "^filter\\..+\\.(clean|process)$"], {
            cwd: repository, signal, maxBuffer: gitOutputMaxBytes(), env: hermeticGitEnv(repository),
        });
        const first = stdout.split("\n").find((line) => line.length > 0);
        return first === undefined ? null : first.split(" ", 1)[0];
    } catch (cause) {
        if (isRecord(cause) && cause.code === 1) return null; // no such key
        throw new Error(`Git configuration inspection failed for '${repository}'.`, { cause });
    }
};

export const gitOutputMaxBytes = (): number => Knob.integer("PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES", 1);
