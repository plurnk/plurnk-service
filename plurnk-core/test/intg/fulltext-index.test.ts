import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import Http from "@plurnk/plurnk-schemes-http";
import EntryFts from "../../src/schemes/_entry-fts.ts";
import { type LineMarker, type UrlPath, type MatcherBody, type ReadStatement, type SendStatement, type PlurnkStatement, type Notice } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement, type FindStatement, type RepresentationPreparationRequest, type RepresentationPreparationResult, type SchemeCtx, type SchemeHandler, type SchemeManifest, type SchemeResult } from "@plurnk/plurnk-schemes";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEnvelope, rootWorkspace, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES, readThroughScheme, mimetypesFixture } from "./_scheme.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BaseHandler, MimetypeInputLimitError, Mimetypes, type HandlerContent, type QueryDialect } from "@plurnk/plurnk-mimetypes";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { urlPath, localPath, editStmt, readStmt, findStmt, killStmt } from "./_dsl.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { fixtureExecutors } from "./_mock.ts";
import { requestUrl } from "../../../scripts/lib/test-fetch.ts";
import { serverProposals } from "./_approval.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type MockResponse, Mock } from "@plurnk/plurnk-providers";


describe("fulltext-index", () => {
// {§persistent-search-index} Index the complete addressed READ body.









const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

test("{§persistent-search-index} persistent-index maintenance indexes body content into derivation_fts and re-indexes on change", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await new Workspace().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Workspace().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await SearchIndex.maintain(ctx);

        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "nonexistent"), []);

        // Change pay.ts: re-index must drop the old term and add the new one;
        // auth.ts is unchanged (gate skips it) and stays indexed.
        await new Workspace().edit(editStmt(url("pay.ts"), "export function refund() {}\n", fullReplace), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), [], "old term gone after re-index");
        assert.deepEqual(await fts(db, workspaceId, "refund"), ["/pay.ts"], "new term indexed");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "unchanged entry stays indexed");
    } finally { db.close(); }
});

test("{§persistent-search-index} search artifacts index the exact READ body rather than a hidden mimetype projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-readable-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await new Workspace().edit(
            editStmt(url("authored.html"), "<main data-rawonlymarker=\"yes\">Visible prose</main>\n"),
            ctx,
        );
        await SearchIndex.maintain(ctx);

        assert.deepEqual(
            await fts(db, workspaceId, "rawonlymarker"),
            ["/authored.html"],
            "an authored HTML file is indexed in the same verbatim coordinate space READ exposes",
        );
    } finally { db.close(); }
});
});

describe("contract-mimetypes", () => {
// Composed coverage for {§matcher-dispatch}, {§zero-width-column-one-insert},
// {§op-invariants}, {§mimetype}, and {§mimetype}.























const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const execFileP = promisify(execFile);
const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    readThroughScheme("file", null, statement, ctx);

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `cm-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    return { db, workspaceId, sessionId, mimetypes };
};

const binaryProjectionMimetypes = (revision: string): Mimetypes => {
    class BinaryProjectionHandler extends BaseHandler {
        override projectionConfiguration(): string {
            return revision;
        }

        override content(content: string | Uint8Array): string {
            assert.ok(content instanceof Uint8Array);
            return `${revision}:${[...content].join(",")}`;
        }
    }

    return new Mimetypes({
        discovery: {
            registry: {
                byExtension: new Map([[".binary", "application/x-readable-binary"]]),
                byFilename: new Map(),
            },
            handlers: new Map([["application/x-readable-binary", {
                mimetype: "application/x-readable-binary",
                glyph: "",
                extensions: [".binary"],
                packageName: "stub://readable-binary",
                projectionRevision: "test-1",
                binary: true,
                source: "package",
            }]]),
            packageAttributions: new Map(), skipped: [],
        },
        loader: async () => ({ default: BinaryProjectionHandler }),
    });
};

// --- {§matcher-dispatch} matcher 203 soft-fallback ---------------------------------------
// jsonpath against a `.json` entry whose body is malformed JSON: the json
// handler's parseTree fails → QueryParseFailureError → Matcher.matchAgainstContent
// maps to 203, returning the RAW bytes as the text primitive plus `reason`.

test("{§zero-width-column-one-insert} jsonpath on malformed-JSON entry returns 203 with raw bytes as text/markdown + reason", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        const k = new Workspace();
        const broken = '{"host": "db.internal", "pool":}';  // trailing-colon: not valid JSON
        await k.edit(editStmt(urlPath("workspace", "/config.json"), broken), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));

        const r = await readThroughScheme("workspace", null,
            readStmt(urlPath("workspace", "/config.json")),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        const matched = await k.find(
            { ...findStmt(urlPath("workspace", "/config.json")), matcher: { dialect: "jsonpath", raw: "$.host" } },
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(r.status, 200, "plain READ of the entry still works");
        assert.ok(matched.status === 203 || matched.status === 204, "parse failure is a soft 203 or 204");
    } finally { await db.close(); }
});

// --- {§zero-width-column-one-insert}: matcher evidence guides a later <L> -------------

test("{§op-invariants} an exact matcher FIND returns flat coordinates for a surgical follow-up READ", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, sessionId, 1, "compose");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await new Workspace().edit(
            editStmt(urlPath("workspace", "/log.txt"), "error: alpha\nok: beta\nerror: gamma"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );

        const r = await engine.dispatch({
            statement: {
                ...findStmt(urlPath("workspace", "/log.txt")),
                matcher: { dialect: "regex", raw: "/error: (\\w+)/g", pattern: "error: (\\w+)", flags: "g" } as MatcherBody,
            },
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.rowsWritten ?? 1, 1);

        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            session_id: sessionId,
            loop_seq: 1,
            turn_seq: 1,
            sequence: 1,
        });
        const rx = JSON.parse(row!.rx) as {
            results: Array<{
                region?: {
                    startLine: number;
                    startColumn: number;
                    endLine: number;
                    endColumn: number;
                };
            }>;
        };

        const second = rx.results[1];
        assert.ok(second.region);
        const surgical = await readThroughScheme("workspace", null,
            {
                ...readStmt(urlPath("workspace", "/log.txt")),
                lineMarker: {
                    marks: [
                        second.region.startLine,
                        second.region.startColumn,
                        second.region.endLine,
                        second.region.endColumn,
                    ],
                },
            },
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(surgical.content, "error: gamma");
    } finally { await db.close(); }
});

// --- {§op-invariants} KILL(path#fragment) deletes only the named channel ----------
// Multi-channel entry: 410 with a #fragment must delete exactly that channel
// and leave the other channel (and the entry row) intact.

test("{§mimetype} KILL(path#fragment) deletes only the named channel; siblings remain", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-410-${crypto.randomUUID()}`, { producer: "client" });
        const { workspaceId, sessionId, loopId, turnId } = env;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // Seed a two-channel entry directly (production Session is single-channel;
        // the 410-fragment path is channel-generic, so seed both channels).
        const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/multi",
        });
        const entryId = entry!.id;
        await db.test_seed_channel.run({ entry_id: entryId, name: "body", content: "keep me", mimetype: "text/plain", state: "static" });
        await db.test_seed_channel.run({ entry_id: entryId, name: "summary", content: "delete me", mimetype: "text/plain", state: "static" });

        const r = await engine.dispatch({
            statement: killStmt(urlPath("workspace", "/multi", "summary")),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(r.status, 200, "KILL on an existing channel succeeds");

        // Entry row survives.
        const stillThere = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/multi" });
        assert.ok(stillThere !== undefined, "entry row remains — fragment delete is channel-scoped");
        // Named channel is gone.
        const summary = await db.test_get_channel.get<{ name: string }>({ entry_id: entryId, name: "summary" });
        assert.equal(summary, undefined, "the named #summary channel was deleted");
        // Sibling channel untouched.
        const body = await db.test_get_channel.get<{ name: string; content: string }>({ entry_id: entryId, name: "body" });
        assert.ok(body !== undefined, "sibling #body channel survives");
        assert.equal(body?.content, "keep me", "sibling content is intact — ONLY the named channel was removed");
    } finally { await db.close(); }
});

