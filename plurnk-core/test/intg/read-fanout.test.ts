// Multi-resource READ fan-out. FIND selects resources; READ returns one row per
// resource with match coordinates available for a later surgical READ.

import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement, MatcherBody, ParsedPath, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import Log from "../../src/schemes/Log.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null, body: MatcherBody | null = null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const seed = async (db: Db, workspaceId: number, workerId: number, mimetypes: Mimetypes, path: string, content: string): Promise<void> => {
    await new Worker().edit(
        { op: "EDIT", suffix: "", signal: null, target: urlPath("worker", path), lineMarker: null, body: content, position: { line: 1, column: 1 } },
        makeSchemeCtx({ db, workspaceId, workerId, mimetypes }),
    );
};

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `fanout-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "fanout");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes });
    return { db, workspaceId, workerId, loopId, turnId, mimetypes, schemes, engine };
};

// Read a fanned log row's body by its turn coordinate (log:///1/1/<seq>).
const rowBody = async (db: Db, workerId: number, mimetypes: Mimetypes, seq: number): Promise<{ status: number; content: string | null; startLine?: number | null }> => {
    const r = await new Log().read(readStmt(urlPath("log", `/1/1/${seq}`)), makeSchemeCtx({ db, workerId, mimetypes }));
    return { status: r.status, content: r.content, startLine: r.startLine };
};

test("a matcher READ fans out to one row per selected resource", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        // france sits on a line of a (line 2) and b (line 1); c never matches.
        await seed(db, workspaceId, workerId, mimetypes, "/a", "intro\nfrance alpha\ntail");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "france beta\nmore");
        await seed(db, workspaceId, workerId, mimetypes, "/c", "italy\nspain");

        const r = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });

        assert.equal(r.status, 200);
        assert.equal(r.rowsWritten, 2);
        assert.deepEqual(r.fannedStatuses, [200, 200]);

        const rxOf = async (seq: number): Promise<{
            content?: string;
            matches?: Array<{ region?: { startLine: number } }>;
        }> => {
            const row = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: seq });
            return JSON.parse(row!.rx) as {
                content?: string;
                matches?: Array<{ region?: { startLine: number } }>;
            };
        };
        const stored = [await rxOf(1), await rxOf(2)];
        assert.deepEqual(stored.map(({ content }) => content).toSorted(), [
            "france beta\nmore",
            "intro\nfrance alpha\ntail",
        ]);
        assert.deepEqual(stored.map(({ matches }) => matches?.[0]?.region?.startLine).toSorted(), [1, 2]);
    } finally { await db.close(); }
});

test("a scoped matcher READ selects full resources then projects the range from each resource", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", "a heading\na context\nneedle one\nneedle two");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "b heading\nb context\nneedle");
        await seed(db, workspaceId, workerId, mimetypes, "/c", "c heading\nc context\nabsent");

        const statement: ReadStatement = {
            ...readStmt(urlPath("worker", "/**"), {
                dialect: "regex",
                raw: "/needle/g",
                pattern: "needle",
                flags: "g",
            }),
            lineMarker: { marks: [1, 2] },
        };
        const result = await engine.dispatch({
            statement,
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(result.rowsWritten, 2);
        assert.deepEqual(result.fannedStatuses, [200, 200]);

        const rows = await Promise.all([1, 2].map((sequence) =>
            db.log_read_by_coordinate.get<{ op: string; rx: string }>({
                worker_id: workerId,
                loop_seq: 1,
                turn_seq: 1,
                sequence,
            }),
        ));
        assert.ok(rows.every((row) => row !== undefined));

        assert.ok(rows.every((row) => row!.op === "READ"));

        const projected = rows.map((row) => JSON.parse(row!.rx) as { content: string; startLine: number | null });
        assert.deepEqual(
            projected.map(({ content, startLine }) => ({ content, startLine })).toSorted((a, b) => a.content.localeCompare(b.content)),
            [
                { content: "a heading\na context", startLine: 1 },
                { content: "b heading\nb context", startLine: 1 },
            ],
        );
        assert.doesNotMatch(projected.map(({ content }) => content).join("\n"), /needle/, "the matcher selects resources; the scope controls delivered text");
    } finally { await db.close(); }
});

test("a scoped matcher READ with no matching resource returns 204 instead of paginating an empty match set", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n"));
        const result = await engine.dispatch({
            statement: {
                ...readStmt(urlPath("worker", "/a"), {
                    dialect: "glob",
                    raw: "EVALUATOR_FUNCTIONS",
                }),
                lineMarker: { marks: [30, 100] },
            },
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 204);
        const row = await db.log_read_by_coordinate.get<{ status_rx: number; rx: string }>({
            worker_id: workerId,
            loop_seq: 1,
            turn_seq: 1,
            sequence: 1,
        });
        assert.equal(row?.status_rx, 204);
        assert.equal((JSON.parse(row!.rx) as { problem?: unknown }).problem, undefined);
    } finally { await db.close(); }
});

test("the dispatcher preserves READ text scope across a registered scheme boundary", async () => {
    const seen: { find?: FindStatement; read?: ReadStatement } = {};
    class Probe {
        static manifest = {
            name: "probe",
            channels: { body: "text/plain" },
            defaultChannel: "body",
            category: "data" as const,
            scope: "workspace" as const,
            writableBy: ["plugin"] as const,
            volatile: false,
            modelVisible: true,
        };

        async find(statement: FindStatement): Promise<{
            status: number;
            content: string;
            mimetype: string;
            results: [];
            itemsTokenTotal: number;
            pathnames: string[];
            matches: Array<{
                pathname: string;
                matches: Array<{
                    region: {
                        startLine: number;
                        startColumn: number;
                        endLine: number;
                        endColumn: number;
                    };
                }>;
            }>;
        }> {
            seen.find = statement;
            return {
                status: 200,
                content: "[]",
                mimetype: "application/json",
                results: [],
                itemsTokenTotal: 3,
                pathnames: ["/doc"],
                matches: [{
                    pathname: "/doc",
                    matches: [{
                        region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 7 },
                    }],
                }],
            };
        }

        async read(statement: ReadStatement): Promise<{ status: number; content: string; mimetype: string; startLine: number }> {
            seen.read = statement;
            return { status: 200, content: "heading\ncontext", mimetype: "text/markdown", startLine: 1 };
        }
    }

    const { db, workspaceId, workerId, loopId, turnId, schemes, engine } = await setup();
    try {
        schemes.register("probe", new Probe());
        const result = await engine.dispatch({
            statement: {
                ...readStmt(urlPath("probe", "/**"), {
                    dialect: "regex",
                    raw: "/needle/",
                    pattern: "needle",
                    flags: "",
                }),
                lineMarker: { marks: [1, 2] },
            },
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.equal(seen.find?.lineMarker, null);
        assert.deepEqual(seen.find?.body, {
            dialect: "regex",
            raw: "/needle/",
            pattern: "needle",
            flags: "",
        });
        assert.deepEqual(seen.read?.lineMarker, { marks: [1, 2] });
        assert.equal(seen.read?.body, null, "the scheme does not repeat the matcher after FIND selected the resource");
    } finally { await db.close(); }
});

test("semantic READ separates similarity threshold from text projection", async () => {
    const cases = [
        {
            marker: { marks: [0.7, 10, 20] as [number, ...number[]] },
            findMarker: { marks: [0.7] },
            readMarker: { marks: [10, 20] },
        },
        {
            marker: { marks: [10, 20] as [number, ...number[]] },
            findMarker: null,
            readMarker: { marks: [10, 20] },
        },
        {
            marker: { marks: [0.7, 12, 5, 12, 20] as [number, ...number[]] },
            findMarker: { marks: [0.7] },
            readMarker: { marks: [12, 5, 12, 20] },
        },
    ];

    for (const expected of cases) {
        const seen: { find?: FindStatement; read?: ReadStatement } = {};
        class SemanticProbe {
            static manifest = {
                name: "semantic-probe",
                channels: { body: "text/plain" },
                defaultChannel: "body",
                category: "data" as const,
                scope: "workspace" as const,
                writableBy: ["plugin"] as const,
                volatile: false,
                modelVisible: true,
            };

            async find(statement: FindStatement) {
                seen.find = statement;
                return {
                    status: 200,
                    content: "[]",
                    mimetype: "application/json",
                    results: [],
                    itemsTokenTotal: 1,
                    pathnames: ["/doc"],
                    matches: [{
                        pathname: "/doc",
                        matches: [{
                            region: {
                                startLine: 30,
                                startColumn: 1,
                                endLine: 30,
                                endColumn: 8,
                            },
                        }],
                    }],
                };
            }

            async read(statement: ReadStatement) {
                seen.read = statement;
                return { status: 200, content: "projected", mimetype: "text/plain", startLine: 10 };
            }
        }

        const { db, workspaceId, workerId, loopId, turnId, schemes, engine } = await setup();
        try {
            schemes.register("semantic-probe", new SemanticProbe());
            await engine.dispatch({
                statement: {
                    ...readStmt(urlPath("semantic-probe", "/**"), {
                        dialect: "semantic",
                        raw: "~database failure",
                    } as MatcherBody),
                    lineMarker: expected.marker,
                },
                workspaceId,
                workerId,
                loopId,
                turnId,
                sequence: 1,
                origin: "model",
            });

            assert.deepEqual(seen.find?.lineMarker, expected.findMarker);
            assert.deepEqual(seen.read?.lineMarker, expected.readMarker);
            assert.equal(seen.read?.body, null);
        } finally { await db.close(); }
    }
});

test("a glob READ with zero matches writes a single 204 row, not silence", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", "italy");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "spain");
        const r = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 204);
        assert.equal(r.rowsWritten, 1, "no matches still mints one row the model can see");
    } finally { await db.close(); }
});

test("trailing slash is ordinary resource syntax unless the scheme declares folder scopes", async () => {
    class OpaqueResource {
        static manifest = {
            name: "opaque", channels: { body: "text/markdown" }, defaultChannel: "body",
            category: "data" as const, scope: "workspace" as const, writableBy: ["plugin"] as const,
            volatile: false, modelVisible: true,
        };
        async read() { return { status: 200, content: "opaque root resource", mimetype: "text/markdown" }; }
        async find() { throw new Error("undeclared folder scope must never invoke FIND"); }
    }
    const { db, workspaceId, workerId, loopId, turnId, schemes, engine } = await setup();
    try {
        schemes.register("opaque", new OpaqueResource());
        const result = await engine.dispatch({
            statement: readStmt(urlPath("opaque", "/")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: workerId, loop_seq: 1, turn_seq: 1, sequence: 1 });
        assert.match(row?.rx ?? "", /opaque root resource/);
    } finally { await db.close(); }
});

test("a declared folder scope still fans out on trailing slash", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/notes/a", "alpha");
        await seed(db, workspaceId, workerId, mimetypes, "/notes/b", "beta");
        const result = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/notes/")),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
        assert.equal(result.rowsWritten, 2);
        assert.deepEqual(result.fannedStatuses, [200, 200]);
    } finally { await db.close(); }
});

test("an over-budget matcher READ writes one bounded 413 and zero deliveries", async () => {
    const prev = process.env.PLURNK_SERVICE_FIND_MAX_MATCHES;
    process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = "2";
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", "france one");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "france two");
        await seed(db, workspaceId, workerId, mimetypes, "/c", "france three");
        const r = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 413);
        assert.equal(r.rowsWritten, 1);
        const row = await db.log_read_by_coordinate.get<{ op: string; status_rx: number; rx: string }>({
            worker_id: workerId,
            loop_seq: 1,
            turn_seq: 1,
            sequence: 1,
        });
        assert.deepEqual([row?.op, row?.status_rx], ["READ", 413]);
        const problem = (JSON.parse(row!.rx) as { problem?: Record<string, unknown> }).problem;
        assert.equal(problem?.type, "https://problems.plurnk.dev/engine/dispatcher/read-materialization-too-large");
        assert.equal(problem?.resources, 3);
        assert.equal(problem?.maximumResources, 2);
        assert.equal(problem?.recovery, "Narrow the target or matcher.");
        assert.equal(problem?.retryable, false);
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FIND_MAX_MATCHES; else process.env.PLURNK_SERVICE_FIND_MAX_MATCHES = prev;
        await db.close();
    }
});

test("the running sequence counter advances past the fan-out - a later op lands after all N rows", async () => {
    const { db, workspaceId, workerId, loopId, turnId, mimetypes, engine } = await setup();
    try {
        await seed(db, workspaceId, workerId, mimetypes, "/a", "france one");
        await seed(db, workspaceId, workerId, mimetypes, "/b", "france two");
        // Dispatch the glob READ at sequence 1 -> rows 1,2. A following single READ must land at 3.
        const fan = await engine.dispatch({
            statement: readStmt(urlPath("worker", "/**"), { dialect: "glob", raw: "france*" } as MatcherBody),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(fan.rowsWritten, 2);
        await engine.dispatch({
            statement: readStmt(urlPath("worker", "/a")),
            workspaceId, workerId, loopId, turnId, sequence: 1 + (fan.rowsWritten as number), origin: "model",
        });
        const row3 = await rowBody(db, workerId, mimetypes, 3);
        assert.equal(row3.status, 200);
        assert.match(row3.content ?? "", /france one/);
    } finally { await db.close(); }
});
