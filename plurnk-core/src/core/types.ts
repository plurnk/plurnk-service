// Framework-grade scheme types have one source of truth in
// @plurnk/plurnk-schemes. This barrel re-exports them so
// in-tree imports stay `core/types.ts`-local while the canonical definitions
// live in the plugin; "pull, don't copy."
//
// The public, database-independent plugin context is `SchemeCtx`
// ({§capability-ctx}). Service-coupled `PlurnkSchemeContext` remains internal
// in `scheme-types.ts`.
export type { WriterTier, SchemeManifest } from "@plurnk/plurnk-schemes";
export type { LoopPolicy } from "@plurnk/plurnk-contracts";
export { DEFAULT_LOOP_POLICY } from "@plurnk/plurnk-contracts";
