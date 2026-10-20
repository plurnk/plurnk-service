import { ownWorker, serverProposals } from "./_approval.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { PathSyntax, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { CoreSchemeAdapterBase, type CoreSchemeCallContext } from "../../src/core/CoreSchemeServices.ts";
import EntryOps from "../../src/schemes/_entry-ops.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import type { LineAnchorPrecondition } from "../../src/content/line-anchors.ts";
import type { ResolvedEditStatement, SchemeManifest } from "@plurnk/plurnk-schemes";
import { openMigrated, seedEnvelope, seedEntryWithChannel } from "./_db.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { copyStmt, dispositionStmt, editStmt, fullReplace, killStmt, localPath, moveStmt, noteStmt, readStmt, regex, urlPath } from "./_dsl.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { makeMockResponse } from "./_mock.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("{§bulk-resource-targeting} escaped and URL selectors read and edit the intended file, never its separator neighbor", async (t) => {
    serverProposals(t, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-glob-"));
    const intended = String.raw`dir\name/a.txt`;
    const names = [intended, "dir/name/a.txt", "dirname/a.txt", "a*.txt", "a/b.txt"];
    const frame = PlurnkParser.frame;
    const bare = PathSyntax.escapeTarget(String.raw`dir\\name/*.txt`);
    const url = `${pathToFileURL(join(root, String.raw`dir\name`)).href}/*.txt`;
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        for (const name of names) {
            await mkdir(dirname(join(root, name)), { recursive: true });
            await writeFile(join(root, name), `Original ${name}\n`);
        }
        await execFileP("git", ["add", "--all"], { cwd: root, env: hermeticGitEnv() });
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse([
                ...[bare, url].flatMap((path) => [frame(`FIND (${path})`, null), frame(`READ (${path})`, null)]),
                frame(`READ (${PathSyntax.escapeTarget(String.raw`a\*.txt`)})`, null),
            ].join("\n\n"), 50),
            makeMockResponse(frame(`EDIT (${url}) <1,-1>`, "Revised\n"), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: "literal-globs", projectRoot: root });
                const loop = await runLoopToTerminal(client, 2, { prompt: "Select the literal names." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; pathname: string; status_rx: number; rx: string }>({ worker_id: loop.modelWorkerId! }))
                    .filter(({ origin }) => origin === "model");
                assert.deepEqual(rows.filter(({ op }) => op === "READ").map(({ pathname, status_rx }) => ({ pathname, status_rx })),
                    [intended, intended, "a*.txt"].map((pathname) => ({ pathname, status_rx: 200 })));
                const finds = rows.filter(({ op }) => op === "FIND");
                assert.equal(finds.length, 2);
                for (const find of finds) {
                    const result = JSON.parse(find.rx);
                    assert.equal(result.status, 200);
                    assert.equal(result.matchingPathCount, 1);
                    assert.equal(result.results[0][0].path, pathToFileURL(join(root, intended)).href);
                }
                for (const name of names) {
                    assert.equal(await readFile(join(root, name), "utf8"), name === intended ? "Revised\n" : `Original ${name}\n`, name);
                }
                assert.deepEqual(await readdir(join(root, String.raw`dir\name`)), ["a.txt"], "no wildcard-named file is created");
                assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ pathname, status_rx }) => ({ pathname, status_rx })), [{ pathname: intended, status_rx: 200 }]);
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

class Channels extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "channels", channels: { body: "text/plain", notes: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: ["model", "client"], volatile: false, modelVisible: true, textEditScopes: true,
    };
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext, precondition?: LineAnchorPrecondition) {
        return EntryOps.editWorkspaceEntryBatch(statements, this.coreContext(ctx), Channels.manifest, precondition);
    }
}

const fixture = async (t: TestContext, entries: Record<string, string>, scheme = "worker", producer: "client" | "model" = "client") => {
    const db = await openMigrated();
    t.after(() => db.close());
    const env = await seedEnvelope(db, `bulk-${crypto.randomUUID()}`, { producer });
    const schemes = new SchemeRegistry();
    schemes.register("channels", new Channels());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const ids = new Map<string, number>();
    for (const [pathname, content] of Object.entries(entries)) {
        ids.set(pathname, await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme, pathname, content }));
    }
    let sequence = 1;
    const dispatch = async (statement: PlurnkStatement) => {
        const result = await engine.dispatch({ ...env, statement, sequence, origin: "client" });
        sequence += (result.rowsWritten as number | undefined) ?? 1;
        return result;
    };
    const content = async (pathname: string, channel = "body") => (await db.test_get_channel.get<{ content: string }>({ entry_id: ids.get(pathname)!, name: channel }))?.content;
    const rows = () => db.test_log_entries_by_turn.all<{ op: string; pathname: string; status_rx: number; rx: string; attrs: string; sequence: number }>({ turn_id: env.turnId });
    return { db, env, engine, ids, dispatch, content, rows };
};

