// {§readable-channel} — a readable projection is a channel, never a hidden matching surface.
import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, EditStatement, FindStatement, MatcherBody, MoveStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import SearchIndex from "../../src/schemes/_search-index.ts";
import GitMembership from "../../src/core/git-membership.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx, insertWorkspace, insertWorker, rootWorkspace, DEFAULT_MIMETYPES } from "./_helpers.ts";

const execFileP = promisify(execFile);
import { urlPath, editStmt, readStmt, findStmt, copyStmt, moveStmt } from "./_dsl.ts";

const HTML = "<html>\n  <body>\n    <h1>Team Roster</h1>\n    <p>Alice is an admin.</p>\n  </body>\n</html>";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = (statement: EditStatement | ReadStatement | FindStatement | CopyStatement | MoveStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const channel = async (pathname: string, name: string) => (await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname, name }));
    return { db, env, dispatch, channel };
};

const page = urlPath("worker", "/users.html");
const readable = urlPath("worker", "/users.html", "readable");
const regex = (pattern: string, flags = ""): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/${flags}`, pattern, flags });

test("an HTML source lands with its readable projection beside it, and the projection follows every source write", async () => {
    const { db, dispatch, channel } = await setup();
    try {
        assert.equal((await dispatch(editStmt(page, HTML))).status, 201);
        const derived = await channel("/users.html", "readable");
        assert.equal(derived?.mimetype, "text/markdown");
        assert.match(String(derived?.content), /Team Roster/);
        assert.doesNotMatch(String(derived?.content), /<h1>/, "the projection is the Markdown, not the markup");
        assert.equal((await dispatch(editStmt(page, "    <h1>Crew Roster</h1>", { marks: [3] }))).status, 200);
        assert.match(String((await channel("/users.html", "readable"))?.content), /Crew Roster/, "a source write refreshes the projection");
        assert.equal((await dispatch(editStmt(page, "<html><body><!-- nothing readable --></body></html>", { marks: [1, -1] }))).status, 200);
        assert.equal(await channel("/users.html", "readable"), undefined, "a source without a projection keeps no sibling");
    } finally { await db.close(); }
});

test("a Markdown source has no projection and no sibling", async () => {
    const { db, dispatch, channel } = await setup();
    try {
        assert.equal((await dispatch(editStmt(urlPath("worker", "/notes.md"), "# Notes\n\nplain"))).status, 201);
        assert.equal(await channel("/notes.md", "readable"), undefined);
    } finally { await db.close(); }
});

test("each channel matches in its own text and reports its own coordinates", async () => {
    const { db, dispatch } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        const markup = await dispatch(readStmt(page, null, regex("<h[1-6]", "i")));
        assert.equal(markup.status, 200, JSON.stringify(markup));
        assert.deepEqual(markup.lineOrdinals, [3], "the sweep's case: the heading tag is on source line 3");
        const body = await dispatch(readStmt(page, null, regex("admin")));
        assert.deepEqual(body.lineOrdinals, [4], "the source's own line");
        const projection = await dispatch(readStmt(readable, null, regex("admin")));
        assert.equal(projection.status, 200, JSON.stringify(projection));
        assert.equal(projection.mimetype, "text/markdown");
        assert.match(String(projection.content), /Alice is an admin\./);
        assert.doesNotMatch(String(projection.content), /<p>/, "the projection's line, in the projection's coordinates");
        // A broad FIND matches the addressed (default) channel in its own coordinates and lists the
        // sibling beside it ({§channel-selection-visibility}); `#readable` addresses the projection.
        const broad = await dispatch(findStmt(urlPath("worker", "/*"), regex("admin")));
        assert.equal(broad.status, 200, JSON.stringify(broad));
        const rows = (broad.results as Array<Array<{ path?: string; mimetype?: string; region?: { startLine: number } }>>).flat();
        assert.deepEqual(rows.map(({ path, mimetype }) => `${path} ${mimetype}`), ["worker:///users.html text/html", "worker:///users.html#readable text/markdown"]);
        assert.equal(rows[0]?.region?.startLine, 4, "the match is reported in the source's coordinates");
        const projected = await dispatch(findStmt(readable, regex("admin")));
        assert.equal(projected.status, 200, JSON.stringify(projected));
        assert.deepEqual((projected.results as Array<{ channel?: string; region?: { startLine: number } }>).map(({ channel, region }) => `${channel}:${region?.startLine}`), ["readable:3"], "the projection matches in the projection's coordinates");
    } finally { await db.close(); }
});

test("full-text search reaches HTML through its readable channel", async () => {
    const { db, env, dispatch } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId: env.workspaceId, workerId: env.workerId }));
        const hit = await dispatch(findStmt(urlPath("worker", "/*"), { dialect: "fts", raw: "~roster" }));
        assert.equal(hit.status, 200, JSON.stringify(hit));
        const paths = (hit.results as Array<Array<{ path?: string }>>).flat().map((row) => row.path);
        assert.ok(paths.some((path) => String(path).includes("users.html")), JSON.stringify(paths));
    } finally { await db.close(); }
});

test("nothing writes the derived channel: EDIT, a transfer landing, and a MOVE out are refused; COPY from it reads", async () => {
    const { db, dispatch, channel } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        const edit = await dispatch(editStmt(readable, "hand-written", { marks: [1] }));
        assert.equal(edit.status, 400, JSON.stringify(edit));
        assert.match(String(edit.problem?.type), /\/channel-derived$/);
        const landing = await dispatch(copyStmt(urlPath("worker", "/notes.md"), readable));
        assert.equal(landing.status, 400, JSON.stringify(landing));
        assert.match(String(landing.problem?.type), /\/channel-derived$/);
        const move = await dispatch(moveStmt(readable, urlPath("worker", "/copy.md")));
        assert.equal(move.status, 400, JSON.stringify(move));
        assert.match(String(move.problem?.type), /\/channel-derived$/);
        const copy = await dispatch(copyStmt(readable, urlPath("worker", "/copy.md")));
        assert.equal(copy.status, 201, JSON.stringify(copy));
        assert.match(String((await channel("/copy.md", "body"))?.content), /Team Roster/);
    } finally { await db.close(); }
});

test("a tracked .html member materializes with its readable projection beside the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-readable-member-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "page.html"), HTML);
        await execFileP("git", ["add", "page.html"], { cwd: root, env: hermeticGitEnv() });
        const workspaceId = await insertWorkspace(db, `readable-member-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        assert.deepEqual(await GitMembership.indexGitMembership(makeSchemeCtx({ db, workspaceId, workerId })), []);
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", pathname: "page.html" });
        assert.ok(entry);
        const source = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "body" });
        assert.equal(source?.mimetype, "text/html");
        assert.equal(source?.content, HTML, "the source channel is the file verbatim");
        const projection = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "readable" });
        assert.equal(projection?.mimetype, "text/markdown");
        assert.match(String(projection?.content), /Team Roster/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
