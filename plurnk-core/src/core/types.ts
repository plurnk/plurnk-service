// Framework-grade scheme types — single source of truth is now
// @plurnk/plurnk-schemes (keystone PR-1). This barrel re-exports them so
// in-tree imports stay `core/types.ts`-local while the canonical definitions
// live in the plugin; "pull, don't copy."
//
// `PlurnkSchemeContext` is deliberately NOT here — it's service-coupled (db
// handle, channel-write + wake notifiers) and stays in `scheme-types.ts`
// until the capability-ctx contract (PR-2, plurnk-schemes#13) lands.
export type { WriterTier, SchemeFlagAffinity, SchemeManifest, LoopFlags } from "@plurnk/plurnk-schemes";
export { DEFAULT_LOOP_FLAGS } from "@plurnk/plurnk-schemes";
