// The assembled .env.defaults floor (§operator-config-env-defaults) for test tiers, loaded via
// `node --import=./test/floor.ts`. Production parity: the daemon boots on this package's
// .env.defaults plus every installed member's; the tiers do too. Set-if-unset — the --env-file
// cascade (.env / .env.test) and the shell always win; only genuinely-unset knobs (siblings'
// defaults, e.g. PLURNK_PROVIDERS_*) take floor values.
import EnvDefaults from "../src/core/env-defaults.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// nearest ancestor node_modules holding the ecosystem (witness: @plurnk) — the workspace
// checkout hoists member packages to the monorepo root; a registry install hits root's own
let nmBase = root;
while (!existsSync(resolve(nmBase, "node_modules", "@plurnk")) && dirname(nmBase) !== nmBase) nmBase = dirname(nmBase);
EnvDefaults.apply(EnvDefaults.merge(await EnvDefaults.collect(root, resolve(nmBase, "node_modules"))));