for (const op of ["EDIT", "KILL"] as const) {
    test(`{§bulk-resource-targeting} ${op} applies a scoped matcher to every selected resource`, async (t) => {
        const { dispatch, content, rows } = await fixture(t, { "/a.txt": "foo one\nfoo two", "/b.txt": "foo three\nfoo four", "/other.md": "foo five" });
        const target = urlPath("worker", "/@(a|b).txt");
        const statement = op === "EDIT" ? editStmt(target, "bar", { marks: [1, 1] }, regex("foo")) : killStmt(target, { marks: [1, 1] }, regex("foo"));
        const result = await dispatch(statement);
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.rowsWritten, 2);
        assert.equal(Object.hasOwn(result, "commandsExecuted"), false, "dispatch accounting is not an operation result");
        assert.equal(Object.hasOwn(result, "commandsOmitted"), false);
        assert.equal(await content("/a.txt"), `${op === "EDIT" ? "bar" : ""} one\nfoo two`);
        assert.equal(await content("/b.txt"), `${op === "EDIT" ? "bar" : ""} three\nfoo four`);
        assert.equal(await content("/other.md"), "foo five");
        assert.deepEqual((await rows()).map((row) => [row.op, row.pathname, row.status_rx]), [[op, "/a.txt", 200], [op, "/b.txt", 200]]);
        for (const { rx } of await rows()) {
            assert.equal(Object.hasOwn(JSON.parse(rx), "commandsExecuted"), false, "receipts retain only operation results");
            assert.equal(Object.hasOwn(JSON.parse(rx), "commandsOmitted"), false);
        }
    });

    test(`{§bulk-resource-targeting} empty ${op} selection is a single no-effect receipt`, async (t) => {
        const { dispatch, rows, content } = await fixture(t, { "/a.txt": "unchanged" });
        const target = urlPath("worker", "/missing*.txt");
        const result = await dispatch(op === "EDIT" ? editStmt(target, "new", fullReplace) : killStmt(target));
        assert.equal(result.status, 204, JSON.stringify(result));
        assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/missing*.txt", 204]]);
        assert.equal(await content("/a.txt"), "unchanged");
        assert.equal((await dispatch(readStmt(urlPath("worker", "/missing*.txt")))).status, 204, "no literal wildcard resource was created");
    });
}

for (const op of ["READ", "EDIT", "KILL"] as const) {
    test(`{§bulk-resource-targeting} ${op} preserves the selected nondefault channel`, async (t) => {
        const { db, dispatch, content, ids, rows } = await fixture(t, { "/a.txt": "body a", "/b.txt": "body b" }, "channels");
        for (const entryId of ids.values()) await db.test_seed_channel.run({ entry_id: entryId, name: "notes", content: "selected", mimetype: "text/plain", state: "static" });
        const target = urlPath("channels", "/*.txt", "notes");
        const result = await dispatch(op === "READ" ? readStmt(target) : op === "EDIT" ? editStmt(target, "replacement", fullReplace) : killStmt(target, fullReplace));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.rowsWritten, 2);
        for (const path of ids.keys()) {
            assert.equal(await content(path), `body ${path[1]}`);
            assert.equal(await content(path, "notes"), op === "EDIT" ? "replacement" : op === "KILL" ? "" : "selected");
        }
        if (op === "READ") assert.deepEqual((await rows()).map(({ rx }) => JSON.parse(rx).content), ["selected", "selected"]);
    });
}