// --- {§mimetype} Mimetypes.process is the projection entry point -------------------
// process(input, { channels }) returns metadata plus requested projections
// ({ mimetype, ok, totalLines, symbols?/deepJson?/deepXml? }) - no preview
// post-0.15. Assert the shape against the real auto-discovered service for a
// known mimetype (markdown → symbols) and an unknown one (ok:false).

test("{§mimetype} Mimetypes.process returns metadata plus requested projections", async () => {
    const md = "# Title\n\nbody paragraph\n\n## Sub\n\nmore";
    const known = await DEFAULT_MIMETYPES.process({ content: md, hint: "text/markdown" }, { channels: ["symbols"] });
    assert.equal(known.mimetype, "text/markdown", "process echoes the resolved mimetype");
    assert.equal(known.ok, true, "ok:true when a handler produced the projection");
    assert.ok(known.totalLines > 0, "totalLines reports the content extent");
    assert.notEqual(known.symbols, undefined, "the requested symbols channel is populated");

    // Unknown mimetype: no handler → ok:false (no throw, no projection).
    const unknown = await DEFAULT_MIMETYPES.process({ content: "weird-bytes", hint: "application/x-unregistered" });
    assert.equal(unknown.mimetype, "application/x-unregistered", "hint survives even with no handler");
    assert.equal(unknown.ok, false, "ok:false signals the handler-miss");
});

// --- {§mimetype} schemes do NOT invoke mimetype handlers at write time --------------
// A spy handler instrumented on content/query. Writing resolves the mimetype
// via Mimetypes.detect and must not fire either channel. An explicit content
// projection does fire content(). Same handler, separate phases.

