// {§zero-width-column-one-insert} — the recorded rtx intent (#853): `EDIT (tests/test_ext_autodoc.py) <0,795>` /
// `<0,@xb6i9>` meant "insert a test before line 795" and replaced the file head; the working form
// `<795,1,795,1>` (or its anchored `<@h,1,@h,1>`) must insert whole lines from a fenced body that ends
// without a newline, while a region off column 1 stays byte-exact and an empty body inserts nothing.
import assert from "node:assert/strict";
import test, { beforeEach, type TestContext } from "node:test";
import { serverProposals } from "./_approval.ts";
beforeEach((t) => serverProposals(t as TestContext, "accept"));
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, rootWorkspace } from "./_db.ts";

const execFileP = promisify(execFile);
const FILE = "tests/test_ext_autodoc.py";
const LINES = Array.from({ length: 800 }, (_, i) => `line ${i + 1}`);
const BODY = "@pytest.mark.sphinx('html', testroot='ext-autodoc')\ndef test_autodoc_inherited_members_multiple_classes(app):\n    pass";

type Row = { status: number; landed: string | null; inserted: number | null; removed: number | null };

const program = async (frames: (anchor: (line: number) => string) => string[]): Promise<{ rows: Row[]; content: string }> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-whole-line-"));
    const db = await openMigrated();
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await mkdir(dirname(join(root, FILE)), { recursive: true });
        await writeFile(join(root, FILE), `${LINES.join("\n")}\n`);
        await execFileP("git", ["add", "."], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `whole-line-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Add the test.");
        const respond = async (content: string, args: Parameters<Mock["generate"]>[0]) =>
            await new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
        let calls = 0;
        const provider = new Mock({ contextWindow: 100_000, responses: [] });
        provider.generate = async (args) => {
            calls += 1;
            if (calls === 1) return await respond(PlurnkParser.frame(`READ (${FILE}) <790,800>`, null), args);
            if (calls === 2) {
                const row = (await db.engine_render_log.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ worker_id: workerId }))
                    .filter(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200).at(-1);
                assert.ok(row, "the model READ the file");
                const anchors = (JSON.parse(row.rx) as { lineAnchors?: string[] }).lineAnchors;
                assert.ok(Array.isArray(anchors) && anchors.length === 11, "the READ published one anchor per line 790..800");
                return await respond(frames((line) => anchors[line - 790]!).join("\n\n"), args);
            }
            return await respond(PlurnkParser.frame("KILL", "Done."), args);
        };
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 6, maxStrikes: 3, messages: [{ role: "user", content: "Add the test." }] });
        assert.equal(result.result.status, 200, JSON.stringify(result.result).slice(0, 300));
        const logRows = (await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: id })))).flat();
        const rows = logRows.filter(({ op, origin }) => op === "EDIT" && origin === "model").map(({ status_rx, rx }) => {
            const parsed = JSON.parse(rx) as { receipt?: { effect?: { result?: string; inserted?: number; removed?: number } } };
            return { status: status_rx, landed: parsed.receipt?.effect?.result ?? null, inserted: parsed.receipt?.effect?.inserted ?? null, removed: parsed.receipt?.effect?.removed ?? null };
        });
        return { rows, content: await readFile(join(root, FILE), "utf8") };
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

const edit = (scope: string, body: string): string => PlurnkParser.frame(`EDIT (${FILE}) <${scope}>`, body);

test("{§zero-width-column-one-insert} <795,1,795,1> with a body lacking a trailing newline inserts whole lines before line 795 and removes nothing", async () => {
    const { rows, content } = await program(() => [edit("795,1,795,1", BODY)]);
    assert.deepEqual(rows.map(({ status, removed }) => [status, removed]), [[200, 0]]);
    const lines = content.split("\n");
    assert.equal(lines.length, 804, "800 lines, three inserted, and the trailing split");
    assert.deepEqual(lines.slice(793, 798), ["line 794", ...BODY.split("\n"), "line 795"]);
    assert.equal(rows[0]!.landed, "<795,1,798,1>", "the receipt lands the three whole lines");
});

test("{§zero-width-column-one-insert} the anchored <@h,1,@h,1> form inserts the same whole lines", async () => {
    const { rows, content } = await program((anchor) => [edit(`${anchor(795)},1,${anchor(795)},1`, BODY)]);
    assert.deepEqual(rows.map(({ status }) => status), [200]);
    assert.deepEqual(content.split("\n").slice(793, 798), ["line 794", ...BODY.split("\n"), "line 795"]);
});

test("{§zero-width-column-one-insert} a zero-width region off column 1 stays byte-exact, and an empty body inserts nothing", async () => {
    const { rows, content } = await program(() => [edit("795,5,795,5", "X"), edit("797,1,797,1", "")]);
    assert.deepEqual(rows.map(({ status }) => status), [200, 304], "an empty body at a zero-width region is a no-op, not a line");
    const lines = content.split("\n");
    assert.equal(lines.length, 801, "no line was added");
    assert.equal(lines[794], "lineX 795", "byte-exact insert inside the line");
    assert.equal(lines[796], "line 797", "the empty body left line 797 alone");
});
