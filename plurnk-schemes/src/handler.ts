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

// The op set tracks the EXACT pinned grammar (0.49.0): Find/Read/Open/Fold/
// Edit/Copy/Move/Send/Exec/Kill/Plan. When the framework's grammar pin moves
// and the op surface changes, this interface moves with it — same consumer-
// driven bump as every other grammar-derived type here. (Show/Hide were
// replaced by Open/Fold; Kill/Plan added — grammar 0.49, schemes#19.)
import type {
    FindStatement,
    ReadStatement,
    OpenStatement,
    FoldStatement,
    EditStatement,
    CopyStatement,
    MoveStatement,
    SendStatement,
    ExecStatement,
    KillStatement,
    PlanStatement,
} from "@plurnk/plurnk-grammar";
import type { SchemeCtx } from "./ctx.ts";
import type { SchemeResult } from "./results.ts";
import type { SchemeManifest } from "./types.ts";

export interface SchemeHandler {
    // Per-instance manifest. Single-identity schemes (http/file) use the class's
    // `static manifest` and omit this; a per-tag executor-scheme (instantiated
    // per tag) supplies it as a `get manifest()` derived from its tag via
    // SchemeDiscovery/manifestFromRuntime. The consumer reads the instance value
    // when present, else the static one. (executor-is-a-scheme RFC, schemes#20.)
    readonly manifest?: SchemeManifest;

    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    open?(statement: OpenStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    fold?(statement: FoldStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    edit?(statement: EditStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    copy?(statement: CopyStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    move?(statement: MoveStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    plan?(statement: PlanStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}
