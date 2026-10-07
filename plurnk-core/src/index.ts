// Legacy internal exports ({§service-package-exports}). Clients use AG-UI;
// new library APIs belong to their owning packages, not this barrel.

export { default as Engine } from "./core/Engine.ts";
export { default as SchemeRegistry } from "./core/SchemeRegistry.ts";
// Mimetype handling is owned by @plurnk/plurnk-mimetypes. Consumers needing
// the orchestrator import directly from there.
export { Mimetypes } from "@plurnk/plurnk-mimetypes";

export { default as Daemon } from "./server/Daemon.ts";

export { default as Log } from "./schemes/Log.ts";
export { default as Exec } from "./schemes/Exec.ts";
export { default as File } from "./schemes/File.ts";

export { Mock } from "@plurnk/plurnk-providers";
export type { MockResponse, MockAssistant, ChatMessage } from "@plurnk/plurnk-providers";

export type {
    EditResult,
    ReadResult,
    OpenFoldResult,
} from "./schemes/_entry-ops.ts";

// Package-relative paths to non-code artifacts (migrations, the upstream
// grammar's plurnk.md, default Recap). Resolution lives in the
// Paths class so this entry stays a pure re-export barrel.
export { default as Paths } from "./Paths.ts";

// CLI-flag derivation from .env.defaults (PLURNK_X → --x, the comment above
// becomes help text, flags top the cascade) — the shared lib both the service
// CLI and the client TUI consume, so a flag set stays single-sourced.
export { default as EnvFlags } from "./core/EnvFlags.ts";
export type { FlagDescriptor } from "./core/EnvFlags.ts";
