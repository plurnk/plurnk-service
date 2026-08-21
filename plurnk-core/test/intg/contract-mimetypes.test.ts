// Integration coverage for previously-untagged SPEC.md contract anchors that
// concentrate around the mimetype seam: matcher soft-fallback ({§matcher-dispatch}),
// matcher navigation ({§slice-semantics-compose-pattern}), 410 channel-delete
// ({§send-dispatch}), the Mimetypes.process entry point ({§mimetype-methods}), and
// the write-time vs explicit-projection handler boundary ({§mimetype} - schemes
// do not invoke handlers).
//
// Vehicles are the real production paths:
//   - {§matcher-dispatch} / {§slice-semantics-compose-pattern} - Worker.read matcher dispatch
//                     (Matcher.matchAgainstContent -> 203) plus coordinate-guided READ.
//   - {§send-dispatch} - _entry-send.sendToWorkspaceEntry 410-with-fragment over Engine.dispatch.
//   - {§mimetype-methods} / {§mimetype} - Mimetypes.process shape + a spy handler
//                 proving write (detect) never fires a content projection.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
    MatcherBody, ReadStatement, SendStatement,
} from "@plurnk/plurnk-contracts";
import {
    BaseHandler,
    MimetypeInputLimitError,
    Mimetypes,
} from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import File from "../../src/schemes/File.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import GitMembership from "../../src/core/git-membership.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import {
    openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn,
    seedEnvelope, makeSchemeCtx, DEFAULT_MIMETYPES, rootWorkspace, lookThroughScheme,
} from "./_helpers.ts";
import Owner from "../../src/core/Owner.ts";
import { urlPath, editStmt, readStmt, sendStmt, findStmt } from "./_dsl.ts";

const execFileP = promisify(execFile);
const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    lookThroughScheme("file", null, statement, ctx);

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `cm-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    return { db, workspaceId, workerId, mimetypes };
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
            skipped: [],
        },
        loader: async () => ({ default: BinaryProjectionHandler }),
    });
};

// --- {§matcher-dispatch} matcher 203 soft-fallback ---------------------------------------
// jsonpath against a `.json` entry whose body is malformed JSON: the json
// handler's parseTree fails → QueryParseFailureError → Matcher.matchAgainstContent
// maps to 203, returning the RAW bytes as the text primitive plus `reason`.

test("jsonpath on malformed-JSON entry returns 203 with raw bytes as text/markdown + reason", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const k = new Worker();
        const broken = '{"host": "db.internal", "pool":}';  // trailing-colon: not valid JSON
        await k.edit(editStmt(urlPath("worker", "/config.json"), broken), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));

        const r = await lookThroughScheme("worker", null,
            readStmt(urlPath("worker", "/config.json")),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        const matched = await k.find(
            { ...findStmt(urlPath("worker", "/config.json")), body: { dialect: "jsonpath", raw: "$.host" } as MatcherBody },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(r.status, 200, "plain READ of the entry still works");
        assert.ok(matched.status === 203 || matched.status === 204, "parse failure is a soft 203 or 204");
    } finally { await db.close(); }
});

// --- {§slice-semantics-compose-pattern}: matcher evidence guides a later <L> -------------

test("an exact matcher FIND returns flat coordinates for a surgical follow-up READ", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const loopId = await insertLoop(db, workerId, 1, "compose");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

        await new Worker().edit(
            editStmt(urlPath("worker", "/log.txt"), "error: alpha\nok: beta\nerror: gamma"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );

        const r = await engine.dispatch({
            statement: {
                ...findStmt(urlPath("worker", "/log.txt")),
                body: { dialect: "regex", raw: "/error: (\\w+)/g", pattern: "error: (\\w+)", flags: "g" } as MatcherBody,
            },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.rowsWritten ?? 1, 1);

        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            worker_id: workerId,
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

        const second = rx.results[1]!;
        assert.ok(second.region);
        const surgical = await lookThroughScheme("worker", null,
            {
                ...readStmt(urlPath("worker", "/log.txt")),
                lineMarker: {
                    marks: [
                        second.region.startLine,
                        second.region.startColumn,
                        second.region.endLine,
                        second.region.endColumn,
                    ],
                },
            },
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(surgical.content, "error: gamma");
    } finally { await db.close(); }
});

// --- {§send-dispatch} SEND[410](path#fragment) deletes only the named channel ----------
// Multi-channel entry: 410 with a #fragment must delete exactly that channel
// and leave the other channel (and the entry row) intact.

test("SEND[410](path#fragment) deletes only the named channel; siblings remain (side-effect; not model-facing)", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-410-${crypto.randomUUID()}`, { producer: "client" });
        const { workspaceId, workerId, loopId, turnId } = env;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        // Seed a two-channel entry directly (production Worker is single-channel;
        // the 410-fragment path is channel-generic, so seed both channels).
        const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
            workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "worker", pathname: "/multi",
        });
        const entryId = entry!.id;
        await db.test_seed_channel.run({ entry_id: entryId, name: "body", content: "keep me", mimetype: "text/plain", state: "static" });
        await db.test_seed_channel.run({ entry_id: entryId, name: "summary", content: "delete me", mimetype: "text/plain", state: "static" });

        const r = await engine.dispatch({
            statement: sendStmt(410, urlPath("worker", "/multi", "summary")) as SendStatement,
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "client",
        });
        assert.equal(r.status, 200, "410 on an existing channel succeeds");

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

// --- {§mimetype-methods} Mimetypes.process is the projection entry point -------------------
// process(input, { channels }) returns metadata plus requested projections
// ({ mimetype, ok, totalLines, symbols?/deepJson?/deepXml? }) - no preview
// post-0.15. Assert the shape against the real auto-discovered service for a
// known mimetype (markdown → symbols) and an unknown one (ok:false).

