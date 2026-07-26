import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const providerDefaults = parseEnv(readFileSync(new URL("../.env.defaults", import.meta.url), "utf8"));

export const withProviderDefaults = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...providerDefaults,
    ...env,
});
