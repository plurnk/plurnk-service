// {§membership-git-hermetic} — native Git receives no ambient GIT_* or
// global/system configuration. Repository identity follows the explicit cwd,
// and user hooks/config cannot affect or escape a workspace operation.
export const hermeticGitEnv = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
});

export const gitOutputMaxBytes = (): number => {
    const value = Number(process.env.PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("PLURNK_SERVICE_GIT_OUTPUT_MAX_BYTES must be a positive safe integer");
    }
    return value;
};
