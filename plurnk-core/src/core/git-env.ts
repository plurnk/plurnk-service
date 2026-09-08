import { execFile } from "node:child_process";
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

export const hermeticGitEnv = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // GIT_CONFIG_COUNT/KEY_n/VALUE_n rank with `-c`: above every configuration file.
    GIT_CONFIG_COUNT: String(PINNED_CONFIG.length),
    ...Object.fromEntries(PINNED_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
    ])),
});

// {§membership-git-hermetic} (#568): the pins above cannot cover a supplied
// repository's `filter.<name>.clean` / `filter.<name>.process` drivers — the
// name is arbitrary, and `git status` index refresh may run one as the daemon.
// Automatic inspection asks the repository's own config first and refuses when
// any such program is declared; user- and model-requested Git commands are on
// their explicit path and never consult this.
export const declaredFilterProgram = async (repository: string, signal?: AbortSignal): Promise<string | null> => {
    try {
        const { stdout } = await execFileP("git", ["config", "--get-regexp", "^filter\\..+\\.(clean|process)$"], {
            cwd: repository, signal, maxBuffer: gitOutputMaxBytes(), env: hermeticGitEnv(),
        });
        const first = stdout.split("\n").find((line) => line.length > 0);
        return first === undefined ? null : first.split(" ", 1)[0]!;
    } catch (cause) {
        if ((cause as { code?: unknown }).code === 1) return null; // no such key
        throw new Error(`Git configuration inspection failed for '${repository}'.`, { cause });
    }
};

export const gitOutputMaxBytes = (): number => {
    const value = Number(process.env.PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES must be a positive safe integer");
    }
    return value;
};