test("{§mimetype} write resolves mimetype and derives only the readable projection; never the handler's query", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-fire-${crypto.randomUUID()}`);
        const { workspaceId, sessionId } = env;

        const projectionCalls: string[] = [];
        const queryCalls: string[] = [];
        class SpyHandler extends BaseHandler {
            override async content(content: HandlerContent): Promise<undefined> {
                projectionCalls.push(typeof content === "string" ? content : "");
                return undefined;
            }
            override async query(content: HandlerContent, dialect: QueryDialect, pattern: string, flags?: string): Promise<never[]> {
                queryCalls.push(`${dialect}:${pattern}:${flags}`);
                return [];
            }
        }
        // Bind the spy handler to a `.spy` extension so write-time
        // PathMimetype.resolveEntryMimetype({ ext }) -> detect resolves
        // text/x-spy. text/* keeps
        // the write off the binary 415 gate (MimetypeBinary.isBinaryMimetype).
        const mimetypes = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map([[".spy", "text/x-spy"]]), byFilename: new Map() },
                handlers: new Map([["text/x-spy", {
                    mimetype: "text/x-spy", glyph: "🕵️", extensions: ["spy"],
                    packageName: "stub://spy", projectionRevision: "test-1", binary: false, source: "package",
                }]]),
                packageAttributions: new Map(), skipped: [],
            },
            loader: async () => ({ default: SpyHandler }),
        });
        await mimetypes.ready();

        // WRITE phase: Workspace.edit on a `.spy` path. Resolves mimetype via detect and asks the
        // handler for its readable projection once ({§channel-selection}); never its query.
        const edited = await new Workspace().edit(
            editStmt(urlPath("workspace", "/notes.spy"), "alpha\nbeta\ngamma"),
            makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }),
        );
        assert.equal(edited.status, 201, "write succeeded");
        // Confirm the write resolved the spy mimetype (detect ran, not the handler).
        const channel = await db.test_get_channel.get<{ mimetype: string; content: string }>({ entry_id: edited.entryId, name: "body" });
        assert.equal(channel?.mimetype, "text/x-spy", "write-time detect resolved the spy mimetype");
        assert.deepEqual(projectionCalls, ["alpha\nbeta\ngamma"], "{§channel-selection}: the write asked the handler for its projection of the stored content, once");
        assert.equal(queryCalls.length, 0, "{§mimetype}: scheme write did NOT invoke the handler's query");
        assert.equal(await db.test_get_channel.get({ entry_id: edited.entryId, name: "readable" }), undefined, "a handler without a projection leaves no sibling");

        await mimetypes.process(
            { content: channel?.content ?? "", hint: channel?.mimetype },
            { channels: ["content"] },
        );
        assert.deepEqual(projectionCalls, ["alpha\nbeta\ngamma", "alpha\nbeta\ngamma"], "explicit projection passes the stored content to the handler");
    } finally { await db.close(); }
});

test("{§binary-parity} a binary file persists only derived Unicode and refreshes when its projection identity changes (#140)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-readable-binary-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "document.binary"), Uint8Array.of(1, 2, 3, 4));
        await execFileP("git", ["add", "document.binary"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `binary-projection-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const firstMimetypes = binaryProjectionMimetypes("projection-v1");
        const firstCtx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: firstMimetypes });

        assert.deepEqual(await GitMembership.indexGitMembership(firstCtx), []);
        const entry = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({
            workspace_id: workspaceId,
            scheme: "file",
            pathname: "document.binary",
        });
        assert.ok(entry);
        assert.deepEqual(
            await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "body" }),
            {
                content: "projection-v1:1,2,3,4",
                mimetype: "text/markdown",
                weight: 6,
                state: "static",
            },
        );
        assert.deepEqual(JSON.parse(entry.attributes), {
            sourceProjection: {
                mimetype: "application/x-readable-binary",
                identity: await firstMimetypes.projectionIdentity("application/x-readable-binary"),
                disposition: "projected",
            },
        });
        const read = await readFileScheme(readStmt(localPath("document.binary")), firstCtx);
        assert.equal(read.status, 200);
        assert.equal(read.content, "projection-v1:1,2,3,4");
        assert.equal(read.mimetype, "text/markdown");

        const secondMimetypes = binaryProjectionMimetypes("projection-v2");
        const secondCtx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: secondMimetypes });
        assert.deepEqual(
            await GitMembership.indexGitMembership(secondCtx),
            [],
            "a reader-only refresh is not an ambient filesystem divergence",
        );
        const refreshed = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({
            workspace_id: workspaceId,
            scheme: "file",
            pathname: "document.binary",
        });
        assert.ok(refreshed);
        assert.deepEqual(
            await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: refreshed.id, name: "body" }),
            {
                content: "projection-v2:1,2,3,4",
                mimetype: "text/markdown",
                weight: 6,
                state: "static",
            },
        );
        assert.deepEqual(JSON.parse(refreshed.attributes), {
            sourceProjection: {
                mimetype: "application/x-readable-binary",
                identity: await secondMimetypes.projectionIdentity("application/x-readable-binary"),
                disposition: "projected",
            },
        });

        const limitedMimetypes = new Proxy(secondMimetypes, {
            get(target, property, receiver) {
                if (property === "projectionIdentity") return async () => "projection-over-limit";
                if (property === "projectReadable") {
                    return async () => {
                        throw new MimetypeInputLimitError({
                            mimetype: "application/x-readable-binary",
                            maximumBytes: 3,
                            observedBytes: 4,
                        });
                    };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        const limitedCtx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: limitedMimetypes });
        assert.deepEqual(await GitMembership.indexGitMembership(limitedCtx), []);
        const limited = await db.test_get_entry_by_path.get<{ id: number; attributes: string }>({
            workspace_id: workspaceId,
            scheme: "file",
            pathname: "document.binary",
        });
        assert.ok(limited);
        assert.deepEqual(
            await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: limited.id, name: "body" }),
            {
                content: "",
                mimetype: "application/x-readable-binary",
                weight: 0,
                state: "static",
            },
        );
        assert.deepEqual(JSON.parse(limited.attributes), {
            sourceProjection: {
                mimetype: "application/x-readable-binary",
                identity: "projection-over-limit",
                disposition: "input-limit",
                maximumBytes: 3,
                observedBytes: 4,
            },
        });
        // {§binary-parity} — the marker stays honest (no derived Unicode), and the source still reads as
        // its bytes: the raw view needs no extension and never relabels the mimetype.
        const rawView = await readFileScheme(readStmt(localPath("document.binary")), limitedCtx);
        assert.equal(rawView.status, 200, "an over-limit source reads as its bytes");
        assert.equal(rawView.content, "01\n02\n03\n04");
        assert.equal(rawView.mimetype, "application/x-readable-binary");
        assert.deepEqual(rawView.range, { unit: "byte", total: 4, requested: [1, PAGE], returned: [1, 4] });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§copy} an admitted file type survives reprojection, but not an external source change", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-retained-type-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "retained-type");
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: binaryProjectionMimetypes("first") });
        const pathname = "document.unknownext";
        const file = new File();
        const proposed = await file.writeEntry(pathname, {
            channels: { body: { content: "", bytes: Uint8Array.of(1, 2, 3, 4), mimetype: "application/x-readable-binary" } },
        }, ctx);
        assert.equal(proposed.status, 202);
        assert.equal((await file.applyResolution({ attrs: proposed.attrs as never, metadata: null }, ctx)).status, 200);
        for (const revision of ["first", "second"]) {
            const projectedCtx = makeSchemeCtx({ ...ctx, mimetypes: binaryProjectionMimetypes(revision) });
            assert.equal(await MembershipMaterialization.materializeMember(pathname, root, projectedCtx, new Map()), null);
            const read = await readFileScheme(readStmt(localPath(pathname)), projectedCtx);
            assert.equal(read.status, 200);
            assert.equal(read.mimetype, "text/markdown");
            assert.equal(read.content, `${revision}:1,2,3,4`);
        }
        const editing = await file.edit(editStmt(localPath(pathname), "not binary", { marks: [1, -1] }), ctx);
        assert.equal(editing.status, 415);
        assert.equal(editing.problem?.type, "https://problems.plurnk.xyz/scheme/file/binary-write-unsupported");
        await writeFile(join(root, pathname), "externally replaced\n");
        await MembershipMaterialization.materializeMember(pathname, root, ctx, new Map());
        const changed = await readFileScheme(readStmt(localPath(pathname)), ctx);
        assert.equal(changed.status, 200);
        assert.equal(changed.mimetype, "text/markdown");
        assert.equal(changed.content, "externally replaced\n");
        const entry = await file.readEntry(pathname, ctx);
        assert.equal(entry.entry?.attributes?.sourceProjection, undefined);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§mimetype} registry-aware classification governs file decoding, operation gates, and search eligibility (#93)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-mimetype-classification-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "readable.treeish"), "registry text needle\nsecond line\n");
        await writeFile(join(root, "opaque.encoded"), "opaque search decoy\n");
        await execFileP("git", ["add", "readable.treeish", "opaque.encoded"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", [
            "-c", "user.email=fixture@plurnk.invalid",
            "-c", "user.name=fixture",
            "-c", "commit.gpgsign=false",
            "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "-q", "-m", "seed",
        ], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `classification-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const textPackage = "stub://mimetype-text";
        const binaryPackage = "stub://mimetype-binary";
        const mimetypes = new Mimetypes({
            discovery: {
                registry: {
                    byExtension: new Map([
                        [".treeish", "application/x-treeish"],
                        [".encoded", "text/x-encoded"],
                    ]),
                    byFilename: new Map(),
                },
                handlers: new Map([
                    ["application/x-treeish", {
                        mimetype: "application/x-treeish",
                        glyph: "",
                        extensions: ["treeish"],
                        packageName: textPackage,
                        projectionRevision: "test-1",
                        binary: false,
                        source: "package",
                    }],
                    ["text/x-encoded", {
                        mimetype: "text/x-encoded",
                        glyph: "",
                        extensions: ["encoded"],
                        packageName: binaryPackage,
                        projectionRevision: "test-1",
                        binary: true,
                        source: "package",
                    }],
                ]),
                packageAttributions: new Map(), skipped: [],
            },
            loader: async (packageName) => {
                if (packageName === textPackage || packageName === binaryPackage) {
                    return { default: BaseHandler };
                }
                throw Object.assign(
                    new Error(`Cannot find package '${packageName}' imported from test`),
                    { code: "ERR_MODULE_NOT_FOUND" },
                );
            },
        });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        await GitMembership.indexGitMembership(ctx);

        const file = new File();
        const readable = await readFileScheme({
            ...readStmt(localPath("readable.treeish")),
            lineMarker: { marks: [1] },
        }, ctx);
        assert.equal(readable.status, 200);
        assert.equal(readable.content, "registry text needle");
        assert.equal((await file.edit(
            editStmt(localPath("readable.treeish"), "revised", { marks: [1] }),
            ctx,
        )).status, 202, "the handler-declared text file remains region-editable");

        const opaque = await readFileScheme({
            ...readStmt(localPath("opaque.encoded")),
            lineMarker: { marks: [1] },
        }, ctx);
        // {§binary-parity} — a handler-declared binary file reads as its bytes; `<1>` is its first byte.
        assert.equal(opaque.status, 200, "the handler-declared binary file reads as its bytes");
        assert.equal(opaque.content, "6f");
        assert.equal(opaque.range?.unit, "byte");
        assert.equal((await file.edit(
            editStmt(localPath("opaque.encoded"), "revised", { marks: [1] }),
            ctx,
        )).status, 415, "the same binary declaration governs EDIT");

        await SearchIndex.maintain(ctx);
        const searchable = await db.test_fts_search.all<{ pathname: string }>({
            workspace_id: workspaceId,
            query: "registry",
        });
        assert.deepEqual(searchable.map(({ pathname }) => pathname), ["readable.treeish"]);
        const decoys = await db.test_fts_search.all<{ pathname: string }>({
            workspace_id: workspaceId,
            query: "decoy",
        });
        assert.deepEqual(decoys, [], "handler-declared binary content never enters lexical search");

        const opaqueEntry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "file",
            pathname: "opaque.encoded",
        });
        const opaqueAttributes = await db.test_get_entry_attributes.get<{ attributes: string }>({
            workspace_id: workspaceId,
            scheme: "file",
            pathname: "opaque.encoded",
        });
        assert.deepEqual(JSON.parse(opaqueAttributes?.attributes ?? "{}"), {
            sourceProjection: {
                mimetype: "text/x-encoded",
                identity: await mimetypes.projectionIdentity("text/x-encoded"),
                disposition: "unavailable",
            },
        });
        const disposition = await db.test_derivation_disposition.get<{ disposition: string }>({
            entry_id: opaqueEntry?.id ?? -1,
        });
        assert.equal(disposition?.disposition, "unsearchable");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// {§mimetype-query} Recursive descent over a deep structural projection remains
// a valid matcher rather than becoming a depth-capped 400.
test("{§matcher-dispatch} recursive-descent jsonpath over a deep code-entry parse tree matches", async () => {
    const { db, workspaceId, sessionId, mimetypes } = await setup();
    try {
        const k = new Workspace();
        const source = [
            "export function greet(name: string): string {",
            "    const prefix = \"hello\";",
            "    return `${prefix}, ${name}`;",
            "}",
            "export function part(items: string[]): string[] {",
            "    return items.filter((x) => x.length > 0).map((x) => x.trim());",
            "}",
        ].join("\n");
        await k.edit(editStmt(urlPath("workspace", "/util.ts"), source), makeSchemeCtx({ db, workspaceId, sessionId, mimetypes }));

        const matched = await k.find(
            { ...findStmt(urlPath("workspace", "/util.ts")), matcher: { dialect: "jsonpath", raw: "$..*" } },
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.notEqual(matched.status, 400, `depth cap resurfaced as a model-blamed 400: ${matched.problem?.detail ?? ""}`);
        assert.ok(matched.status === 200 || matched.status === 204, "recursive descent over the parse tree executes without 400");
    } finally { await db.close(); }
});
});


describe("independent-roots-acquisition", () => {
// {§scheme-address}: one workspace resource, independent causal sessions.









const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

test("{§scheme-address} independent root sessions share one acquired https representation in their workspace", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    await schemes.discoverExternal(process.cwd());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const bodies = ["alpha view of the feed", "beta view of the feed"];
    let served = 0;
    // The scheme may quietly probe same-origin companions (llms.txt); only the
    // feed itself is served, in acquisition order, one representation per root.
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith("/feed")) return new Response("", { status: 404 });
        return new Response(bodies[served++] ?? "unexpected third fetch", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    });
    try {
        const workspaceId = await insertWorkspace(db, `independent-roots-${crypto.randomUUID()}`);
        const roots = await Promise.all(["alpha", "beta"].map(async (name) => {
            const sessionId = await insertSession(db, workspaceId, null, name);
            const loopId = await insertLoop(db, sessionId, 1, "go");
            const turnId = await insertTurn(db, loopId, 1, 102);
            return { sessionId, loopId, turnId };
        }));
        const dispatch = (root: (typeof roots)[number], statement: PlurnkStatement, sequence: number) =>
            engine.dispatch({ statement, workspaceId, ...root, sequence, origin: "model" });

        for (const root of roots) {
            const read = await dispatch(root, parseOne("````READ (https://example.org/feed)````"), 1);
            assert.equal(read.status, 200);
            assert.equal(read.content, bodies[0], "each root sees the same workspace representation");
        }

        const owners = await db.test_entries_by_coordinate_workspaces.all<{ workspace_id: number; content: string }>({
            scheme: "https", authority: "example.org", pathname: "/feed",
        });
        assert.deepEqual(
            owners.map(({ content }) => ({ content })),
            [{ content: bodies[0] }],
            "one resource at the workspace coordinate",
        );

        for (const root of roots) {
            const found = await dispatch(root, parseOne("````FIND (https://example.org/**)````"), 2);
            assert.equal(found.status, 200);
            assert.equal(found.matchingPathCount, 1, "FIND sees the workspace acquisition");
            const reread = await dispatch(root, parseOne("````READ (https://example.org/feed)````"), 3);
            assert.equal(reread.content, bodies[0], "re-reading resolves the same retained entry");
        }
        assert.equal(served, 1, "a second session does not re-fetch a fresh workspace representation");
    } finally {
        globalThis.fetch = originalFetch;
        await schemes.close();
        await db.close();
    }
});
});

describe("search-artifact-identity", () => {
// {§persistent-search-index}: identical derivation inputs build once, then every
// resource attaches the same complete graph/FTS artifact.










const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const edit = (pathname: string, body: string): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target: url(pathname), lineMarker: null, body,
    matcher: null, position: { line: 1, column: 1 },
});

test("{§persistent-search-index} identical entries attach one complete search artifact and both remain addressable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `artifact-share-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        let processCalls = 0;
        const mimetypes = mimetypesFixture({
            process: async (...args: Parameters<typeof DEFAULT_MIMETYPES.process>) => {
                processCalls++;
                return DEFAULT_MIMETYPES.process(...args);
            },
        });
        const writeCtx = makeSchemeCtx({ db, workspaceId, sessionId });
        const deriveCtx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });

        const body = "shared search artifact";
        await new Workspace().edit(edit("a.md", body), writeCtx);
        await new Workspace().edit(edit("b.md", body), writeCtx);
        await SearchIndex.maintain(deriveCtx);

        const rows = await db.test_entries_with_hash_by_scheme_prefix.all<{ pathname: string; deep_hash: string }>({
            workspace_id: workspaceId, scheme: "workspace", prefix: "/%",
        });
        assert.equal(rows.length, 2);
        assert.equal(rows[0].deep_hash, rows[1].deep_hash, "both pathnames point at the same derivation identity");

        const artifacts = await db.test_artifact_counts.get<{ artifacts: number; indexed: number }>({ deep_hash: rows[0].deep_hash });
        assert.deepEqual(artifacts, { artifacts: 1, indexed: 1 }, "one complete artifact owns one full-text record");
        assert.equal(processCalls, 1, "the shared content derives exactly once");

        const ranked = await EntryFts.rankCandidates(
            db,
            rows.map(({ pathname, deep_hash }) => ({ key: pathname, deepHash: deep_hash })),
            "shared artifact",
        );
        assert.deepEqual(ranked.matches.map((r) => r.key).toSorted(), ["/a.md", "/b.md"],
            "artifact sharing never collapses the independently addressable entries");
    } finally {
        await db.close();
    }
});

