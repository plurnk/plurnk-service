import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Namespace from "../../src/core/namespace.ts";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import ResourceState from "./resource-state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath, appendFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import { type LineMarker, type FindStatement, type ParsedPath, type ReadStatement, Validator, type Notice } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx, readThroughScheme } from "./_scheme.ts";
import { insertLoop, insertTurn, insertSession, insertWorkspace, openMigrated, rootWorkspace, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors, parseDsl, userText } from "./_mock.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { resourcePaths } from "./_find.ts";
import { pathToFileURL } from "node:url";
import { renderTarget, FILE_MISS_RECOVERY } from "../../src/core/plurnk-uri.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { testExecutors, executionAddress, quiesceExecs } from "./_execs.ts";


describe("file-path-resolution", () => {
const execFileP = promisify(execFile);

test("{§fs-namespace} file URLs preserve native filename identity through reads and receipt reuse", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-file-url-")));
    const names = ["tilde~.txt", "space name.txt", "café.txt", "paren(v1).txt", "literal%20.txt", "literal%28.txt", "hash#name.txt", "separator%2F.txt"];
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        for (const name of names) await writeFile(join(root, name), `Content of ${name}\n`);
        await execFileP("git", ["add", "--", ...names], { cwd: root, env: hermeticGitEnv() });
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(names.map((name) => frame(`READ (${pathToFileURL(join(root, name)).href})`, null)).join("\n\n"), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const created = await rpcCall(client, 1, "workspace.create", { name: "file-urls", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, { prompt: "Read the files." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; scheme: string | null; pathname: string | null; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! }))
                    .filter(({ origin, op }) => origin === "model" && op === "READ");
                assert.deepEqual(rows.map(({ pathname, status_rx }) => ({ pathname, status_rx })), names.map((pathname) => ({ pathname, status_rx: 200 })));
                for (const row of rows) {
                    const target = renderTarget(row, root);
                    assert.ok(target);
                    const read = (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: loop.modelSessionId!, statements: [parseDsl(frame(`READ (${target})`, null))[0]] }))[0];
                    assert.equal(read.status, 200, `reuse ${target}`);
                    assert.equal(read.content, `Content of ${row.pathname}\n`, `identity of ${target}`);
                }
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} encoded file operands compose across mutations, attachments, catalogs and glob reads", async (t) => {
    serverProposals(t, "accept");
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-file-url-ops-[base]-")));
    const directory = "folder %28 #?[v]\\name";
    const names = ["literal%28.txt", "hash#name.txt", "space name.txt", "wild*.txt", "braces{v}.txt", "slash\\name.txt", ".hidden.txt"];
    const key = (name: string): string => `${directory}/${name}`;
    const uri = (name: string): string => pathToFileURL(join(root, key(name))).href.replaceAll("*", "%2A");
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await mkdir(join(root, directory));
        for (const name of names) await writeFile(join(root, key(name)), `Original ${name}\n`);
        await execFileP("git", ["add", "--", directory], { cwd: root, env: hermeticGitEnv() });
        const frame = PlurnkParser.frame;
        const glob = `${pathToFileURL(join(root, directory)).href}/*.txt`;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(names.map((name) => frame(`FIND (${uri(name)})`, null)).join("\n\n"), 50),
            makeMockResponse(names.map((name) => frame(`EDIT (${uri(name)}) <1,-1>`, `Revised ${name}\n`)).join("\n\n"), 50),
            makeMockResponse(names.map((name) => frame(`COPY (${uri(name)}) (${uri(`copy-${name}`)})`, null)).join("\n\n"), 50),
            makeMockResponse(names.map((name) => frame(`MOVE (${uri(`copy-${name}`)}) (${uri(`moved-${name}`)})`, null)).join("\n\n"), 50),
            makeMockResponse([frame(`FIND (${glob})`, null), frame(`READ (${glob})`, null)].join("\n\n"), 50),
            makeMockResponse([...names.map((name) => frame(`KILL (${uri(`moved-${name}`)})`, null)), frame("FIND (*)", null)].join("\n\n"), 50),
            makeMockResponse(frame(`FIND (${pathToFileURL(join(root, directory)).href}/**)`, null), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const created = await rpcCall(client, 1, "workspace.create", { name: "file-url-operations", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, { prompt: "Exercise the encoded addresses.", openPaths: names.map(uri) });
                assert.equal(loop.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; origin: string; scheme: string | null; pathname: string | null; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! });
                const authored = rows.filter(({ origin }) => origin === "model");
                assert.deepEqual(authored.filter(({ status_rx }) => status_rx >= 400), [], "no operation failed through address confusion");
                assert.deepEqual(rows.filter(({ origin, op }) => origin === "_plurnk" && op === "READ").map(({ pathname, status_rx }) => ({ pathname, status_rx })),
                    names.map((name) => ({ pathname: key(name), status_rx: 200 })), "client attachments use the native URI boundary");
                for (const op of ["EDIT", "COPY", "MOVE", "KILL"]) {
                    assert.equal(authored.filter((row) => row.op === op && row.status_rx === 200).length, names.length, op);
                }
                const reads = authored.filter(({ op }) => op === "READ");
                assert.equal(reads.length, names.length * 2 - 1, "the glob reads every visible original and moved file once");
                assert.ok(reads.every(({ status_rx }) => status_rx === 200));
                for (const name of names) {
                    assert.equal(await readFile(join(root, key(name)), "utf8"), `Revised ${name}\n`);
                    await assert.rejects(readFile(join(root, key(`copy-${name}`))), { code: "ENOENT" });
                    await assert.rejects(readFile(join(root, key(`moved-${name}`))), { code: "ENOENT" });
                    const address = renderTarget({ scheme: null, pathname: key(name) }, root)!;
                    const read = (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: loop.modelSessionId!, statements: [parseDsl(frame(`READ (${address})`, null))[0]] }))[0];
                    assert.equal(read.status, 200, address);
                    assert.equal(read.content, `Revised ${name}\n`);
                    assert.ok(userText(provider.received[1]).includes(address), "the exact FIND advertised a reusable address");
                    const entry = Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId: loop.modelSessionId!, target: address }));
                    assert.equal(entry.entry?.channels.body?.content, `Revised ${name}\n`, "the client entry API resolves the same resource");
                }
                const survey = JSON.parse(authored.find(({ op, pathname }) => op === "FIND" && pathname === "*")!.rx);
                const groups = survey.results as Array<Array<{ path: string; items: number }>>;
                assert.equal(groups.length, 1);
                const folder = groups[0][0];
                assert.equal(folder.path, `${pathToFileURL(join(root, directory)).href}/**`);
                assert.equal(folder.items, names.length);
                const subtree = JSON.parse(authored.find(({ op, pathname }) => op === "FIND" && pathname === `${directory}/**`)!.rx);
                assert.equal(subtree.status, 200);
                assert.equal(subtree.matchingPathCount, names.length, "the grouped selector includes hidden members and preserves literal glob characters");
                assert.ok(userText(provider.received[5]).includes(glob), "the glob receipt retains the authored URI's syntax");
                const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
                assert.deepEqual(keys.map(({ pathname }) => pathname).toSorted(), names.map(key).toSorted(), "no encoded or double-decoded shadow identities");
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} digest addresses retain literal identities and authored selectors", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "plurnk-file-url-evidence-")));
    const root = join(dir, "project");
    const dbPath = join(dir, "evidence.db");
    const names = ["literal%28.txt", "hash#name.txt", "wild*.txt"];
    const frame = PlurnkParser.frame;
    const glob = `${pathToFileURL(root).href}/*.txt`;
    try {
        await mkdir(root);
        const db = await openMigrated(dbPath);
        try {
            const ids = await seedEnvelope(db, "file-url-evidence");
            await db.test_set_workspace_project_root.run({ id: ids.workspaceId, project_root: root });
            for (const name of names) {
                await writeFile(join(root, name), `Content of ${name}\n`);
                await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: name, content: `Content of ${name}\n` });
            }
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            let sequence = 0;
            for (const header of [...names.map((name) => `READ (${renderTarget({ scheme: null, pathname: name }, root)})`), `FIND (${glob})`]) {
                const result = await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: parseDsl(frame(header, null))[0] });
                assert.equal(result.status, 200, header);
            }
        } finally { await db.close(); }
        const evidence = EvidenceReader.open(dbPath);
        try {
            const rows = evidence.rows().logEntries;
            assert.deepEqual(rows.filter(({ op }) => op === "READ").map(({ pathname, target }) => ({ pathname, target })),
                names.map((pathname) => ({ pathname, target: renderTarget({ scheme: null, pathname }, root) })));
            assert.equal(rows.find(({ op }) => op === "FIND")?.target, glob);
        } finally { evidence[Symbol.dispose](); }
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§fs-namespace} malformed URLs refuse only their operation and preserve durable failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-url-refusal-"));
    const invalid = [`file://${root}/bad%2Fname`, `file://${root}/bad%00name`, `file://${root}/bad%xy`, `file://${root}/%FF`, `file://remote${root}/file`];
    try {
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(invalid.map((target) => frame(`READ (${target})`, null)).join("\n\n"), 50),
            makeMockResponse(frame("SEND [200]", "The addresses were refused."), 50),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: "invalid-file-urls", projectRoot: root });
                const loop = await runLoopToTerminal(client, 2, { prompt: "Inspect the URLs." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! }))
                    .filter(({ op, origin }) => op === "READ" && origin === "model");
                assert.equal(rows.length, invalid.length);
                for (const row of rows) {
                    assert.equal(row.status_rx, 400);
                    assert.match(JSON.parse(row.rx).problem.type, /invalid-file-url$/u);
                }
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const form of ["absolute", "home", "literal"] as const) test(`{§fs-namespace} {§fs-namespace} ${form} paths compose across operations and client reads`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await realpath(await mkdtemp(join(form === "home" ? homedir() : tmpdir(), "plurnk-path-resolution-")));
    const directory = form === "literal" ? "~" : "";
    const key = (name: string): string => join(directory, name);
    const spelling = (name: string): string => form === "home"
        ? `~/${relative(homedir(), join(root, name))}`
        : form === "literal" ? `./~/${name}` : join(root, name);
    const relativeSource = form === "literal" ? "./~/source.txt" : "source.txt";
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(join(root, key("source.txt")), "original\n");
        await execFileP("git", ["add", key("source.txt")], { cwd: root, env: hermeticGitEnv() });
        const source = join(root, key("source.txt"));
        const copied = join(root, key("copied.txt"));
        const moved = join(root, key("moved.txt"));
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(frame("sh", `printf "%s/${key("source.txt")}\\n" "$PWD"`), 50),
            makeMockResponse(frame(`READ (${spelling("source.txt")})`, null), 50),
            makeMockResponse([
                frame(`EDIT (${spelling("source.txt")}) <1,-1>`, "revised\n"),
                frame(`COPY (${spelling("source.txt")}) (${spelling("copied.txt")})`, null),
                frame(`MOVE (${spelling("copied.txt")}) (${spelling("moved.txt")})`, null),
            ].join("\n\n"), 50),
            makeMockResponse([
                frame(`READ (${pathToFileURL(moved).href})`, null),
                frame(`FIND (${spelling("*.txt")})`, null),
                frame(`READ (${spelling("*.txt")})`, null),
            ].join("\n\n"), 50),
            makeMockResponse(frame(`KILL (${spelling("moved.txt")})`, null), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const notifications = subscribeNotifications(client, "notice/event");
                const created = await rpcCall(client, 1, "workspace.create", { name: "filesystem-paths", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, {
                    prompt: "Exercise the filesystem addresses.", openPaths: [relativeSource, source, spelling("source.txt")],
                });
                assert.equal(loop.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; origin: string; pathname: string | null; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! });
                const authored = rows.filter(({ origin }) => origin === "model");
                const attached = rows.filter(({ origin, op, pathname }) => origin === "_plurnk" && op === "READ" && pathname === key("source.txt"));
                assert.deepEqual(attached.map(({ status_rx }) => status_rx), [200, 200, 200], "all client attachment spellings resolve the same member");
                assert.ok(rows.some(({ op, rx }) => op === "READ" && rx.includes(source)), "the shell's absolute path reached its stream observation");
                assert.deepEqual(authored.filter(({ op }) => op === "COPY" || op === "MOVE").map(({ op, status_rx }) => ({ op, status_rx })), [
                    { op: "COPY", status_rx: 200 },
                    { op: "MOVE", status_rx: 200 },
                ]);
                assert.deepEqual(authored.filter(({ status_rx }) => status_rx >= 400), [], "normalization causes no failed operation or strike");
                assert.equal(await readFile(source, "utf8"), "revised\n");
                await assert.rejects(readFile(copied), { code: "ENOENT" });
                await assert.rejects(readFile(moved), { code: "ENOENT" });
                await assert.rejects(readFile(join(root, source.slice(1))), { code: "ENOENT" });

                for (const op of ["sh", "READ", "EDIT", "COPY", "MOVE", "FIND", "KILL"]) {
                    assert.ok(authored.some((row) => row.op === op && row.status_rx === 200), `${op} completed`);
                }
                assert.deepEqual(authored.filter(({ op, pathname }) => op === "READ" && pathname === key("source.txt")).map(({ status_rx }) => status_rx), [200, 200], "exact and glob reads converge on the same key");

                const notices = notifications() as { notice: Notice }[];
                const normalized = notices.map(({ notice }) => notice).filter(({ kind }) => kind === "path_normalized");
                assert.equal(normalized.length, form === "literal" ? 1 : 10, "one notice per authored absolute/home operand, never per bound key or automatic observation");
                assert.ok(normalized.every((notice) => notice.source === "scheme:file" && notice.level === "warn"));
                if (form === "literal") {
                    assert.equal(normalized[0].message, "Path resolved to './~/moved.txt'.");
                    assert.ok(userText(provider.received[2]).includes("./~/source.txt"), "literal keys are rendered as reusable addresses");
                } else {
                    assert.ok(normalized.some(({ message }) => message === "Path resolved to 'source.txt'."));
                    assert.ok(normalized.some(({ message }) => message === "Path resolved to 'copied.txt'."));
                    assert.match(userText(provider.received[2]), /YOU SHOULD address the resolved path\. Path resolved to 'source\.txt'\. \[path_normalized\]/u, "the normalization reaches the next model packet");
                }

                for (const target of [relativeSource, spelling("source.txt"), source, pathToFileURL(source).href]) {
                    const result = (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: loop.modelSessionId!, statements: [parseDsl(frame(`READ (${target})`, null))[0]] }))[0];
                    assert.equal(result.status, 200, target);
                    assert.equal(result.content, "revised\n", target);
                }
                const entry = Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId: loop.modelSessionId!, target: pathToFileURL(source).href }));
                assert.equal(entry.status, 200);
                assert.equal(entry.entry?.channels.body?.content, "revised\n");
                const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
                assert.deepEqual(keys.map(({ pathname }) => pathname), [key("source.txt")]);
                assert.ok(keys.every(({ pathname }) => Namespace.isCanonical(pathname, root)));
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} {§fs-namespace} normalization notices follow authored operands, producer and filesystem base", async () => {
    const db = await openMigrated();
    try {
        for (const projectRoot of ["/project", homedir(), "/", null]) {
            const ids = await seedEnvelope(db, `normalization-${projectRoot}`);
            if (projectRoot !== null) await db.test_set_workspace_project_root.run({ id: ids.workspaceId, project_root: projectRoot });
            await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: "probe.txt", content: "member" });
            await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: "~/literal.txt", content: "literal" });
            const notices: Notice[] = [];
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_workspaceId, { notice }) => { notices.push(notice); } });
            const absolute = join(projectRoot ?? "/", "probe.txt");
            let sequence = 0;
            for (const [target, origin] of [["probe.txt", "model"], [absolute, "_plurnk"], [absolute, "model"], ["./~/literal.txt", "model"]] as const) {
                const result = await engine.dispatch({
                    ...ids, sequence: ++sequence, origin,
                    statement: parseDsl(PlurnkParser.frame(`READ (${target})`, null))[0],
                });
                assert.equal(result.status, projectRoot === null && target === absolute ? 404 : 200, `${projectRoot}: ${origin} ${target}`);
            }
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), projectRoot !== null && projectRoot !== "/" ? [{
                source: "scheme:file", kind: "path_normalized", level: "warn", directive: "YOU SHOULD address the resolved path.", message: "Path resolved to 'probe.txt'.",
            }] : []);
            notices.length = 0;
            for (const origin of ["_plurnk", "model"] as const) {
                const result = await engine.dispatch({
                    ...ids, sequence: ++sequence, origin,
                    statement: parseDsl(PlurnkParser.frame("READ (~/probe.txt)", null))[0],
                });
                assert.equal(result.status, projectRoot === homedir() ? 200 : 404, `${projectRoot}: ${origin} ~/probe.txt`);
            }
            // {§fs-namespace} Inside the root the key; beyond it the absolute path, never a climb.
            const homeKey = projectRoot === null ? null : relative(projectRoot, join(homedir(), "probe.txt"));
            const homeAddress = homeKey !== null && homeKey.startsWith("../") ? join(homedir(), "probe.txt") : homeKey;
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), projectRoot !== null && projectRoot !== "/" ? [{
                source: "scheme:file", kind: "path_normalized", level: "warn", directive: "YOU SHOULD address the resolved path.", message: `Path resolved to '${homeAddress}'.`,
            }] : []);
            notices.length = 0;
            // An absolute spelling of a path beyond the root is already its canonical address: no notice.
            const beyond = join(projectRoot === homedir() ? "/" : homedir(), `plurnk-beyond-${crypto.randomUUID()}.md`);
            const miss = await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: parseDsl(PlurnkParser.frame(`READ (${beyond})`, null))[0] });
            assert.equal(miss.status, 404, `${projectRoot}: ${beyond}`);
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), [], `${projectRoot}: an absolute spelling beyond the root earns no notice`);
        }
    } finally { await db.close(); }
});
});

