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

export const gitOutputMaxBytes = (): number => {
    const value = Number(process.env.PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES must be a positive safe integer");
    }
    return value;
};