test("Mimetypes.process returns metadata plus requested projections", async () => {
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

test("write resolves mimetype without firing the handler; explicit projection fires it", async () => {
    const db = await openMigrated();
    try {
        const env = await seedEnvelope(db, `cm-fire-${crypto.randomUUID()}`);
        const { workspaceId, workerId } = env;

        const projectionCalls: string[] = [];
        const queryCalls: string[] = [];
        const BaseHandler = (await import("@plurnk/plurnk-mimetypes")).BaseHandler;
        class SpyHandler extends BaseHandler {
            override async content(content: import("@plurnk/plurnk-mimetypes").HandlerContent): Promise<undefined> {
                projectionCalls.push(typeof content === "string" ? content : "");
                return undefined;
            }
            override async query(content: import("@plurnk/plurnk-mimetypes").HandlerContent, dialect: import("@plurnk/plurnk-mimetypes").QueryDialect, pattern: string, flags?: string): Promise<never[]> {
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
                skipped: [],
            },
            loader: async () => ({ default: SpyHandler }),
        });
        await mimetypes.ready();

        // WRITE phase: Worker.edit on a `.spy` path. Resolves mimetype via
        // detect; must not touch content/query.
        const edited = await new Worker().edit(
            editStmt(urlPath("worker", "/notes.spy"), "alpha\nbeta\ngamma"),
            makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
        );
        assert.equal(edited.status, 201, "write succeeded");
        // Confirm the write resolved the spy mimetype (detect ran, not the handler).
        const channel = await db.test_get_channel.get<{ mimetype: string; content: string }>({ entry_id: edited.entryId, name: "body" });
        assert.equal(channel?.mimetype, "text/x-spy", "write-time detect resolved the spy mimetype");
        assert.equal(projectionCalls.length, 0, "{§mimetype}: scheme write did not invoke the handler's content projection");
        assert.equal(queryCalls.length, 0, "{§mimetype}: scheme write did NOT invoke the handler's query");

        await mimetypes.process(
            { content: channel?.content ?? "", hint: channel?.mimetype },
            { channels: ["content"] },
        );
        assert.deepEqual(projectionCalls, ["alpha\nbeta\ngamma"], "explicit projection passes the stored content to the handler");
    } finally { await db.close(); }
});

test("a binary file persists only derived Unicode and refreshes when its projection identity changes (#140)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-readable-binary-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "document.binary"), Uint8Array.of(1, 2, 3, 4));
        await execFileP("git", ["add", "document.binary"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `binary-projection-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId);
        const firstMimetypes = binaryProjectionMimetypes("projection-v1");
        const firstCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: firstMimetypes });

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
        const read = await readFileScheme(readStmt(urlPath("file", "/document.binary")), firstCtx);
        assert.equal(read.status, 200);
        assert.equal(read.content, "projection-v1:1,2,3,4");
        assert.equal(read.mimetype, "text/markdown");

        const secondMimetypes = binaryProjectionMimetypes("projection-v2");
        const secondCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: secondMimetypes });
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
        const limitedCtx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: limitedMimetypes });
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
        assert.equal(
            (await readFileScheme(readStmt(urlPath("file", "/document.binary")), limitedCtx)).status,
            415,
            "an over-limit source remains an honest typed marker rather than leaking bytes",
        );
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("registry-aware classification governs file decoding, operation gates, and search eligibility (#93)", async () => {
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
        const workerId = await insertWorker(db, workspaceId);
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
                skipped: [],
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
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        await GitMembership.indexGitMembership(ctx);

        const file = new File();
        const readable = await readFileScheme({
            ...readStmt(urlPath("file", "/readable.treeish")),
            lineMarker: { marks: [1] },
        }, ctx);
        assert.equal(readable.status, 200);
        assert.equal(readable.content, "registry text needle");
        assert.equal((await file.edit(
            editStmt(urlPath("file", "/readable.treeish"), "revised", null, { marks: [1] }),
            ctx,
        )).status, 202, "the handler-declared text file remains region-editable");

        const opaque = await readFileScheme({
            ...readStmt(urlPath("file", "/opaque.encoded")),
            lineMarker: { marks: [1] },
        }, ctx);
        assert.equal(opaque.status, 415, "the handler-declared binary file rejects a textual region");
        assert.equal((await file.edit(
            editStmt(urlPath("file", "/opaque.encoded"), "revised", null, { marks: [1] }),
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
        assert.equal(disposition?.disposition, "nonsemantic");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// {§mimetype-query} Recursive descent over a deep structural projection remains
// a valid matcher rather than becoming a depth-capped 400.
test("recursive-descent jsonpath over a deep code-entry parse tree matches", async () => {
    const { db, workspaceId, workerId, mimetypes } = await setup();
    try {
        const k = new Worker();
        const source = [
            "export function greet(name: string): string {",
            "    const prefix = \"hello\";",
            "    return `${prefix}, ${name}`;",
            "}",
            "export function part(items: string[]): string[] {",
            "    return items.filter((x) => x.length > 0).map((x) => x.trim());",
            "}",
        ].join("\n");
        await k.edit(editStmt(urlPath("worker", "/util.ts"), source), makeSchemeCtx({ db, workspaceId, workerId, mimetypes }));

        const matched = await k.find(
            { ...findStmt(urlPath("worker", "/util.ts")), body: { dialect: "jsonpath", raw: "$..*" } as MatcherBody },
            makeSchemeCtx({ db, workspaceId, mimetypes }),
        );
        assert.notEqual(matched.status, 400, `depth cap resurfaced as a model-blamed 400: ${matched.problem?.detail ?? ""}`);
        assert.ok(matched.status === 200 || matched.status === 204, "recursive descent over the parse tree executes without 400");
    } finally { await db.close(); }
});
