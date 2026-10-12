import { serverProposals } from "./_approval.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Validator, type Notice } from "@plurnk/plurnk-contracts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import Namespace from "../../src/core/namespace.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { makeMockResponse, parseDsl, userText } from "./_mock.ts";
import { connect, rpcCall, runLoopToTerminal, subscribeNotifications, withDaemon } from "./_rpc.ts";
import { openMigrated, seedEntryWithChannel, seedEnvelope } from "./_db.ts";

const execFileP = promisify(execFile);

for (const form of ["absolute", "home", "literal"] as const) test(`{§fs-home} {§file-path-normalization} ${form} paths compose across operations and client reads`, async (approvalContext) => {
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
                frame(`READ (file://${moved})`, null),
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
                const rows = await db.engine_render_log.all<{ op: string; origin: string; pathname: string | null; status_rx: number; rx: string }>({ worker_id: loop.modelWorkerId! });
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
                assert.ok(normalized.every(({ source, level }) => source === "scheme:file" && level === "warn"));
                if (form === "literal") {
                    assert.equal(normalized[0]!.message, "Path resolved to './~/moved.txt'.");
                    assert.ok(userText(provider.received[2]!).includes("./~/source.txt"), "literal keys are rendered as reusable addresses");
                } else {
                    assert.ok(normalized.some(({ message }) => message === "Path resolved to 'source.txt'."));
                    assert.ok(normalized.some(({ message }) => message === "Path resolved to 'copied.txt'."));
                    assert.match(userText(provider.received[2]!), /YOU SHOULD address the resolved path\. Path resolved to 'source\.txt'\. \[path_normalized\]/u, "the normalization reaches the next model packet");
                }

                for (const target of [relativeSource, spelling("source.txt"), source, `file://${source}`]) {
                    const result = await daemon.look({ workspaceId, workerId: loop.modelWorkerId!, statement: parseDsl(frame(`READ (${target})`, null))[0] });
                    assert.equal(result.status, 200, target);
                    assert.equal(result.content, "revised\n", target);
                }
                const entry = Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, workerId: loop.modelWorkerId!, target: `file://${source}` }));
                assert.equal(entry.status, 200);
                assert.equal(entry.entry?.channels.body?.content, "revised\n");
                const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
                assert.deepEqual(keys.map(({ pathname }) => pathname), [key("source.txt")]);
                assert.ok(keys.every(({ pathname }) => Namespace.isCanonical(pathname, root)));
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-home} {§file-path-normalization} normalization notices follow authored operands, producer and filesystem base", async () => {
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
                    statement: parseDsl(PlurnkParser.frame(`READ (${target})`, null))[0]!,
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
                    statement: parseDsl(PlurnkParser.frame("READ (~/probe.txt)", null))[0]!,
                });
                assert.equal(result.status, projectRoot === homedir() ? 200 : 404, `${projectRoot}: ${origin} ~/probe.txt`);
            }
            const homeKey = projectRoot === null ? null : relative(projectRoot, join(homedir(), "probe.txt"));
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), projectRoot !== null && projectRoot !== "/" ? [{
                source: "scheme:file", kind: "path_normalized", level: "warn", directive: "YOU SHOULD address the resolved path.", message: `Path resolved to '${homeKey}'.`,
            }] : []);
        }
    } finally { await db.close(); }
});