describe("namespace-canon", () => {
// {§fs-namespace} {§fs-namespace} — accepted spellings converge on one
// stored Git-relative key; rendered addresses resolve back to that identity.


















const filePath = (pathname: string): ParsedPath => ({ kind: "local", raw: pathname });
const readStmt = (pathname: string): ReadStatement => ({ metadata: null, op: "READ", aside: null, target: filePath(pathname), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } });
const readFileScheme = (statement: ReadStatement, ctx: ReturnType<typeof makeSchemeCtx>) =>
    readThroughScheme("file", null, statement, ctx);
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (pathname: string, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({ metadata: null, op: "EDIT", aside: null, target: filePath(pathname), lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 } });

const setup = async (databasePath?: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-canon-"));
    const db = await openMigrated(databasePath);
    const workspaceId = await insertWorkspace(db, `canon-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
    return { root, db, workspaceId, ctx };
};

for (const glob of ["**", "~/**"]) test(`{§fs-namespace} literal membership glob ${glob} composes with discovery, FTS and exclusion`, async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "~"));
        await writeFile(join(root, "~/a.md"), "alpha\n");
        await writeFile(join(root, "~/b.md"), "beta\n");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob, source: "members" });
        await GitMembership.indexGitMembership(ctx);
        const file = new File();
        const find = (pathname: string): FindStatement => ({ ...readStmt(pathname), op: "FIND", lineMarker: null });
        const catalog = await file.find(find("*"), ctx);
        assert.equal(catalog.status, 200);
        assert.ok(JSON.stringify(catalog.results).includes('"path":"./~/**"'), "folder selectors are reusable literal addresses");
        for (const target of ["./~", "./~/", "./~/**", "**"]) {
            const found = await file.find(find(target), ctx);
            assert.equal(found.status, 200, target);
            assert.deepEqual(resourcePaths(found).toSorted(), ["./~/a.md", "./~/b.md"]);
            for (const path of resourcePaths(found)) {
                const read = await readFileScheme(readStmt(path), ctx);
                assert.equal(read.status, 200, path);
                assert.equal(read.content, path.endsWith("a.md") ? "alpha\n" : "beta\n");
            }
        }
        const directory = await readFileScheme(readStmt("./~"), ctx);
        assert.equal(directory.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-is-directory");
        assert.equal(directory.problem?.target, "./~");
        assert.equal(directory.problem?.recovery, "`FIND (./~/)` lists its files.");
        await SearchIndex.maintain(ctx);
        const searched = await file.find({ ...find("./~/**"), matcher: { dialect: "fts", raw: "~alpha" } }, ctx);
        assert.equal(searched.status, 200);
        assert.deepEqual(resourcePaths(searched), ["./~/a.md"], "the pattern-slot tilde remains FTS");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "~/b.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        assert.deepEqual(resourcePaths(await file.find(find("**"), ctx)), ["./~/a.md"]);
        assert.equal(await readFile(join(root, "~/b.md"), "utf8"), "beta\n", "exclusion changes membership, not disk");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const key of ["~", "~/note.md"]) test(`{§fs-namespace} retained ${key} identity and pending proposal survive reopening unchanged`, async () => {
    const databasePath = join(await testArtifactDirectory("core"), `home-identity-${crypto.randomUUID()}.db`);
    const { root, db, workspaceId, ctx } = await setup(databasePath);
    try {
        await mkdir(dirname(join(root, key)), { recursive: true });
        await writeFile(join(root, key), "original\n");
        const seeded = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: key });
        assert.ok(seeded);
        await MembershipMaterialization.materializeMember(key, root, ctx, new Map());
        const file = new File();
        const proposal = await file.edit(editStmt(`./${key}`, "revised\n", fullReplace), ctx);
        assert.equal(proposal.status, 202);
        assert.equal((proposal.attrs as { path: string }).path, key, "proposal storage retains its bound literal key");
        await db.close();
        const reopened = await openMigrated(databasePath);
        try {
            const restored = { ...ctx, db: reopened };
            assert.equal((await file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, restored)).status, 200);
            const read = await readFileScheme(readStmt(`./${key}`), restored);
            assert.equal(read.status, 200);
            assert.equal(read.content, "revised\n");
            const retained = await reopened.crud_get_member_sig.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: key });
            assert.equal(retained?.id, seeded.id);
            assert.deepEqual(await reopened.test_file_pathnames.all({ workspace_id: workspaceId }), [{ pathname: key }]);
        } finally { await reopened.close(); }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace}: every spelling of one member resolves to the same row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/main.js"), "the one file\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/main.js" }, { channels: { body: { content: "the one file\n", mimetype: "text/markdown" } } }, ctx, "file");

        const rootBase = root; // e.g. /tmp/plurnk-canon-XXXX
        const spellings = ["src/main.js", join(root, "src/main.js"), "./src/main.js", "src/./main.js", "a/../src/main.js", `../${rootBase.split("/").at(-1)}/src/main.js`];
        for (const spelling of spellings) {
            const r = await readFileScheme(readStmt(spelling), ctx);
            assert.equal(r.status, 200, `READ(${spelling}) resolves the member`);
            assert.equal(r.content, "the one file\n", `READ(${spelling}) reads the SAME row`);
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "src/main.js" });
        assert.equal(rows?.n, 1, "one identity under every spelling");
        const outside = await readFileScheme(readStmt("/src/main.js"), ctx);
        assert.equal(outside.status, 404, "an absolute miss never falls back to the in-root member");
        assert.equal(outside.problem?.target, "/src/main.js", "{§fs-namespace} beyond the root the address is the absolute path, never a climb");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace}: repository paths materialize in the workspace namespace", () => {
    assert.equal(Namespace.fromRepositoryPath("project/src/main.js", "/repo/project", "/repo"), "src/main.js");
    assert.equal(Namespace.fromRepositoryPath("sibling/README.md", "/repo/project", "/repo"), "../sibling/README.md");
    assert.throws(() => Namespace.fromRepositoryPath("../escape", "/repo/project", "/repo"), /escapes its repository/);
});

test("{§fs-namespace}: EDIT through an alias answers canonically without minting a shadow row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "note.md"), "original\n");
        const seeded = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: "note.md" });
        assert.ok(seeded);
        await MembershipMaterialization.materializeMember("note.md", root, ctx, new Map());
        const before = await db.test_entries_count_all.get<{ n: number }>({});

        const r = await new File().edit(editStmt(join(root, "note.md"), "revised\n", fullReplace), ctx);
        assert.equal(r.status, 202, "the slashed spelling proposes against the member");
        const attrs = r.attrs as { path: string };
        assert.equal(attrs.path, "note.md", "the engine answers in wire canon — never an echo of the model's spelling");
        assert.match((r as { body?: string }).body ?? "", /^Index: note\.md/, "the diff header speaks canon");

        const after = await db.test_entries_count_all.get<{ n: number }>({});
        assert.equal(after?.n, before?.n, "no shadow row is minted via the alternate spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} the storage fixpoint: every file-class row is its own canon", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "a.md" }, { channels: { body: { content: "a\n", mimetype: "text/markdown" } } }, ctx, "file");
        const rows = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.ok(rows.length > 0);
        for (const { pathname } of rows) {
            assert.ok(Namespace.isCanonical(pathname, root), `stored key '${pathname}' is its own canon — the resource-state predicate`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} the log row: address columns speak canon while tx retains non-sensitive authored spelling", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "readme.md"), "hello\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "readme.md" }, { channels: { body: { content: "hello\n", mimetype: "text/markdown" } } }, ctx, "file");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const loopId = await insertLoop(db, ctx.sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spelling = `${root}/./readme.md`; // a deliberately ugly legal spelling
        const r = await engine.dispatch({
            statement: readStmt(spelling), workspaceId, sessionId: ctx.sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 200, "the ugly spelling resolves");
        const row = await db.test_last_log_row.get<{ pathname: string | null; tx: string }>({ loop_id: loopId });
        assert.equal(row?.pathname, "readme.md", "the engine-authored pathname COLUMN carries wire canon");
        assert.ok(row?.tx.includes("/./readme.md"), "the durable projection retains non-sensitive authored spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-write-surface} {§fs-write-surface} {§fs-write-surface}: canonical root and outside-member writes obey the admission matrix", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    const outside = await mkdtemp(join(homedir(), "plurnk-mount-"));
    try {
        const file = new File();

        // (1) root + empty path, no Git and no pick → the root grants exclusive
        // creation. Accepting the proposal establishes the resulting membership.
        const rootCreate = await file.edit(editStmt("fresh.md", "x\n"), ctx);
        assert.equal(rootCreate.status, 202, "the project root admits an exclusive create without another membership grantor");
        const rootApplied = await file.applyResolution({ attrs: rootCreate.attrs as never, metadata: null }, ctx);
        assert.equal(rootApplied.status, 200);
        const rootMember = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "fresh.md",
        });
        assert.equal(rootMember?.membership_origin, "constraint", "the accepted create remains an addressable picked member");
        const rootRead = await readFileScheme(readStmt("fresh.md"), ctx);
        assert.equal(rootRead.status, 200);
        assert.equal(rootRead.content, "x\n");

        // (1') a member definition remains a valid admission path.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "**", source: "members" });
        const granted = await file.edit(editStmt("picked.md", "x\n"), ctx);
        assert.equal(granted.status, 202, "the member definition admits the exclusive create");

        // (3) root + existing NON-member (hidden file) → refused; occupancy is all that leaks.
        await writeFile(join(root, "hidden.md"), "secret\n");
        const hiddenEdit = await file.edit(editStmt("hidden.md", "overwrite\n"), ctx);
        assert.equal(hiddenEdit.status, 403, "an existing non-member is never overwritten — the hidden file stays protected");

        // Outside members: pick-granted rw, Git-only ro. Register both grantor shapes.
        await writeFile(join(outside, "client.md"), "client-granted\n");
        await writeFile(join(outside, "gitted.md"), "git-included\n");
        const mountKeyClient = relative(root, join(outside, "client.md"));
        const mountKeyGit = relative(root, join(outside, "gitted.md"));
        const homePath = (name: string): string => `~/${relative(homedir(), join(outside, name))}`;
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: mountKeyClient, source: "members" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: mountKeyClient, membership_origin: "constraint" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: mountKeyGit, membership_origin: "git" });
        await MembershipMaterialization.materializeMember(mountKeyClient, root, ctx, new Map());
        await MembershipMaterialization.materializeMember(mountKeyGit, root, ctx, new Map());
        for (const pathname of [mountKeyClient, join(outside, "client.md"), homePath("client.md")]) {
            const rw = await file.edit(editStmt(pathname, "revised\n", fullReplace), ctx);
            assert.equal(rw.status, 202, "relative and absolute spellings preserve the outside member's write grant");
            assert.equal((rw.attrs as { path: string }).path, mountKeyClient);
        }
        for (const pathname of [mountKeyGit, join(outside, "gitted.md"), homePath("gitted.md")]) {
            const ro = await file.edit(editStmt(pathname, "revised\n"), ctx);
            assert.equal(ro.status, 403, "absolute spelling cannot expand a Git-only outside member's authority");
        }

        // Default scope is root, so an absent outside path is refused.
        for (const pathname of [relative(root, join(outside, "new.md")), join(outside, "new.md"), homePath("new.md")]) {
            const mint = await file.edit(editStmt(pathname, "x\n"), ctx);
            assert.equal(mint.status, 403, "root scope cannot mint an outside member");
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-namespace}: facts distinguish a wrong address, occupancy, and an empty survey", async () => {
    const { root, db, ctx } = await setup();
    try {
        await writeFile(join(root, "real.md"), "content\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "real.md" }, { channels: { body: { content: "content\n", mimetype: "text/markdown" } } }, ctx, "file");
        const file = new File();

        // ENOENT on a READ miss carries the resolved name in wire canon.
        const miss = await readFileScheme(readStmt(join(root, "no/such.md")), ctx);
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.detail, "No member of this workspace is at 'no/such.md'.", "the READ miss states its fact — resolved form, wire canon"); // {§operation-results}
        assert.equal(miss.problem?.recovery, "FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body."); // {§operation-results}

        // Exact-path FIND distinguishes absence from a successful empty survey.
        const findMissStmt = { op: "FIND", aside: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "no/such.md" }, matcher: null, body: null } as never;
        const findMiss = await file.find(findMissStmt, ctx);
        assert.equal(findMiss.status, 404, "FIND over an absent exact path cannot certify an empty set");
        assert.equal(findMiss.problem?.detail, "No member of this workspace is at 'no/such.md'."); // {§operation-results}

        // A FOLDER scope with zero matches stays the blessed orienting empty survey.
        const surveyStmt = { op: "FIND", aside: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "empty-dir/" }, matcher: null, body: null } as never;
        const survey = await file.find(surveyStmt, ctx);
        assert.equal(survey.status, 200, "an empty folder survey is orienting, not an error");

        // Occupancy (EEXIST-class): a hidden non-member at the path — the fact reveals occupancy only.
        await writeFile(join(root, "occupied.md"), "hidden\n");
        const clobber = await file.edit(editStmt("occupied.md", "x\n"), ctx);
        assert.equal(clobber.status, 403);
        assert.equal(clobber.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-occupied-by-nonmember");
        assert.equal(clobber.problem?.detail, "A non-member file already occupies 'occupied.md'."); // {§operation-results}
        assert.equal(clobber.problem?.path, "occupied.md");
        // {§fs-namespace} — a READ of that same non-member names the door, not absence.
        const peek = await readFileScheme(readStmt("occupied.md"), ctx);
        assert.equal(peek.status, 404);
        assert.equal(peek.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-member");
        assert.equal(peek.problem?.detail, "'occupied.md' exists on disk but is not a member of this workspace."); // {§operation-results}
        assert.equal(peek.problem?.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body."); // {§operation-results}
        assert.equal(clobber.problem?.recovery, "Choose an unoccupied member path."); // {§operation-results}
        assert.equal(clobber.problem?.retryable, false);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace}: directory recognition does not probe outside-root paths", async () => {
    const { root, db, ctx } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-directory-"));
    try {
        const target = `../${outside.split("/").at(-1)}`;
        const statement: FindStatement = {
            metadata: null, op: "FIND", aside: null, target: filePath(target),
            lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
        };
        const result = await new File().find(statement, ctx);
        assert.equal(result.status, 404, "an unmounted outside directory is not recognized from disk");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(result.problem?.detail, `No member of this workspace is at '${resolve(root, target)}'.`, "{§fs-namespace} named by its absolute address");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-namespace}: beyond the root a miss is the same sentence whether or not a file is there", async () => {
    const { root, db, ctx } = await setup();
    const present = `plurnk-dark-${crypto.randomUUID()}.md`;
    const absent = `plurnk-dark-${crypto.randomUUID()}.md`;
    try {
        // A real file beside the root, and a name nothing holds. Neither is a member.
        await writeFile(join(root, "..", present), "somebody else's\n");
        const there = await readFileScheme(readStmt(`../${present}`), ctx);
        const notThere = await readFileScheme(readStmt(`../${absent}`), ctx);
        for (const [result, name] of [[there, present], [notThere, absent]] as const) {
            assert.equal(result.status, 404);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
            const address = resolve(root, "..", name);   // {§fs-namespace} absolute beyond the root
            assert.equal(result.problem?.detail, `No member of this workspace is at '${address}'.`, "about the address's membership: it neither claims absence nor hints at presence");
            assert.equal(result.problem?.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`, "the recovery speaks of the address too, true under every members scope (#1005)"); // {§operation-results}
        }
        // The disk beyond the root stays dark: swap the names and the two answers are one answer,
        // apart from where each refused read was recorded.
        const normalize = (result: typeof there, name: string): string => {
            const { instance, ...problem } = result.problem!;
            assert.ok(instance, "each refused read is its own recorded act");
            return JSON.stringify({ ...result, problem }).replaceAll(name, "<name>");
        };
        assert.equal(normalize(there, present), normalize(notThere, absent));
    } finally {
        await rm(join(root, "..", present), { force: true });
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§fs-write-surface}: accept records constraint provenance before reporting success", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "**", source: "members" });
        const file = new File();
        const proposal = await file.edit(editStmt("stamped.md", "content\n"), ctx);
        assert.equal(proposal.status, 202);
        const applied = await file.applyResolution({ attrs: proposal.attrs as never, body: undefined, metadata: null }, ctx);
        assert.equal(applied.status, 200);
        const row = await db.test_get_origin.get<{ membership_origin: string | null }>({ workspace_id: workspaceId, pathname: "stamped.md" });
        assert.equal(row?.membership_origin, "constraint", "the accepted create carries its represented grantor, not NULL");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} an in-root file no grantor admits DOES NOT EXIST; a client pick brings it into existence", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        // A real file, physically in the root — non-git root, no pick: NO grantor admits it.
        await writeFile(join(root, "ungran.md"), "present on disk, absent in the workspace\n");
        const invisible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(invisible.status, 404, "no grantor → the file does not exist for the model (counterintuitive on purpose — the sandbox's center)");

        // A member definition grants it + the membership pass runs → it exists.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "ungran.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        const visible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(visible.status, 200, "the client's explicit grant is what brings it into existence — every visible byte traces to an external grantor");
        assert.match(visible.content ?? "", /present on disk/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§operation-results} {§diagnostic-observation} a file target named like an executor misses like any path, presuming no fence (#902)", async () => {
    const { root, db, ctx } = await setup();
    try {
        const executors = await testExecutors();
        assert.ok(executors.availableRuntimes(ctx.workspaceId).includes("sh"), "the real shell executor is available to the fixture");
        const withExecutors = { ...ctx, executors };
        for (const key of ["sh", "nope", "tools/sh"]) {
            const miss = await readFileScheme(readStmt(key), withExecutors);
            assert.equal(miss.status, 404, key);
            assert.equal(miss.problem?.recovery, "FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.", key);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
});

describe("refusal-recovery", () => {
// {§diagnostic-observation} — a refusal carries the next step its producer knows (#1005).
// {§fs-namespace} {§log-history-projection} {§exec-target-routing} {§operation-results} {§find-result-projection} {§exec-lifetime}
















const execFileP = promisify(execFile);
type Problem = { type?: string; detail?: string; recovery?: string; target?: string };
type Row = { status_rx: number; rx: string };

const runtime = async (t: TestContext) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "refusal-recovery-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "generated.log\n");
    await writeFile(join(root, "a.md"), "alpha\n");
    await git(["add", ".gitignore", "a.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    await writeFile(join(root, "generated.log"), "built\n");
    await writeFile(join(root, "loose.md"), "loose\n");
    const db = await openMigrated();
    const ids = await seedEnvelope(db, `refusal-recovery-${crypto.randomUUID()}`);
    await rootWorkspace(db, ids.workspaceId, root);
    const schemes = new SchemeRegistry();
    const executors = await testExecutors();
    schemes.registerRuntimeSchemes(executors);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(executors);
    t.after(async () => {
        await quiesceExecs(schemes);
        db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    let sequence = 0;
    const dispatch = async (source: string): Promise<{ status: number; problem: Problem }> => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const written = await db.log_read_by_coordinate.get<Row>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence });
        assert.ok(written, source);
        return { status: written.status_rx, problem: (JSON.parse(written.rx) as { problem?: Problem }).problem ?? {} };
    };
    return { db, engine, ids, root, dispatch, sequence: () => sequence };
};

test("{§fs-namespace} every file miss names its member key and carries the miss recovery", async (t) => {
    const { dispatch } = await runtime(t);
    for (const source of ["````FIND (missing.py)````", "````KILL (missing.py)````", "````EDIT (missing.py) /alpha/\nomega\n````", "````READ (missing.py)````"]) {
        const { status, problem } = await dispatch(source);
        assert.equal(status, 404, source);
        assert.equal(problem.detail, "No member of this workspace is at 'missing.py'.", `${source}: the key, never a file:// URI`);
        assert.equal(problem.recovery, FILE_MISS_RECOVERY, source);
    }
});

test("{§fs-namespace} {§fs-namespace} a key beyond the root is told it is outside the root, by its absolute address, never offered FIND, EDIT or admission", async (t) => {
    const { dispatch, root } = await runtime(t);
    const address = resolve(root, "../outside/delete_tests.log");
    for (const source of ["````READ (../outside/delete_tests.log)````", "````FIND (../outside/delete_tests.log)````", "````KILL (../outside/delete_tests.log)````", `\`\`\`\`READ (${address})\`\`\`\``]) {
        const { status, problem } = await dispatch(source);
        assert.equal(status, 404, source);
        assert.equal(problem.detail, `No member of this workspace is at '${address}'.`, `${source}: the address's membership, nothing about the disk`);
        assert.equal(problem.target, address, `${source}: beyond the root the address is absolute, never a climb`);
        assert.equal(problem.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`, source);
    }
});

test("{§fs-namespace} {§fs-namespace} home, literal and absolute misses retain the resolved identity and membership boundary", async (t) => {
    const { dispatch, root } = await runtime(t);
    const homeKey = relative(root, homedir());
    for (const [spelling, key] of [["~/plurnk-missing.md", `${homeKey}/plurnk-missing.md`], ["~", homeKey], ["~/", homeKey]]) {
        const miss = await dispatch(PlurnkParser.frame(`READ (${spelling})`, null));
        // {§fs-namespace} The home directory lies beyond this root, so its address is absolute.
        const address = key.startsWith("../") ? resolve(root, key) : key;
        assert.equal(miss.status, 404, spelling);
        assert.equal(miss.problem.detail, `No member of this workspace is at '${address}'.`);
        assert.equal(miss.problem.target, address);
        assert.equal(miss.problem.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`);
    }
    for (const [spelling, key] of [["./~/missing.md", "~/missing.md"], ["./~", "~"], ["~someone/notes.md", "~someone/notes.md"]]) {
        const miss = await dispatch(PlurnkParser.frame(`READ (${spelling})`, null));
        assert.equal(miss.status, 404, spelling);
        assert.equal(miss.problem.detail, `No member of this workspace is at '${key}'.`);
        assert.equal(miss.problem.target, spelling, "the literal member address can be reused");
        assert.equal(miss.problem.recovery, FILE_MISS_RECOVERY);
    }
    // An absolute path beyond the root is spelled back as itself and carries the outside-root recovery.
    const outsideName = `plurnk-outside-${crypto.randomUUID()}.md`;
    const outsideAddress = resolve(root, "..", outsideName);
    const outside = await dispatch(`\`\`\`\`READ (${join(root, "..", outsideName)})\`\`\`\``);
    assert.equal(outside.status, 404);
    assert.equal(outside.problem.detail, `No member of this workspace is at '${outsideAddress}'.`, "the absolute address, never a climb");
    assert.equal(outside.problem.recovery, `'${outsideAddress}' is outside the project root: only a members definition under the operator's namespace scope admits it.`);
    // An absolute path inside the root is its in-root key and keeps the in-root recovery.
    const inside = await dispatch(`\`\`\`\`READ (${join(root, "missing.py")})\`\`\`\``);
    assert.equal(inside.status, 404);
    assert.equal(inside.problem.detail, "No member of this workspace is at 'missing.py'.");
    assert.equal(inside.problem.recovery, FILE_MISS_RECOVERY, "inside the root the listing, creation and admission doors stand");
});

test("{§fs-namespace} a non-member an exclusion covers or the repository ignores is not offered an admission no model definition can make", async (t) => {
    const { db, ids, root, dispatch } = await runtime(t);
    const ignored = await dispatch("````READ (generated.log)````");
    assert.equal(ignored.problem.detail, "'generated.log' exists on disk but is not a member of this workspace.");
    assert.equal(ignored.problem.recovery, "Git ignores it (`.gitignore` line 1): a client or operator members definition can include it, a model definition cannot.");
    const untracked = await dispatch("````READ (loose.md)````");
    assert.equal(untracked.problem.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.", "an untracked file is still admitted");
    await writeFile(join(root, "secret.md"), "hidden\n");
    await db.crud_insert_family_workspace_constraint.run({ workspace_id: ids.workspaceId, effect: "exclude", glob: "secret.md", source: "members" });
    const excluded = await dispatch("````READ (secret.md)````");
    assert.equal(excluded.problem.detail, "'secret.md' exists on disk but is not a member of this workspace.", "an excluded file on disk says so");
    assert.doesNotMatch(excluded.problem.recovery ?? "", /plurnk \(members\)/u, "an exclusion no add lifts is not offered one");
    assert.match(excluded.problem.recovery ?? "", /!secret\.md/u, "the refusal names the exclusion");
});

// {§membership} Each place an ignore rule lives, named by its file and line: the repository's `.gitignore`,
// its `.git/info/exclude`, git's default excludes file under the daemon user's configuration home, and a `core.excludesFile`
// that user configures ({§membership}); a negated pattern re-includes and is no ignore.
test("{§membership} an ignored file's refusal names the rule's file and line, wherever the rule lives", async (t) => {
    const { root, dispatch } = await runtime(t);
    const prior = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    const homes = await mkdtemp(join(tmpdir(), "ignore-homes-"));
    t.after(async () => {
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(homes, { recursive: true, force: true });
    });
    const asHome = async (name: string, files: Record<string, string>): Promise<void> => {
        const home = join(homes, name);
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(home, path, ".."), { recursive: true });
            await writeFile(join(home, path), content);
        }
        process.env.HOME = home;
        process.env.XDG_CONFIG_HOME = join(home, ".config");
    };
    await appendFile(join(root, ".gitignore"), "*.tmp\n!keep.tmp\n");
    const exclude = join(root, ".git", "info", "exclude");
    const excludeLine = (await readFile(exclude, "utf8").catch(() => "")).split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0).length + 1;
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await appendFile(exclude, "info.md\n");
    for (const name of ["default.md", "configured.md", "info.md", "drop.tmp", "keep.tmp"]) await writeFile(join(root, name), "x\n");
    const named = async (path: string): Promise<string | undefined> => (await dispatch(`\`\`\`\`READ (${path})\`\`\`\``)).problem.recovery;

    await asHome("default", { ".config/git/ignore": "default.md\n" });
    for (const [path, file, line] of [["default.md", "~/.config/git/ignore", 1], ["info.md", ".git/info/exclude", excludeLine], ["drop.tmp", ".gitignore", 2]] as const) {
        assert.match(await named(path) ?? "", new RegExp(`^Git ignores it \\(\`${file.replaceAll(".", "\\.")}\` line ${line}\\)`, "u"), `${path} names ${file} line ${line}`);
    }
    assert.match(await named("keep.tmp") ?? "", /plurnk \(members\)/u, "a re-included path is untracked, not ignored");

    await asHome("configured", { ".gitconfig": "[core]\n\texcludesFile = ~/my-ignore\n", "my-ignore": "configured.md\n" });
    assert.match(await named("configured.md") ?? "", /^Git ignores it \(`~\/my-ignore` line 1\)/u, "the user's configured excludes file is honored and named");
});

test("{§log-history-projection} a log miss beside real rows names them", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````READ (a.md)````");
    await dispatch("````FIND (a.md) /alpha/````");
    const wrongLeaf = await dispatch("````READ (log:///1/1/1/sh)````");
    assert.equal(wrongLeaf.status, 404);
    assert.equal(wrongLeaf.problem.recovery, "The entry at log:///1/1/1 is `log:///1/1/1/READ`.");
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ)````")).problem.recovery, "Turn 1/1's READ rows are `log:///1/1/1/READ`, `log:///1/1/3/READ`; the entry at log:///1/1/2 is `log:///1/1/2/FIND`.", "the leaf asked for first, then what the guessed sequence holds");
    assert.equal((await dispatch("````KILL (log:///1/1/1/sh)````")).problem.recovery, "The entry at log:///1/1/1 is `log:///1/1/1/READ`.", "the curation a 413 demands is told the same");
    // The rtx5070 benchlet's shape (run393): a turn's row asked for at the sequence another row holds.
    assert.equal((await dispatch("````KILL (log:///1/1/1/FIND)````")).problem.recovery, "Turn 1/1's FIND rows are `log:///1/1/2/FIND`, `log:///1/1/4/FIND`; the entry at log:///1/1/1 is `log:///1/1/1/READ`.");
    assert.equal((await dispatch("````READ (log:///1/1/9/FIND)````")).problem.recovery, "Turn 1/1's FIND rows are `log:///1/1/2/FIND`, `log:///1/1/4/FIND`.", "a sequence off names the turn's rows that carry the leaf");
    assert.equal((await dispatch("````READ (log:///1/4/1/READ)````")).problem.recovery, "Turn 1/4 has no entries; loop 1's latest turn is 1/1.");
    assert.equal((await dispatch("````READ (log:///7/1/1/READ)````")).problem.recovery, undefined, "a loop with no rows has nothing to name");
});

