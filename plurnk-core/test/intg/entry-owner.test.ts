// #527 beachhead — entry ownership. Every entry is owned by a worker row (never NULL: NULLs are
// distinct under UNIQUE, so a nullable owner would let the commons fragment into duplicate rows);
// capability streams are owner-scoped so concurrent workers' identical loop coordinates are
// distinct rows (#526); worker auto-names are id-free ordinals (the name is the authority).
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import type ExecOutputScheme from "../../src/schemes/ExecOutputScheme.ts";
import Owner from "../../src/core/Owner.ts";
import Envelope from "../../src/server/envelope.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, makeSchemeCtx } from "./_helpers.ts";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const streamRead = (scheme: string, hostname: string | null, pathname: string): ReadStatement => ({
    op: "READ", suffix: "", signal: null,
    target: { kind: "url", raw: `${scheme}://${hostname ?? ""}${pathname}`, scheme, username: null, password: null, hostname, port: null, pathname, query: null, fragment: null } as UrlPath,
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

test("fan-out: two sisters EXEC[jq] at the same coordinate; each READ resolves ITS OWN output (#526)", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors); // {§exec} — per-tag faces let READ jq:// resolve
        const exec = schemes.get("exec") as Exec;
        const jq = schemes.get("jq") as ExecOutputScheme;
        const ws = await insertWorkspace(db, `owner-fanout-${crypto.randomUUID()}`);

        // A parent and two sisters it spawned, each on its OWN first loop/turn — both jq outputs land
        // at the identical model-facing coordinate /1/1/1, the #526 collision surface. jq is pure → inline.
        const parent = await insertWorker(db, ws, null, "parent");
        const host = await insertWorker(db, ws, parent, "extract-host");
        const hLoop = await insertLoop(db, host, 1, "host");
        const hTurn = await insertTurn(db, hLoop, 1, 102);
        const pool = await insertWorker(db, ws, parent, "extract-pool");
        const pLoop = await insertLoop(db, pool, 1, "pool");
        const pTurn = await insertTurn(db, pLoop, 1, 102);

        await engine.dispatch({ statement: execStmt("jq", '"db.internal"'), workspaceId: ws, workerId: host, loopId: hLoop, turnId: hTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: execStmt("jq", "5"), workspaceId: ws, workerId: pool, loopId: pLoop, turnId: pTurn, sequence: 1, origin: "model" });
        await exec.idle();

        // The #526 reproduction: both sisters READ the SAME loop-relative coordinate. Empty authority
        // = the CALLING worker, so each resolves its own — never the sibling's.
        const hostRead = await jq.read(streamRead("jq", null, "/1/1/1"), makeSchemeCtx({ db, workspaceId: ws, workerId: host }));
        const poolRead = await jq.read(streamRead("jq", null, "/1/1/1"), makeSchemeCtx({ db, workspaceId: ws, workerId: pool }));
        assert.match(hostRead.content ?? "", /db\.internal/, "host READ resolves host's own jq output");
        assert.doesNotMatch(hostRead.content ?? "", /^5$/m, "host never sees the pool sister's output — the #526 leak is closed");
        assert.match(poolRead.content ?? "", /^5$/m, "pool READ resolves pool's own jq output");

        // Ancestry: the PARENT reads a child's stream BY NAME (oversight flows down the tree)…
        const parentRead = await jq.read(streamRead("jq", "extract-host", "/1/1/1"), makeSchemeCtx({ db, workspaceId: ws, workerId: parent }));
        assert.match(parentRead.content ?? "", /db\.internal/, "the parent reads its child's stream by name");
        // …but a SIBLING is not an ancestor — named cross-read 404s, no existence leak.
        const siblingRead = await jq.read(streamRead("jq", "extract-host", "/1/1/1"), makeSchemeCtx({ db, workspaceId: ws, workerId: pool }));
        assert.equal(siblingRead.status, 404, "a sibling naming another sibling's stream is 404 — reader must be owner or ancestor");
        // …and an unknown name is the same 404.
        const unknownRead = await jq.read(streamRead("jq", "no-such-worker", "/1/1/1"), makeSchemeCtx({ db, workspaceId: ws, workerId: parent }));
        assert.equal(unknownRead.status, 404, "an unknown authority is 404");
    } finally { await db.close(); }
});

test("the commons is a real reserved row — shared-content identity cannot fragment", async () => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-commons-${crypto.randomUUID()}`);
        const commons = await Owner.commonsId(db, ws);
        assert.equal(await Owner.commonsId(db, ws), commons, "commonsId is idempotent — one row per workspace");
        const row = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: ws, name: "commons" });
        assert.equal(row?.id, commons, "the commons worker is a real named row");

        // The identity index holds ON the commons: a second insert at the same key conflicts —
        // the exact fragmentation a NULL owner would have allowed (NULLs are distinct under UNIQUE).
        await db.test_seed_entry_workspace.get({ workspace_id: ws, owner_id: commons, scheme: "jq", pathname: "/1/1/1" });
        await assert.rejects(
            db.test_seed_entry_workspace.get({ workspace_id: ws, owner_id: commons, scheme: "jq", pathname: "/1/1/1" }),
            /UNIQUE/,
            "the same (workspace, owner, scheme, pathname) key conflicts — no silent duplicate",
        );
        // …while a DIFFERENT owner at the same coordinate is a distinct row ({§stream-owner-scoped}).
        const worker = await insertWorker(db, ws);
        const other = await db.test_seed_entry_workspace.get<{ id: number }>({ workspace_id: ws, owner_id: worker, scheme: "jq", pathname: "/1/1/1" });
        assert.ok(other, "another owner's identical coordinate is its own row");
    } finally { await db.close(); }
});

test("auto-names are id-free per-workspace ordinals; only internal names and ~ are refused", async () => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-name-${crypto.randomUUID()}`);
        const first = await Envelope.createModelWorker(db, ws);
        assert.equal(first.name, "model-1", "the first model auto-name is the ordinal, no timestamp/hash");
        const second = await Envelope.createModelWorker(db, ws);
        assert.equal(second.name, "model-2", "the ordinal advances with the ever-created count");
        await Envelope.createModelWorker(db, ws, "model-4");
        const afterOccupiedLiteral = await Envelope.createModelWorker(db, ws);
        assert.equal(afterOccupiedLiteral.name, "model-5", "an occupied candidate is never reused");

        await assert.rejects(Envelope.createModelWorker(db, ws, "commons"), /reserved/, "the commons row's name is refused");
        await assert.rejects(Envelope.createModelWorker(db, ws, "plurnk"), /reserved/, "the kernel row's name is refused");
        await assert.rejects(Envelope.createModelWorker(db, ws, "~"), /reserved/, "the #527 current-worker sigil is refused");
        assert.equal((await Envelope.createModelWorker(db, ws, "self")).name, "self", "self is an ordinary literal worker name");
    } finally { await db.close(); }
});