test("{§persistent-search-index} resolved binary classification participates in derivation identity (#93)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `classification-identity-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        let binary = false;
        let projectionIdentityCalls = 0;
        const mimetypes = mimetypesFixture({
            classify: async () => ({ binary, source: "handler" as const }),
            projectionIdentity: async () => {
                projectionIdentityCalls++;
                return "stable-projection";
            },
            process: async () => ({ symbols: [], references: [] }),
        });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        await new Workspace().edit(edit("classified.md", "classification needle"), makeSchemeCtx({ db, workspaceId, sessionId }));

        const hash = async (): Promise<string> => {
            const [row] = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string }>({
                workspace_id: workspaceId,
                scheme: "workspace",
                prefix: "/classified.md",
            });
            assert.ok(row);
            return row.deep_hash;
        };
        const hits = async (): Promise<string[]> => (await db.test_fts_search.all<{ pathname: string }>({
            workspace_id: workspaceId,
            query: "needle",
        })).map(({ pathname }) => pathname);

        await SearchIndex.maintain(ctx);
        const textHash = await hash();
        assert.deepEqual(await hits(), ["/classified.md"]);
        assert.equal(projectionIdentityCalls, 1);

        binary = true;
        await SearchIndex.maintain(ctx);
        const binaryHash = await hash();
        assert.notEqual(binaryHash, textHash, "changed classification cannot reuse the textual artifact");
        assert.deepEqual(await hits(), [], "binary classification detaches the entry from lexical search");
        assert.equal(projectionIdentityCalls, 1, "binary derivation does not depend on handler output");

        binary = false;
        await SearchIndex.maintain(ctx);
        assert.equal(await hash(), textHash, "the same classification deterministically reuses its prior artifact");
        assert.deepEqual(await hits(), ["/classified.md"]);
        assert.equal(projectionIdentityCalls, 2);
    } finally {
        await db.close();
    }
});