test("{§operation-results} {§diagnostic-observation} an unregistered scheme names what is registered, whatever its authority", async (t) => {
    const { dispatch } = await runtime(t);
    const executorAuthority = await dispatch("````WORK (tool://sh/run)\nls\n````");
    assert.equal(executorAuthority.status, 501);
    assert.equal(executorAuthority.problem.detail, "Scheme 'tool' is not registered.");
    const listed = await dispatch("````READ (nosuch://x/y)````");
    for (const refused of [executorAuthority, listed]) assert.match(refused.problem.recovery ?? "", /^Registered schemes: .*\bfile\b.*\blog\b.*\.$/u);
});

test("{§find-result-projection} {§diagnostic-observation} a full-text query FTS5 refuses carries FTS5's message and the dialect's form", async (t) => {
    const { engine, ids, dispatch } = await runtime(t);
    assert.equal((await dispatch("````EDIT (workspace:///notes.md)\nif all(flags):\n````")).status, 201);
    await engine.warmWorkspaceDerivations(ids.workspaceId);
    const refused = await dispatch("````FIND (workspace:///notes.md) ~all(````");
    assert.equal(refused.status, 400);
    assert.equal(refused.problem.recovery, "An FTS5 query is barewords, \"quoted phrases\", and AND, OR, NOT and NEAR between them.");
});

