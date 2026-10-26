// {§read-exact-target} and {§find-result-projection}: broad FIND locates
// resources; READ retrieves one exact target.

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { RepresentationPreparationRequest, SchemeCtx } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx } from "./_scheme.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null, target,
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath | null, matcher: MatcherBody | null = null, lineMarker: FindStatement["lineMarker"] = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target,
    lineMarker, matcher, body: null,  position: { line: 1, column: 1 },
});

const seed = async (db: Db, workspaceId: number, sessionId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Workspace().edit(
        { metadata: null, op: "EDIT", aside: null, target: urlPath("workspace", path), lineMarker: null, matcher: null, body: content, position: { line: 1, column: 1 } },
        makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
    );
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `fanout-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "fanout");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes });
    return { db, workspaceId, sessionId, loopId, turnId, mimetypes, schemes, engine };
};

test("{§read-exact-target} FIND locates resources by glob matcher", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, sessionId, mimetypes, "/a", "intro\nfrance alpha\ntail");
        await seed(db, workspaceId, sessionId, mimetypes, "/b", "france beta\nmore");
        await seed(db, workspaceId, sessionId, mimetypes, "/c", "italy\nspain");

        const r = await engine.dispatch({
            statement: findStmt(urlPath("workspace", "/**"), { dialect: "glob", raw: "france*" }),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });

        assert.equal(r.status, 200);
        assert.equal((r as { matchingPathCount?: number }).matchingPathCount, 2);
        assert.equal((r as { matchLocationCount?: number }).matchLocationCount, 2);
    } finally { await db.close(); }
});

test("{§read-exact-target} FIND with zero matches returns 204", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, sessionId, mimetypes, "/a", "italy");
        await seed(db, workspaceId, sessionId, mimetypes, "/b", "spain");
        const r = await engine.dispatch({
            statement: findStmt(urlPath("workspace", "/**"), { dialect: "glob", raw: "france*" }),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 204);
    } finally { await db.close(); }
});

test("{§read-exact-target} exact READ returns target content", async () => {
    const { db, workspaceId, sessionId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, sessionId, mimetypes, "/a", "france one");
        const r = await engine.dispatch({
            statement: readStmt(urlPath("workspace", "/a")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 200);
        assert.match((typeof r.content === "string" ? r.content : ""), /france one/);
    } finally { await db.close(); }
});

test("{§read-exact-target} trailing slash is ordinary resource syntax unless the scheme declares folder scopes", async () => {
    class OpaqueResource {
        static manifest = {
            name: "opaque", channels: { body: "text/markdown" }, defaultChannel: "body",
            category: "data" as const, writableBy: [] as const,
            volatile: false, modelVisible: true,
        };
        async prepareRepresentation(
            request: RepresentationPreparationRequest,
            ctx: SchemeCtx,
        ) {
            await ctx.entries.write(request.pathname, {
                channels: {
                    body: { content: "opaque root resource", mimetype: "text/markdown" },
                },
            });
            return { status: 200 };
        }
        async find(): Promise<never> { throw new Error("undeclared folder scope must never invoke FIND"); }
    }
    const { db, workspaceId, sessionId, loopId, turnId, schemes, engine } = await setup();
    try {
        schemes.register("opaque", new OpaqueResource());
        const result = await engine.dispatch({
            statement: readStmt(urlPath("opaque", "/")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ session_id: sessionId, loop_seq: 1, turn_seq: 1, sequence: 1 });
        assert.match(row?.rx ?? "", /opaque root resource/);
    } finally { await db.close(); }
});
