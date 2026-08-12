import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    PlurnkParser,
    type PlurnkOp,
    type PlurnkStatement,
    type ReadStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import type {
    RepresentationPreparationRequest,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Digest from "../../src/digest/Digest.ts";
import Daemon from "../../src/server/Daemon.ts";
import Envelope from "../../src/server/envelope.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertTurn,
    insertWorkspace,
    openMigrated,
} from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const REDACTED = "__redacted__";
const STRUCTURAL_SECRETS = [
    "primary-user",
    "primary-password",
    "primary-header-secret",
    "secondary-header-secret",
    "copy-user",
    "copy-password",
    "copy-header-secret",
    "move-user",
    "move-password",
    "move-header-secret",
] as const;

class CredentialProbe implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "credential-probe",
        channels: { body: "text/plain" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };

    observed: UrlPath | null = null;

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx) {
        if (request.target.kind !== "url") throw new Error("credential probe requires a URL target");
        this.observed = structuredClone(request.target);
        const written = await ctx.entries.write(request.pathname, {
            channels: {
                body: { content: "credential probe response", mimetype: "text/plain" },
            },
            tags: [],
        });
        assert.ok(written.status === 200 || written.status === 201);
        return { status: 200 };
    }
}

const parseClientStatement = (source: string, op: PlurnkOp): PlurnkStatement => {
    const parsed = PlurnkParser.parseClient(source);
    assert.equal(parsed.unparsedTail, undefined);
    const errors = parsed.items.filter((item) => item.kind === "error");
    assert.deepEqual(errors, []);
    const statements = parsed.items.filter((item) => item.kind === "statement");
    assert.equal(statements.length, 1);
    const [item] = statements;
    if (item?.kind !== "statement") throw new Error(`No statement parsed from ${source}`);
    assert.equal(item.statement.op, op);
    return item.statement as PlurnkStatement;
};

const assertNoStructuralSecrets = (value: unknown, surface: string): void => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of STRUCTURAL_SECRETS) {
        assert.equal(
            serialized.includes(secret),
            false,
            `${surface} exposed structural credential ${secret}`,
        );
    }
};

const urlTarget = (statement: PlurnkStatement): UrlPath => {
    if (statement.target?.kind !== "url") throw new Error(`${statement.op} did not retain a URL target`);
    return statement.target;
};