test("{§exec-lifetime} {§diagnostic-observation} an execution that outlives its lifetime says so, and nothing more", async (t) => {
    const { db, ids, dispatch, sequence } = await runtime(t);
    assert.equal((await dispatch("````sh [{\"lifetime\": \"1s\"}]\nsleep 5\n````")).status, 200);
    const stream = await executionAddress(db, ids.turnId, sequence());
    let ended: { status: number; problem: Problem } | undefined;
    for (let attempt = 0; attempt < 60 && ended === undefined; attempt++) {
        await new Promise((settle) => setTimeout(settle, 250));
        const read = await dispatch(`\`\`\`\`READ (${stream})\`\`\`\``);
        if (read.status === 504) ended = read;
    }
    assert.ok(ended, "the deadline closes the stream with 504");
    assert.equal(ended.problem.detail, "Execution of 'sh' outlived its 1s lifetime.");
    assert.equal(ended.problem.recovery, undefined);
});

test("{§exec-target-routing} an execution id written under another runtime names the address it holds", async (t) => {
    const { db, ids, dispatch, sequence } = await runtime(t);
    assert.equal((await dispatch("````python3\nprint(1)\n````")).status, 200);
    const stream = await executionAddress(db, ids.turnId, sequence());
    const id = stream.replace(/^python3:\/\/\//u, "");
    const killed = await dispatch(`\`\`\`\`KILL (sh:///${id})\`\`\`\``);
    assert.equal(killed.status, 404);
    assert.equal(killed.problem.detail, `No stream exists at sh:///${id}.`);
    assert.equal(killed.problem.recovery, `The execution at /${id} is \`${stream}\`.`);
});
});

describe("resource-state", () => {
// {§test-artifact-retention} Positive and negative integrity witnesses; the soak covers repeated turns.









test("{§test-artifact-retention} consistent resource state reports no violations after real lifecycle traffic", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ws-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-clean-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "a.md" }, { channels: { body: { content: "a\n", mimetype: "text/markdown" } } }, ctx, "file");
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "b.md", membership_origin: "git" });

        const violations = await ResourceState.check(db);
        assert.deepEqual(violations, [], "consistent resources produce no violations");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} the detector CATCHES: a non-canon stored key and an alien grantor both self-name", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ws-bad-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-bad-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);

        // A non-canon key stored raw.
        await db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: "/noncanon.md" });
        // An alien grantor cannot be written: the schema CHECK refuses it.
        await assert.rejects(
            () => db.test_set_origin.run({ workspace_id: workspaceId, pathname: "/noncanon.md", membership_origin: "plurnk-decided" }),
            /CHECK constraint failed/,
            "the closed admission set is enforced at the schema wall",
        );

        const violations = await ResourceState.check(db);
        const laws = violations.map((v) => v.invariant).toSorted();
        assert.ok(laws.includes("{§fs-namespace}"), `the non-canon key is caught: ${JSON.stringify(violations)}`);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
});