test("{§persistent-search-index} mimetype projection identity invalidates derived artifacts without defeating stable reuse (#175)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `projection-identity-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        let projectionIdentity = "projection-a";
        let symbolName = "Alpha";
        let processCalls = 0;
        const mimetypes = mimetypesFixture({
            projectionIdentity: async () => projectionIdentity,
            process: async () => {
                processCalls++;
                return {
                    symbols: [{ name: symbolName, kind: "function", line: 1, endLine: 1 }],
                    references: [],
                };
            },
        });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        await new Workspace().edit(
            edit("projection.md", "one stable readable body"),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );

        const hash = async (): Promise<string> => {
            const [row] = await db.test_entries_with_hash_by_scheme_prefix.all<{ deep_hash: string }>({
                workspace_id: workspaceId,
                scheme: "workspace",
                prefix: "/projection.md",
            });
            assert.ok(row);
            return row.deep_hash;
        };
        const symbols = async (deepHash: string): Promise<string[]> =>
            (await db.test_symbol_names_for_hash.all<{ name: string }>({ deep_hash: deepHash }))
                .map(({ name }) => name);

        await SearchIndex.maintain(ctx);
        const first = await hash();
        assert.deepEqual(await symbols(first), ["Alpha"]);
        assert.equal(processCalls, 1);

        await SearchIndex.maintain(ctx);
        assert.equal(await hash(), first);
        assert.equal(processCalls, 1, "an unchanged projection identity reuses the complete artifact");

        projectionIdentity = "projection-b";
        symbolName = "Beta";
        await SearchIndex.maintain(ctx);
        const revised = await hash();
        assert.notEqual(revised, first);
        assert.deepEqual(await symbols(revised), ["Beta"]);
        assert.equal(processCalls, 2, "changed projection behavior derives one new artifact");

        projectionIdentity = "projection-a";
        symbolName = "Alpha";
        await SearchIndex.maintain(ctx);
        assert.equal(await hash(), first);
        assert.deepEqual(await symbols(first), ["Alpha"]);
        assert.equal(processCalls, 2, "returning to a prior identity reattaches its complete artifact");
    } finally {
        await db.close();
    }
});
});

