// The assembled .env.defaults floor (§operator-config-env-defaults) for test tiers, loaded via
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
// --env-file cascade set the box's pins, so it strips the agent-written alias envelope pins here —
// forcing the #507 derivation (probed window + shipped percent reserves) instead. The model
// SELECTION + defs stay; only the box tuning that a fresh install would not have is scrubbed. Loud:
// a green zero-pin run must be trustworthy, so every stripped key is named. Law: if the demo only
// passes WITH a pin, the derivation is broken and the run is RED.
if (process.env.PLURNK_ZERO_PIN === "1") {
    const stripped = ZeroPin.scrubEnvelopePins(process.env);
    process.stderr.write(`floor: ZERO-PIN — stripped ${stripped.length} alias envelope pin(s)${stripped.length > 0 ? ": " + stripped.join(", ") : ""}; the envelope derives (probe + percent reserves)\n`);
}

EnvDefaults.apply(EnvDefaults.merge(await EnvDefaults.collect(root, nodeModules)));
