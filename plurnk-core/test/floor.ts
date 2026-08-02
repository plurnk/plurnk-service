// The assembled .env.defaults floor ({§operator-config-env-defaults}) for test tiers, loaded via
// `node --import=./test/floor.ts`. Production parity: the daemon boots on this package's
// .env.defaults plus every installed member's; the tiers do too. Set-if-unset — the --env-file
// cascade (.env / .env.test) and the shell always win; only genuinely-unset knobs (siblings'
// defaults, e.g. PLURNK_PROVIDERS_*) take floor values.
import EnvDefaults from "../src/core/env-defaults.ts";
import * as ZeroPin from "../src/core/zero-pin.ts";
import Meta from "@plurnk/plurnk-meta";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = Meta.nearestNodeModules(root) ?? resolve(root, "node_modules");

// #510 — zero-pin mode (PLURNK_ZERO_PIN=1): walk the FRESH-USER derivation path. Runs AFTER the
// --env-file cascade set operator tuning, so it strips physical envelope pins and virtual prompt
// pressure here. Model selection and shipped defaults stay. Loud:
// a green zero-pin run must be trustworthy, so every stripped key is named. Law: if the demo only
// passes WITH a pin, the derivation is broken and the run is RED.
if (process.env.PLURNK_ZERO_PIN === "1") {
    const stripped = ZeroPin.scrubZeroPinTuning(process.env);
    process.stderr.write(`floor: ZERO-PIN — stripped ${stripped.length} tuning pin(s)${stripped.length > 0 ? ": " + stripped.join(", ") : ""}; provider capacity and prompt budget derive naturally\n`);
}

EnvDefaults.apply(EnvDefaults.merge(await EnvDefaults.collect(root, nodeModules)));
