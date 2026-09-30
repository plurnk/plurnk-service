import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

// {§operator-config-real-model-profile}: retain definitions, override only their enabledness.
// Explicit shell/benchmark controls remain above the gate profile.
export const gateResourceEnvironment = async (configFile, environment = process.env) => {
    let source;
    try {
        source = await readFile(configFile, "utf8");
    } catch (cause) {
        if (cause?.code === "ENOENT") return {};
        throw cause;
    }
    const overrides = {};
    for (const key of Object.keys(parseEnv(source))) {
        const match = /^(PLURNK_(?:MCP|A2A|SCHEDULE|MEMBERS)_[a-z][a-z0-9_]*)(?:_[A-Z][A-Z0-9_]*)?$/u.exec(key);
        if (match === null) continue;
        const enabled = `${match[1]}_ENABLED`;
        if (environment[enabled] === undefined) overrides[enabled] = "0";
    }
    return overrides;
};