describe("universal-find", () => {
class PreparedDataScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "prepared",
        channels: { body: "text/markdown", details: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };

    async #materialize(pathname: string, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.write(pathname, {
            channels: {
                body: {
                    content: "the universal answer is forty-two",
                    mimetype: "text/markdown",
                },
                details: {
                    content: "auxiliary exact needle",
                    mimetype: "text/markdown",
                    producerResult: { status: 203, producer: "details-specimen" },
                },
            },
        });
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const result = await this.#materialize(request.pathname, ctx);
        return result.status >= 400 ? result : { status: 200 };
    }

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return this.#materialize("/fact.md", ctx);
    }
}

const parseFind = (dsl: string): FindStatement => {
    const item = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "FIND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "FIND") {
        throw new Error(`no FIND parsed from ${dsl}`);
    }
    return item.statement;
};

const parseRead = (dsl: string): ReadStatement => {
    const item = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "READ",
    );
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error(`no READ parsed from ${dsl}`);
    }
    return item.statement;
};



const parseSend = (dsl: string): SendStatement => {
    const item = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "SEND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "SEND") {
        throw new Error(`no SEND parsed from ${dsl}`);
    }
    return item.statement;
};

test("{§scheme-surface} data schemes inherit standard FIND after their optional preparation hook", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared", new PreparedDataScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("````FIND (prepared:///*.md) *forty-two*````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        const resources = JSON.parse(String(result.content)) as Array<Array<{
            path?: string;
            matchLocationCount?: number;
        }>>;
        assert.equal(resources.length, 1);
        assert.equal(resources[0]?.[0]?.path, "prepared:///fact.md");
        assert.equal(resources[0]?.[0]?.matchLocationCount, 1);
    } finally {
        await db.close();
    }
});

test("{§scheme-surface} exact matcher FIND invokes preparation, then returns flat match locations", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared", new PreparedDataScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-read-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("````FIND (prepared:///fact.md) *forty-two*````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            session_id: sessionId,
            loop_seq: 1,
            turn_seq: 1,
            sequence: 1,
        });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            content?: string;
            results?: Array<{
                region?: {
                    startLine: number;
                    startColumn: number;
                    endLine: number;
                    endColumn: number;
                };
            }>;
        };
        assert.equal(rx.results?.length, 1);
        assert.ok(rx.results?.[0]?.region !== undefined);
    } finally {
        await db.close();
    }
});

test("{§find}: exact FIND composes the selected channel's producer result", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared", new PreparedDataScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-channel-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("````FIND (prepared:///fact.md#details) *exact needle*````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 203);
        assert.equal(result.producer, "details-specimen");
        assert.equal(result.matchingPathCount, 1);
        assert.equal(result.matchLocationCount, 1);
    } finally {
        await db.close();
    }
});

