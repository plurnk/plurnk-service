// The assembled .env.defaults floor ({§operator-config-env-defaults}) for test tiers, loaded via
// `node --import=./test/floor.ts`. Production parity: the daemon boots on this package's
// .env.defaults plus every installed member's; the tiers do too. Set-if-unset — the --env-file
// cascade (.env / .env.test) and the shell always win; only genuinely-unset knobs (siblings'
// defaults, e.g. PLURNK_PROVIDERS_*) take floor values.
import EnvDefaults from "../src/core/env-defaults.ts";
import * as ZeroPin from "./zero-pin.ts";
import Meta from "@plurnk/plurnk-meta";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = Meta.nearestNodeModules(root) ?? resolve(root, "node_modules");

// {§operator-config-zero-pin-gate} — strip tuning after env files and before defaults fill gaps.
if (process.env.PLURNK_ZERO_PIN === "1") {
    const stripped = ZeroPin.scrubZeroPinTuning(process.env);
    process.stderr.write(`floor: ZERO-PIN — stripped ${stripped.length} tuning pin(s)${stripped.length > 0 ? ": " + stripped.join(", ") : ""}; provider capacity and prompt budget derive naturally\n`);
}

EnvDefaults.apply(EnvDefaults.merge(await EnvDefaults.collect(root, nodeModules)));