// {§log-sensitive-request-evidence}
test("ordinary operation evidence redacts credential slots once before every durable projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-log-redaction-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    let dbOpen = true;
    let daemon: Daemon | null = null;
    let daemonRunning = false;
    try {
        const workspaceId = await insertWorkspace(db, `log-redaction-${crypto.randomUUID()}`);
        const worker = await Envelope.createModelWorker(db, workspaceId, "redaction-parent");
        const loopId = await insertLoop(db, worker.id, 1, "inspect durable evidence");
        const turnId = await insertTurn(db, loopId, 1, 200);
        const probe = new CredentialProbe();
        const schemes = new SchemeRegistry();
        schemes.register("credential-probe", probe);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });

        const read = parseClientStatement(
            "<|READ(credential-probe://primary-user:primary-password@example.test/value?ticket=query-visible#body{Authorization: Bearer primary-header-secret}{X-Api-Key: secondary-header-secret})|>",
            "READ",
        );
        const copy = parseClientStatement(
            "<|COPY(worker:///missing-copy)>credential-probe://copy-user:copy-password@copy.test/destination?ticket=copy-query-visible{Authorization: copy-header-secret}<COPY|>",
            "COPY",
        );
        const move = parseClientStatement(
            "<|MOVE(worker:///missing-move)>credential-probe://move-user:move-password@move.test/destination?ticket=move-query-visible{X-Token: move-header-secret}<MOVE|>",
            "MOVE",
        );

        const statements = [read, copy, move] as const;
        const results = [];
        for (const [index, statement] of statements.entries()) {
            results.push(await engine.dispatch({
                statement,
                workspaceId,
                workerId: worker.id,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "model",
            }));
        }
        assert.equal(results[0]?.status, 200, "the successful operation reached its handler");
        assert.ok((results[1]?.status ?? 0) >= 400, "the COPY failure is durable error evidence");
        assert.ok((results[2]?.status ?? 0) >= 400, "the MOVE failure is durable error evidence");

        const observed = probe.observed;
        assert.ok(observed !== null);
        const observedTarget = observed;
        assert.equal(observedTarget.username, "primary-user");
        assert.equal(observedTarget.password, "primary-password");
        assert.deepEqual(observedTarget.headers, [
            ["Authorization", "Bearer primary-header-secret"],
            ["X-Api-Key", "secondary-header-secret"],
        ]);
        assert.equal(observedTarget.query, "ticket=query-visible");
        assert.equal(urlTarget(read).username, "primary-user", "the durable projection never mutates execution input");

        const provider = new Mock({
            contextWindow: 100_000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }],
        });
        const nextTurn = await engine.runTurn({
            provider,
            workspaceId,
            workerId: worker.id,
            loopId,
            turnNumber: 2,
            messages: [],
        });
        const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: nextTurn.turnId });
        if (packetRow === undefined) throw new Error("next-turn packet was not persisted");
        assertNoStructuralSecrets(packetRow.packet, "assembled packet");
        assert.match(packetRow.packet, /ticket=query-visible/, "query identity remains visible by contract");

        daemon = new Daemon({ db, provider: null });
        await daemon.start();
        daemonRunning = true;
        const parentLog = await daemon.readLog({ workspaceId, workerId: worker.id, limit: 1000 });
        const readRow = parentLog.find((row) => row.op === "READ");
        if (readRow === undefined) throw new Error("READ operation row was not hydrated");
        assert.equal(readRow.username, REDACTED);
        assert.equal(readRow.password, REDACTED);
        assertNoStructuralSecrets(parentLog, "client log hydration");

        const readTx = readRow.tx as ReadStatement;
        const durableReadTarget = urlTarget(readTx);
        assert.equal(durableReadTarget.raw, "credential-probe://__redacted__:__redacted__@example.test/value?ticket=query-visible#body{Authorization: __redacted__}{X-Api-Key: __redacted__}");
        assert.equal(durableReadTarget.username, REDACTED);
        assert.equal(durableReadTarget.password, REDACTED);
        assert.deepEqual(durableReadTarget.headers, [
            ["Authorization", REDACTED],
            ["X-Api-Key", REDACTED],
        ]);
        assert.equal(durableReadTarget.query, "ticket=query-visible");

        for (const op of ["COPY", "MOVE"] as const) {
            const row = parentLog.find((entry) => entry.op === op);
            if (row === undefined) throw new Error(`${op} operation row was not hydrated`);
            const tx = row.tx as PlurnkStatement;
            if ((tx.op !== "COPY" && tx.op !== "MOVE") || tx.body === null) {
                throw new Error(`${op} durable statement lost its destination`);
            }
            const destination = tx.body.target;
            if (destination.kind !== "url") throw new Error(`${op} destination is not a URL`);
            assert.equal(destination.username, REDACTED);
            assert.equal(destination.password, REDACTED);
            assert.ok(destination.headers?.every(([, value]) => value === REDACTED));
            assert.match(destination.query ?? "", /-query-visible$/);
            assertNoStructuralSecrets(row, `${op} error row`);
        }

        const branch = await daemon.forkWorker({
            workspaceId,
            workerId: worker.id,
            name: "redaction-branch",
        });
        const branchLog = await daemon.readLog({ workspaceId, workerId: branch.workerId, limit: 1000 });
        assertNoStructuralSecrets(branchLog, "forked log hydration");
        const branchRead = branchLog.find((row) => row.op === "READ");
        assert.equal(branchRead?.username, REDACTED);
        assert.equal(branchRead?.password, REDACTED);

        await daemon.stop();
        daemonRunning = false;
        await db.close();
        dbOpen = false;

        Digest.run({ dbPath, digestDir });
        const digestJson = await readFile(join(digestDir, "digest.json"), "utf8");
        const digestMarkdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assertNoStructuralSecrets(digestJson, "digest JSON");
        assertNoStructuralSecrets(digestMarkdown, "digest Markdown");
        assert.match(digestJson, /ticket=query-visible/, "digest retains non-secret query identity");
    } finally {
        if (daemonRunning && daemon !== null) await daemon.stop();
        if (dbOpen) await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