test("{§revalidation} exact URL FIND acquires live HTTP resources, reuses them, and rejects dead URLs", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const http = new Http();
    schemes.register("https", http);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const url = "https://93.184.216.34/igor-smirnov";
    const deadUrl = "https://93.184.216.34/missing";
    globalThis.fetch = (async (input: string | URL | Request) => {
        const requested = requestUrl(input);
        if (requested.endsWith("/llms.txt")) return new Response(null, { status: 404 });
        requests.push(requested);
        if (requested === deadUrl) return new Response("missing", { status: 404 });
        return new Response("Zhannetta Nikolaevna Lotnik was his spouse.", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-http-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind(`\`\`\`\`FIND (${url}) /Zhannetta/\`\`\`\``),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.deepEqual(requests, [url]);
        assert.equal((JSON.parse(String(result.content)) as unknown[]).length, 1);
        assert.doesNotMatch(String(result.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const reused = await engine.dispatch({
            statement: parseFind(`\`\`\`\`FIND (${url})\`\`\`\``),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 2,
            origin: "model",
        });
        assert.equal(reused.status, 200);
        assert.deepEqual(requests, [url]);
        assert.match(String(reused.content), new RegExp(url.replaceAll(".", "\\.")));
        assert.doesNotMatch(String(reused.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const surveyed = await engine.dispatch({
            statement: parseFind("````FIND (https://93.184.216.34/*) /spouse/````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 3,
            origin: "model",
        });
        assert.equal(surveyed.status, 200);
        assert.deepEqual(requests, [url]);
        assert.match(String(surveyed.content), new RegExp(url.replaceAll(".", "\\.")));
        assert.match(String(surveyed.content), /"matchLocationCount":1/);
        assert.doesNotMatch(String(surveyed.content), /Zhannetta Nikolaevna Lotnik was his spouse/);

        const dead = await engine.dispatch({
            statement: parseFind(`\`\`\`\`FIND (${deadUrl})\`\`\`\``),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 4,
            origin: "model",
        });
        assert.equal(dead.status, 404);
        assert.equal(dead.problem?.type, "https://problems.plurnk.xyz/scheme/http/http-response-status");
        assert.deepEqual(requests, [url, deadUrl]);

        const reusedDead = await engine.dispatch({
            statement: parseFind(`\`\`\`\`FIND (${deadUrl})\`\`\`\``),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 5,
            origin: "model",
        });
        assert.equal(reusedDead.status, 404, "reacquisition preserves the exact producer result");
        assert.deepEqual(requests, [url, deadUrl, deadUrl]);
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("{§http-manifest} HTTP mutation responses cannot satisfy later READ or exact FIND acquisition", async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const http = new Http();
    schemes.register("https", http);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string }> = [];
    const readUrl = "https://93.184.216.34/mutation-read";
    const findUrl = "https://93.184.216.34/mutation-find";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.endsWith("/llms.txt")) return new Response(null, { status: 404 });
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        const body = method === "GET"
            ? `current GET representation for ${url}`
            : `mutation response for ${url}`;
        return new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    });
    try {
        const workspaceId = await insertWorkspace(db, `http-method-provenance-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        // {§http-manifest} — the SEND below is an outbound mutation, so it proposes. This
        // test is about method provenance, not consent: the test configures server acceptance.
        const loopId = await insertLoop(db, sessionId, 1, "");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const dispatch = (statement: FindStatement | ReadStatement | SendStatement, sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence,
            origin: "model",
        });

        assert.equal((await dispatch(parseSend(`\`\`\`\`SEND (${readUrl})
update
\`\`\`\``), 1)).status, 102);
        assert.equal((await dispatch(parseRead(`\`\`\`\`READ (${readUrl})\`\`\`\``), 2)).status, 200);
        const readEntry = await db.test_get_entry_by_coordinate.get<{ id: number }>({
            scheme: "https",
            authority: "93.184.216.34",
            pathname: "/mutation-read",
        });
        assert.ok(readEntry !== undefined);
        const readChannels = await db.entry_read_channels.all<{ name: string; content: string }>({ entry_id: readEntry.id });
        assert.equal(readChannels.find(({ name }) => name === "body")?.content, `current GET representation for ${readUrl}`);

        assert.equal((await dispatch(parseSend(`\`\`\`\`SEND (${findUrl})
update
\`\`\`\``), 3)).status, 102);
        const found = await dispatch(parseFind(`\`\`\`\`FIND (${findUrl}) /current GET/\`\`\`\``), 4);
        assert.equal(found.status, 200);
        assert.equal((JSON.parse(String(found.content)) as unknown[]).length, 1);
        assert.deepEqual(requests, [
            { url: readUrl, method: "POST" },
            { url: readUrl, method: "GET" },
            { url: findUrl, method: "POST" },
            { url: findUrl, method: "GET" },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
        await db.close();
    }
});

test("{§op-methods-op-dispatch} non-data schemes without FIND remain honestly unsupported", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    class ControlScheme {
        static manifest: SchemeManifest = {
            name: "control-only",
            channels: {},
            defaultChannel: "body",
            category: "control",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        };
    }
    schemes.register("control-only", new ControlScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-control-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("````FIND (control-only:///**)````"),
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 501);
    } finally {
        await db.close();
    }
});
});

describe("warm-workspace-derivations", () => {
// {§persistent-search-index} — Engine.warmWorkspaceDerivations runs the derivation pump at
// workspace scope (no loop), so explicit membership work can overlap an upcoming model turn.
// Here we drive the seam directly and assert it (1) derives the deep channels (FTS proves the
// pump ran with no loopId) and (2) live-fans-out search_progress notices before any turn.



















const weigh = (text: string): number => Math.ceil(text.length / 4);

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

test("{§mimetype-parser-coordinates}: startup warming accepts CRLF Python comment spans", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const mimetypes = new Mimetypes();
    t.after(() => mimetypes.dispose());
    const workspaceId = await insertWorkspace(db, `warm-crlf-${crypto.randomUUID()}`);
    const content = "# 😀\r\ndef value():\r\n    return helper() # trailing\r\n";
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "workspace", pathname: "/example.py",
        channel: "body", mimetype: "text/x-python", content,
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh, mimetypes });

    await engine.warmWorkspaceDerivations(workspaceId);

    assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "complete");
    assert.deepEqual(await fts(db, workspaceId, "helper"), ["/example.py"]);
    const body = await db.ops_read_channel.get<{ content: string }>({
        workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/example.py", channel: "body",
    });
    assert.equal(body?.content, content, "derivation preserves the original line endings");
});