for (const op of ["COPY", "MOVE"] as const) {
    for (const operand of ["source", "destination"] as const) {
        for (const count of [0, 1, 2]) {
            test(`{§bulk-resource-targeting} ${op} ${operand} glob with ${count} matches`, async (t) => {
                const entries = { "/source.txt": "source\ntail", "/destination.txt": "destination", ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`/match${i}.txt`, operand === "source" ? "source\ntail" : "destination"])) };
                const { dispatch, content, rows } = await fixture(t, entries);
                const source = urlPath("worker", operand === "source" ? "/match*.txt" : "/source.txt");
                const destination = urlPath("worker", operand === "destination" ? "/match*.txt" : "/destination.txt");
                const result = await dispatch((op === "COPY" ? copyStmt : moveStmt)(source, destination, { marks: [1, 1] }, fullReplace));
                assert.equal(result.status, count === 1 ? 200 : 400, JSON.stringify(result));
                if (count !== 1) {
                    assert.ok(result.problem?.type.endsWith("/target-cardinality"), JSON.stringify(result));
                    assert.equal(result.problem?.detail, `${op} ${operand} matched ${count} resources; expected one.`);
                    for (const [path, original] of Object.entries(entries)) assert.equal(await content(path), original, `${path} must not change`);
                } else {
                    assert.equal(await content(operand === "destination" ? "/match0.txt" : "/destination.txt"), "source\n", "line selection preserves its separator");
                    assert.equal(await content(operand === "source" ? "/match0.txt" : "/source.txt"), op === "MOVE" ? "tail" : "source\ntail");
                }
                assert.deepEqual((await rows()).map(({ op: actual }) => actual), [op], "internal surveys do not create extra receipts");
            });
        }
    }
}

