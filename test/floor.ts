// The assembled .env.defaults floor (§operator-config-env-defaults) for test tiers, loaded via
// `node --import=./test/floor.ts`. Production parity: the daemon boots on this package's
// .env.defaults plus every installed member's; the tiers do too. Set-if-unset — the --env-file
// cascade (.env / .env.test) and the shell always win; only genuinely-unset knobs (siblings'
// defaults, e.g. PLURNK_PROVIDERS_*) take floor values.
import EnvDefaults from "../src/core/env-defaults.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
EnvDefaults.apply(EnvDefaults.merge(await EnvDefaults.collect(root, resolve(root, "node_modules"))));
