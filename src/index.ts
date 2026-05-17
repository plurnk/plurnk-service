// Public library API for @plurnk/plurnk-service.
//
// Consumers (plurnk CLI/TUI, future web app, etc.) import from here.
// Internal modules and tests reach into src/ paths directly; this file
// is the contract for external use.

export { default as Engine } from "./core/Engine.ts";
export { default as Migrator } from "./core/Migrator.ts";
export { default as SchemeRegistry } from "./core/SchemeRegistry.ts";
export { default as MimetypeRegistry } from "./core/MimetypeRegistry.ts";

export { default as Daemon } from "./server/Daemon.ts";
export { default as MethodRegistry } from "./server/MethodRegistry.ts";
export type {
    MethodHandler,
    MethodRegistration,
    NotificationRegistration,
    Catalog,
} from "./server/MethodRegistry.ts";

export { default as Known } from "./schemes/Known.ts";
export { default as Unknown } from "./schemes/Unknown.ts";
export { default as Skill } from "./schemes/Skill.ts";
export { default as Log } from "./schemes/Log.ts";
export { default as Plurnk } from "./schemes/Plurnk.ts";
export { default as Exec } from "./schemes/Exec.ts";
export { default as File } from "./schemes/File.ts";

export { default as TextPlain } from "./mimetypes/TextPlain.ts";
export { default as TextMarkdown } from "./mimetypes/TextMarkdown.ts";
export type { MimetypeHandler } from "./mimetypes/_types.ts";

export { default as Mock } from "./providers/Mock.ts";
export type { MockResponse, MockAssistant, ChatMessage } from "./providers/Mock.ts";

export type {
    EditResult,
    ReadResult,
    ShowHideResult,
} from "./schemes/_entry-ops.ts";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Package-relative paths to non-code artifacts.
//
// `migrations` ships in this package's tarball.
// `instructionsSystem` resolves to `plurnk.md` IN THE GRAMMAR PACKAGE — single
// source of truth lives upstream. Plurnk-service doesn't carry its own copy;
// the grammar agent owns the prose.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAMMAR_ROOT = dirname(fileURLToPath(import.meta.resolve("@plurnk/plurnk-grammar/package.json")));

export const PATHS = {
    migrations: resolve(PACKAGE_ROOT, "migrations"),
    instructionsSystem: resolve(GRAMMAR_ROOT, "plurnk.md"),
};