const previewLines = (t: TestContext, lines: number) => {
    const old = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    process.env.PLURNK_SERVICE_PREVIEW_LINES = String(lines);
    t.after(() => { if (old === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES; else process.env.PLURNK_SERVICE_PREVIEW_LINES = old; });
};

for (const op of ["EDIT", "KILL"] as const) {
    test(`{§bulk-resource-targeting} ${op} is complete even when the FIND preview holds one item`, async (t) => {
        previewLines(t, 1);
        const entries = { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c", "/nested/d.txt": "d" };
        const { dispatch, content, rows } = await fixture(t, entries);
        const target = urlPath("worker", "/**/*.txt");
        const result = await dispatch(op === "EDIT" ? editStmt(target, "changed", fullReplace) : killStmt(target));
        assert.ok(result.status < 300, JSON.stringify(result));
        assert.equal(result.rowsWritten, 4);
        for (const path of Object.keys(entries)) assert.equal(await content(path), op === "EDIT" ? "changed" : undefined, path);
        assert.deepEqual((await rows()).map(({ pathname }) => pathname), Object.keys(entries));
    });
}

for (const failOnOperationError of [false, true]) {
    test(`{§bulk-resource-targeting} anchors remain resource-specific during fan-out; fail-on-error=${failOnOperationError}`, async (t) => {
        const { dispatch, content, rows, engine, env } = await fixture(t, { "/a.txt": "first\nsecond", "/b.txt": "different", "/c.txt": "first\nsecond" });
        const read = await dispatch(readStmt(urlPath("worker", "/a.txt"), fullReplace));
        const anchor = (read.lineAnchors as string[])[0];
        const execution = engine.executeAdmittedTurn({
            ...env, origin: "client", source: null, emission: null, fromSequence: 2, failOnOperationError,
            statements: TurnOps.parseInternal(PlurnkParser.frame(`EDIT (worker:///*.txt) <${anchor}>`, "updated")),
        });
        if (failOnOperationError) await assert.rejects(execution, OperationFailureError);
        else await execution;
        assert.equal(await content("/a.txt"), "updated\nsecond");
        assert.equal(await content("/b.txt"), "different");
        assert.equal(await content("/c.txt"), "first\nsecond", "identical content in another resource does not share the READ anchor");
        const edits = (await rows()).filter(({ op }) => op === "EDIT");
        assert.deepEqual(edits.map(({ status_rx }) => status_rx), failOnOperationError ? [200, 409] : [200, 409, 409]);
        assert.match(JSON.parse(edits[1].rx).problem.type, /\/edit-collision$/);
    });
}

for (const op of ["READ", "EDIT", "KILL"] as const) for (const limit of [0, 1, 2, Infinity]) {
    test(`{§bulk-resource-targeting} ${op} fan-out obeys concrete command limit ${limit}`, async (t) => {
        const entries = { "/a.txt": "a", "/b.txt": "b", "/c.txt": "c" };
        const { engine, env, rows, content } = await fixture(t, entries);
        const target = urlPath("worker", "/*.txt");
        const statement = op === "READ" ? readStmt(target) : op === "EDIT" ? editStmt(target, "changed", fullReplace) : killStmt(target);
        await engine.executeAdmittedTurn({ ...env, origin: "client", source: null, emission: null, fromSequence: 1, maxCommands: limit,
            statements: [statement, noteStmt("after targets"), dispositionStmt("WAIT")] });
        const receipts = await rows();
        assert.deepEqual(receipts.filter(({ op: actual }) => actual === op).map(({ pathname }) => pathname), Object.keys(entries).slice(0, limit));
        for (const [index, [path, original]] of Object.entries(entries).entries()) {
            assert.equal(await content(path), index >= limit || op === "READ" ? original : op === "EDIT" ? "changed" : undefined);
        }
        assert.equal(receipts.some((receipt) => receipt.op === "NOTE"), limit === Infinity);
        assert.ok(receipts.some((receipt) => receipt.op === "WAIT"), "WAIT remains exempt");
        const problem = receipts.map(({ rx }) => JSON.parse(rx).problem).find((candidate) => candidate?.type.endsWith("/max-commands-exceeded"));
        if (limit === Infinity) assert.equal(problem, undefined);
        else assert.equal(problem?.omittedOperations, limit === 0 ? 2 : 4 - limit);
    });
}

for (const decision of ["reject", "drift"] as const) {
    test(`{§bulk-resource-targeting} file fan-out settles each proposal independently after ${decision}`, { timeout: 30_000 }, async (t) => {
        serverProposals(t, "review");
        const root = await mkdtemp(join(tmpdir(), "plurnk-bulk-proposals-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const { db, env, engine, rows } = await fixture(t, { "a.txt": "a\n", "b.txt": "b\n" }, "file", "model");
        await db.test_set_workspace_project_root.run({ id: env.workspaceId, project_root: root });
        await ownWorker(db, env.workspaceId, env.workerId);
        for (const name of ["a", "b"]) {
            const path = `${name}.txt`;
            await writeFile(join(root, path), `${name}\n`);
            await MembershipMaterialization.materializeMember(path, root, makeSchemeCtx({ ...env, db, mimetypes: DEFAULT_MIMETYPES }), new Map());
        }
        const publications = [Promise.withResolvers<number>(), Promise.withResolvers<number>()];
        let index = 0;
        const execution = engine.dispatch({ ...env, origin: "model", sequence: 1,
            statement: editStmt(localPath("*.txt"), "updated\n", fullReplace),
            onDispatch: (id) => publications[index++].resolve(id),
        });
        for (const [position, published] of publications.entries()) {
            const id = await published.promise;
            const pending = await engine.pendingProposals(env.workspaceId);
            assert.deepEqual(pending.map(({ logEntryId }) => logEntryId), [id], `only the current concrete target is proposed: ${JSON.stringify(await rows())}`);
            if (position === 0 && decision === "drift") await writeFile(join(root, "a.txt"), "external\n");
            await engine.resolveProposal(id, { decision: position === 0 && decision === "reject" ? "reject" : "accept" });
        }
        const result = await execution;
        assert.equal(result.status, decision === "reject" ? 400 : 409);
        assert.equal(result.rowsWritten, 2);
        assert.equal(await readFile(join(root, "a.txt"), "utf8"), decision === "reject" ? "a\n" : "external\n");
        assert.equal(await readFile(join(root, "b.txt"), "utf8"), "updated\n");
        const receipts = await rows();
        assert.deepEqual(receipts.map(({ pathname, status_rx }) => [pathname, status_rx]), [["a.txt", decision === "reject" ? 400 : 409], ["b.txt", 200]]);
        assert.deepEqual(receipts.map(({ attrs }) => JSON.parse(attrs).fanout.index), [0, 1]);
    });
}

test("{§bulk-resource-targeting} authority selectors mutate entries, never worker actors", async (t) => {
    const { db, env, dispatch } = await fixture(t, {});
    const ids = [];
    for (const authority of ["alpha", "beta"]) ids.push(await seedEntryWithChannel(db, { workspaceId: env.workspaceId, authority, pathname: "/shared.txt", content: authority }));
    const result = await dispatch(editStmt(parsePath("worker://*/shared.txt"), "updated", fullReplace));
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.rowsWritten, 2);
    for (const id of ids) assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: id, name: "body" }))?.content, "updated");
    const refused = await dispatch(killStmt(parsePath("worker://*")));
    assert.equal(refused.status, 404, JSON.stringify(refused));
    assert.match(refused.problem!.type, /\/worker-not-found$/);
    for (const id of ids) assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: id, name: "body" }))?.content, "updated");
});