test("{§persistent-search-index}: workspace warming derives deep channels without a loop and fans out progress", async () => {
    const db = await openMigrated();
    try {
        const notices: Array<{ workspaceId: number; loopId: number; notice: Notice }> = [];
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), weigh,
            noticeNotify: (workspaceId, { loopId, notice }) => notices.push({ workspaceId, loopId, notice: notice }),
        });
        const workspaceId = await insertWorkspace(db, `warm-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        // A multi-entry corpus — exactly the "initial ingest" case that otherwise looks frozen on turn 1.
        await new Workspace().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Workspace().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await new Workspace().edit(editStmt(url("cart.ts"), "export function addToCart() {}\n"), ctx);

        // Warm at workspace scope — the seam workspace.create fires. No loop/turn exists.
        await engine.warmWorkspaceDerivations(workspaceId);

        // The pump ran: every entry's body is FTS-indexed, addressable with no loop ever opened.
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"], "warm indexed pay.ts");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "warm indexed auth.ts");
        assert.deepEqual(await fts(db, workspaceId, "addToCart"), ["/cart.ts"], "warm indexed cart.ts");

        // Startup progress streamed to the client — search_progress, workspace-scoped (loopId 0, never a real loop).
        const progress = notices.filter((t) => t.notice.kind === "search_progress");
        assert.ok(progress.length > 0, "warm fans out search_progress for the multi-entry ingest");
        assert.ok(progress.every((p) => p.loopId === 0), "workspace-scope progress carries loopId 0 (no turn yet)");
        const first = progress[0];
        assert.ok(first, "the lifecycle has an opening state");
        assert.equal(first.notice.phase, "preparing", "real work opens one lifecycle");
        assert.equal(first.notice.total, 3, "progress totals the whole corpus");
        assert.ok(progress.slice(1, -1).every((p) => p.notice.phase === "indexing" && p.notice.percent !== 100), "intermediate heartbeats never impersonate completion");
        assert.equal((progress.at(-1)?.notice as { phase?: unknown } | undefined)?.phase, "complete", "warm emits an explicit terminal state");
    } finally {
        await db.close();
    }
});

test("{§persistent-search-index}: workspace warm materializes a fresh repository before deriving it", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plurnk-warm-repo-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    execSync("git init -q && git config user.email fixture@plurnk.invalid && git config user.name fixture", { cwd: root, env: hermeticGitEnv() });
    writeFileSync(join(root, "orientation.md"), "repository orientation evidence\n");
    execSync("git add orientation.md && git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --no-verify -qm seed", { cwd: root, env: hermeticGitEnv() });

    const db = await openMigrated();
    try {
        const notices: Array<{ notice: Notice }> = [];
        let rescan: Promise<void> | undefined;
        let requestedRescan = false;
        let workspaceId = 0;
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), weigh,
            noticeNotify: (_workspaceId, payload) => {
                const notice = payload.notice;
                notices.push({ notice });
                if (notice.phase === "preparing" && !requestedRescan) {
                    assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "preparing", "latest state is queryable while no notice stream is attached");
                    requestedRescan = true;
                    rescan = engine.warmWorkspaceDerivations(workspaceId);
                }
            },
        });
        const workspace = await db.envelope_insert_workspace.get<{ id: number }>({
            name: `warm-repo-${crypto.randomUUID()}`, project_root: root, settings: "{}",
        });
        assert.ok(workspace);
        workspaceId = workspace.id;

        await engine.warmWorkspaceDerivations(workspaceId);
        await rescan;

        const body = await db.ops_read_channel.get<{ content: string }>({
            workspace_id: workspaceId, scheme: "file", authority: "", pathname: "orientation.md", channel: "body",
        });
        assert.equal(body?.content, "repository orientation evidence\n", "warm reads repository members from disk before deriving");
        const phases = notices.filter((t) => t.notice.kind === "search_progress").map((t) => t.notice.phase);
        assert.deepEqual(phases, ["preparing", "complete"], "the coalesced no-op rescan emits no counterfeit lifecycle");
        assert.equal(engine.workspaceDerivationStatus(workspaceId)?.phase, "complete", "terminal state remains queryable for a late client");
    } finally {
        await db.close();
    }
});

test("{§persistent-search-index} a model turn joins an in-flight startup warm before calling its provider", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `warm-join-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait for semantics");
        const mimetypes = new Mimetypes();
        await mimetypes.ready();
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        await new Workspace().edit(editStmt(url("orientation.md"), "semantic orientation evidence\n"), ctx);

        let release!: () => void;
        const blocked = new Promise<void>((res) => { release = res; });
        let entered!: () => void;
        const processing = new Promise<void>((res) => { entered = res; });
        const originalProcess = mimetypes.process.bind(mimetypes);
        let first = true;
        mimetypes.process = async (...args): Promise<Awaited<ReturnType<typeof originalProcess>>> => {
            if (first) {
                first = false;
                entered();
                await blocked;
            }
            return originalProcess(...args);
        };

        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh, mimetypes });
        const response: MockResponse = {
            assistant: {
                content: "",
                ops: [{ op: "SEND", aside: null, target: null, metadata: null, lineMarker: null, body: null, position: { line: 1, column: 1 } }],
                reasoning: null,
            },
        };
        const provider = new Mock({ contextWindow: 4096, responses: [response] });

        const warm = engine.warmWorkspaceDerivations(workspaceId);
        await processing;
        const turn = engine.runTurn({
            provider, workspaceId, sessionId, loopId, turnNumber: 1,
            messages: [{ role: "system", content: "test" }, { role: "user", content: "go" }],
        });
        await new Promise<void>((res) => setImmediate(res));
        assert.equal(provider.remaining, 1, "provider is untouched while semantic coverage is incomplete");

        release();
        await warm;
        await turn;
        assert.equal(provider.remaining, 0, "provider runs after the joined warm completes");
    } finally {
        await db.close();
    }
});
});

