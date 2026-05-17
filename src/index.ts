// Public library API for @plurnk/plurnk-service.
//
// Consumers (plurnk CLI/TUI, future web app, etc.) import from here.
// Internal modules and tests reach into src/ paths directly; this file
// is the contract for external use.

export { default as Engine } from "./core/Engine.ts";
export { default as Migrator } from "./core/Migrator.ts";
export { default as SchemeRegistry } from "./core/SchemeRegistry.ts";

export { default as Known } from "./schemes/Known.ts";
export { default as Unknown } from "./schemes/Unknown.ts";
export { default as Skill } from "./schemes/Skill.ts";
export { default as Log } from "./schemes/Log.ts";
export { default as Plurnk } from "./schemes/Plurnk.ts";
export { default as Exec } from "./schemes/Exec.ts";

export { default as Mock } from "./providers/Mock.ts";
export type { MockResponse, MockAssistant, ChatMessage } from "./providers/Mock.ts";

export type {
    EditResult,
    ReadResult,
    ShowHideResult,
} from "./schemes/_entry-ops.ts";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Package-relative paths to non-code artifacts shipped in the tarball.
// Consumers use these to locate migrations + the system prompt without
// hardcoding installation paths.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
    migrations: resolve(PACKAGE_ROOT, "migrations"),
    instructionsSystem: resolve(PACKAGE_ROOT, "instructions-system.md"),
};
