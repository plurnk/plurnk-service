import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("{§fs-namei} {§file-path-normalization} shell, native operations and client reads share filesystem addresses", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-path-resolution-")));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "source.txt"), "original\n");
        await execFileP("git", ["add", "source.txt"], { cwd: root, env: hermeticGitEnv() });
        const source = join(root, "source.txt");
        const copied = join(root, "copied.txt");
        const moved = join(root, "moved.txt");
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(frame("sh", 'printf "%s/source.txt\\n" "$PWD"'), 50),
            makeMockResponse(frame(`READ (${source})`, null), 50),
            makeMockResponse([
                frame(`EDIT (${source}) <1,-1>`, "revised\n"),
                frame(`COPY (${source}) (${copied})`, null),
                frame(`MOVE (${copied}) (${moved})`, null),
            ].join("\n\n"), 50),
            makeMockResponse([
                frame(`READ (${pathToFileURL(moved).href})`, null),
                frame(`FIND (${root}/*.txt)`, null),
            ].join("\n\n"), 50),
            makeMockResponse(frame(`KILL (${moved})`, null), 50),
            makeMockResponse(frame("KILL", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const notifications = subscribeNotifications(client, "notice/event");
                const created = await rpcCall(client, 1, "workspace.create", { name: "filesystem-paths", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, {
                    prompt: "Exercise the filesystem addresses.", openPaths: ["source.txt", source], policy: { proposals: "accept" },
                });
                assert.equal(loop.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; origin: string; pathname: string | null; status_rx: number; rx: string }>({ worker_id: loop.modelWorkerId! });
                const authored = rows.filter(({ origin }) => origin === "model");
                const attached = rows.filter(({ origin, op, pathname }) => origin === "_plurnk" && op === "READ" && pathname === "source.txt");
                assert.deepEqual(attached.map(({ status_rx }) => status_rx), [200, 200], "relative and absolute client attachments resolve the same member");
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
                assert.deepEqual(authored.filter(({ op, pathname }) => op === "READ" && pathname === "source.txt").map(({ status_rx }) => status_rx), [200]);

                const notices = notifications() as { notice: Notice }[];
                const normalized = notices.map(({ notice }) => notice).filter(({ kind }) => kind === "path_normalized");
                assert.equal(normalized.length, 9, "one notice per authored absolute operand, not per internal read or automatic observation");
                assert.ok(normalized.every(({ source, level }) => source === "scheme:file" && level === "warn"));
                assert.ok(normalized.some(({ message }) => message === "Path resolved to 'source.txt'."));
                assert.ok(normalized.some(({ message }) => message === "Path resolved to 'copied.txt'."));
                assert.match(userText(provider.received[2]!), /path_normalized: Path resolved to 'source\.txt'\./u, "the normalization reaches the next model packet");

                for (const target of ["source.txt", source, pathToFileURL(source).href]) {
                    const result = await daemon.look({ workspaceId, workerId: loop.modelWorkerId!, statement: parseDsl(frame(`READ (${target})`, null))[0] });
                    assert.equal(result.status, 200, target);
                    assert.equal(result.content, "revised\n", target);
                }
                const entry = Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, workerId: loop.modelWorkerId!, target: pathToFileURL(source).href }));
                assert.equal(entry.status, 200);
                assert.equal(entry.entry?.channels.body?.content, "revised\n");
                const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
                assert.deepEqual(keys.map(({ pathname }) => pathname), ["source.txt"]);
                assert.ok(keys.every(({ pathname }) => Namespace.isCanonical(pathname, root)));
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§file-path-normalization} only model-authored absolute spellings in a non-root workspace warn", async () => {
    const db = await openMigrated();
    try {
        for (const projectRoot of ["/project", "/", null]) {
            const ids = await seedEnvelope(db, `normalization-${projectRoot}`);
            if (projectRoot !== null) await db.test_set_workspace_project_root.run({ id: ids.workspaceId, project_root: projectRoot });
            await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: "probe.txt", content: "member" });
            const notices: Notice[] = [];
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_workspaceId, { notice }) => { notices.push(notice); } });
            const absolute = join(projectRoot ?? "/", "probe.txt");
            let sequence = 0;
            for (const [target, origin] of [["probe.txt", "model"], [absolute, "_plurnk"], [absolute, "model"]] as const) {
                const result = await engine.dispatch({
                    ...ids, sequence: ++sequence, origin,
                    statement: parseDsl(PlurnkParser.frame(`READ (${target})`, null))[0]!,
                });
                assert.equal(result.status, projectRoot === null && target === absolute ? 404 : 200, `${projectRoot}: ${origin} ${target}`);
            }
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), projectRoot === "/project" ? [{
                source: "scheme:file", kind: "path_normalized", level: "warn", message: "Path resolved to 'probe.txt'.",
            }] : []);
        }
    } finally { await db.close(); }
});
