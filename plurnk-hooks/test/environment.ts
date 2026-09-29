import Module from "../src/Module.ts";

// Exercise the production env reader; retain no second configuration interface.
export const withEnvironment = <T>(values: NodeJS.ProcessEnv, run: () => T): T => {
    const prior = { ...process.env };
    for (const name of Object.keys(process.env)) if (name.startsWith("PLURNK_HOOKS_")) delete process.env[name];
    Object.assign(process.env, {
        PLURNK_HOOKS_TIMEOUT_MS: "30000",
        PLURNK_HOOKS_CONCURRENCY: "1",
        PLURNK_HOOKS_QUEUE_LIMIT: "64",
    }, values);
    try { return run(); }
    finally {
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(prior, name)) delete process.env[name];
        Object.assign(process.env, prior);
    }
};

export const configuredModule = (env: NodeJS.ProcessEnv, report?: (message: string, cause: unknown) => void): Module =>
    withEnvironment(env, () => Module.init({ report }));