test("{§bulk-resource-targeting} mutation patterns retain a receipt for every selected resource", async (t) => {
    const { dispatch, rows, content } = await fixture(t, { "/a.txt": "absent", "/b.txt": "needle", "/c.txt": "absent" });
    const result = await dispatch(editStmt(urlPath("worker", "/*.txt"), "found", null, regex("needle")));
    assert.ok(result.status < 300, JSON.stringify(result));
    assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/a.txt", 204], ["/b.txt", 200], ["/c.txt", 204]]);
    assert.equal(await content("/a.txt"), "absent");
    assert.equal(await content("/b.txt"), "found");
    assert.equal(await content("/c.txt"), "absent");
});

test("{§bulk-resource-targeting} denied mutations neither enumerate nor change their targets", async (t) => {
    const { db, env, dispatch, rows, content } = await fixture(t, { "/a.txt": "original", "/b.txt": "original" });
    await db.test_set_workspace_settings.run({ id: env.workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "EDIT" }] } }) });
    const result = await dispatch(editStmt(urlPath("worker", "/*.txt"), "updated", fullReplace));
    assert.equal(result.status, 403, JSON.stringify(result));
    assert.match(result.problem!.type, /\/capability-denied$/);
    assert.deepEqual((await rows()).map(({ pathname, status_rx }) => [pathname, status_rx]), [["/*.txt", 403]]);
    assert.equal(await content("/a.txt"), "original");
    assert.equal(await content("/b.txt"), "original");
});

for (const op of ["COPY", "MOVE"] as const) {
    test(`{§bulk-resource-targeting} ${op} resolves both channel operands and preserves exact creation`, async (t) => {
        const { db, dispatch, content, ids } = await fixture(t, { "/source.txt": "body", "/destination.txt": "body" }, "channels");
        for (const [path, id] of ids) await db.test_seed_channel.run({ entry_id: id, name: "notes", content: path === "/source.txt" ? "selected" : "destination", mimetype: "text/plain", state: "static" });
        const transfer = op === "COPY" ? copyStmt : moveStmt;
        const result = await dispatch(transfer(urlPath("channels", "/source*.txt", "notes"), urlPath("channels", "/destination*.txt", "notes"), fullReplace, fullReplace));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await content("/source.txt"), "body");
        assert.equal(await content("/destination.txt"), "body");
        assert.equal(await content("/source.txt", "notes"), op === "COPY" ? "selected" : undefined, "whole-channel MOVE removes only the selected source channel");
        assert.equal(await content("/destination.txt", "notes"), "selected");
        const created = await dispatch(transfer(urlPath("channels", "/destination*.txt", "notes"), urlPath("worker", "/new.txt")));
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.equal((await dispatch(readStmt(urlPath("worker", "/new.txt")))).content, "selected");
    });
    test(`{§bulk-resource-targeting} ${op} rejects ambiguity beyond the preview page`, async (t) => {
        previewLines(t, 1);
        const entries = { "/source.txt": "original", "/destination1.txt": "one", "/destination2.txt": "two" };
        const { dispatch, content } = await fixture(t, entries);
        const result = await dispatch((op === "COPY" ? copyStmt : moveStmt)(urlPath("worker", "/source*.txt"), urlPath("worker", "/destination*.txt")));
        assert.equal(result.status, 400, JSON.stringify(result));
        assert.match(result.problem!.type, /\/target-cardinality$/);
        assert.equal(result.problem!.matchingPathCount, 2);
        for (const [path, original] of Object.entries(entries)) assert.equal(await content(path), original);
    });
}

test("{§bulk-resource-targeting} scheme extensions cannot override the command accounting", async (t) => {
    const edit = Channels.prototype.editBatch;
    t.mock.method(Channels.prototype, "editBatch", async function (this: Channels, ...args: Parameters<Channels["editBatch"]>) {
        return { ...await edit.apply(this, args), commandsExecuted: 0, commandsOmitted: 42 };
    });
    const { engine, env, rows, content } = await fixture(t, { "/a.txt": "original" }, "channels");
    await engine.executeAdmittedTurn({ ...env, origin: "client", source: null, emission: null, fromSequence: 1, maxCommands: 1,
        statements: [editStmt(urlPath("channels", "/a.txt"), "updated", fullReplace), noteStmt("exceeds the ceiling")] });
    assert.equal(await content("/a.txt"), "updated");
    const receipts = await rows();
    assert.equal(receipts.some((receipt) => receipt.op === "NOTE"), false);
    const problem = receipts.map(({ rx }) => JSON.parse(rx).problem).find((candidate) => candidate?.type.endsWith("/max-commands-exceeded"));
    assert.equal(problem?.omittedOperations, 1);
});
