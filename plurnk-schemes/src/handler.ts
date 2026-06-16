// The scheme BEHAVIOR contract — the typed counterpart to SchemeManifest
// (which types a scheme's declaration). A handler implements a method per op it
// supports, named for the lowercased op (READ → read, SEND → send, FIND → find,
// …); plurnk-service dispatches `handler[statement.op.toLowerCase()](statement,
// ctx)` and returns 501 for any op a scheme doesn't implement. Every method is
// therefore OPTIONAL — a scheme implements only its surface (http: read + send;
// an entry scheme: read/find/edit/copy/move/…). All share one shape:
// `(statement, ctx) => Promise<SchemeResult>`.
//
// `implements SchemeHandler` gives a sibling compile-time checking of its op
// signatures instead of the duck-typed `object` the engine falls back to. The
// per-op statement types are re-exported from the barrel, so a sibling depends
// on (and exact-pins) ONLY @plurnk/plurnk-schemes — grammar rides underneath as
// the framework's transitive pin, not a second pin every scheme tracks by hand.

// The op set tracks the EXACT pinned grammar (0.21.0): Find/Read/Show/Hide/
// Edit/Copy/Move/Send/Exec. When the framework's grammar pin moves and the op
// surface changes, this interface moves with it — same consumer-driven bump as
// every other grammar-derived type here.
import type {
    FindStatement,
    ReadStatement,
    ShowStatement,
    HideStatement,
    EditStatement,
    CopyStatement,
    MoveStatement,
    SendStatement,
    ExecStatement,
} from "@plurnk/plurnk-grammar";
import type { SchemeCtx } from "./ctx.ts";
import type { SchemeResult } from "./results.ts";

export interface SchemeHandler {
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    show?(statement: ShowStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    hide?(statement: HideStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    edit?(statement: EditStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    copy?(statement: CopyStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    move?(statement: MoveStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}
