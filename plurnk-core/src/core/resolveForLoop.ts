// Active-scheme resolution under a loop's flags — single source of truth is
// @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the daughter's
// function (mandate: static-method class); call sites stay
// `ResolveForLoop.resolveForLoop(...)`. Schemes opt into flag affinity via
// `manifest.flags`; absence = always active.
import { SchemeResolver } from "@plurnk/plurnk-schemes";
import type { LoopFlags } from "./types.ts";

export default class ResolveForLoop {
    static resolveForLoop(handlers: ReadonlyMap<string, object>, flags: LoopFlags): Set<string> {
        return SchemeResolver.forLoop(handlers, flags);
    }
}
