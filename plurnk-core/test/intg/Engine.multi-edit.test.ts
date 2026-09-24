// {§edit-execution} {§edit-anchor-continuity} {§edit-batch-receipt} {§line-anchors} {§anchor-offset} — the
// multi-EDIT matrix through the model path on project files. Every coherent program lands exactly where its
// anchors were published, whatever its order and whatever its own earlier splices did to ordinals and
// neighbourhoods; the only refusals are attempts no runtime could resolve deterministically (a line this
// program already replaced or deleted, a never-issued or foreign anchor), each refused without touching
// its siblings. Across programs the receipts' anchors are current and the packet's old ones are stale.
import assert from "node:assert/strict";
import test from "node:test";
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
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, rootWorkspace } from "./_helpers.ts";

const execFileP = promisify(execFile);

const DEBUG = "django/views/debug.py";
const HELPERS = "django/views/helpers.py";
const DEBUG_LINES = [
    "import functools", "import re", "import sys", "import types", "from pathlib import Path", "",
    "from django.conf import settings",
    "from django.http import HttpResponse, HttpResponseNotFound",
    "from django.template import Context, Engine, TemplateDoesNotExist",
    "from django.template.defaultfilters import pprint",
    "from django.urls import Resolver404, resolve",
    "from django.utils import timezone",
    "from django.utils.datastructures import MultiValueDict",
    "from django.utils.encoding import force_str",
    "from django.utils.module_loading import import_string",
    "from django.utils.version import get_docs_version",
    "", "",
    "def technical_404_response(request, exception):",
    "    caller = ''",
    "    try:",
    "        resolver_match = resolve(request.path)",
    "    except Resolver404:",
    "        pass",
    "    else:",
    "        obj = resolver_match.func",
    "",
    "        if hasattr(obj, '__name__'):",
    "            caller = obj.__name__",
];
const HELPERS_LINES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const HTTP_IMPORT = "from django.http import Http404, HttpResponse, HttpResponseNotFound";
const URLS_IMPORT = "from django.urls import resolve";
const EXCEPT_404 = "    except Http404:";

type Unresolved = { anchor: string; kind: "missing" | "ambiguous"; lines?: number[] };
type EditRow = { status: number; landed: string | null; unresolved: Unresolved[] | null; context: string[] | null };
type Ctx = { root: string; db: Awaited<ReturnType<typeof openMigrated>>; engine: Engine; workspaceId: number; workerId: number };
type Anchors = (line: number) => string;

const withProject = async <T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-multi-edit-"));
    const db = await openMigrated();
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        for (const [file, lines] of [[DEBUG, DEBUG_LINES], [HELPERS, HELPERS_LINES]] as const) {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await writeFile(join(root, file), `${lines.join("\n")}\n`);
        }
        await execFileP("git", ["add", "."], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `multi-edit-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        return await fn({ root, db, engine, workspaceId, workerId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

const edit = (file: string, scope: string, body: string | null): string => PlurnkParser.frame(`EDIT (file:///${file}) <${scope}>`, body ?? "");

// The anchors the model's latest READ of each file published, indexed by one-based line: the packet is the
// only place a model learns an anchor, so the program takes them from there and nowhere else.
const anchorsFromLog = async ({ db, workerId }: Ctx): Promise<[Anchors, Anchors]> => {
    const rows = await db.engine_render_log.all<{ op: string | null; origin: string; status_rx: number; pathname: string | null; rx: string }>({ worker_id: workerId });
    const latest = (file: string): Anchors => {
        const row = rows.filter(({ op, origin, status_rx, pathname }) => op === "READ" && origin === "model" && status_rx === 200 && (pathname === file || pathname === `/${file}`)).at(-1);
        assert.ok(row, `the model READ ${file}`);
        const anchors = (JSON.parse(row.rx) as { lineAnchors?: string[] }).lineAnchors;
        assert.ok(Array.isArray(anchors) && anchors.length > 0, `the READ of ${file} published one anchor per line`);
        return (line: number) => {
            const anchor = anchors[line - 1];
            if (anchor === undefined) throw new Error(`no anchor for line ${line} of ${file}`);
            return anchor;
        };
    };
    return [latest(DEBUG), latest(HELPERS)];
};

// One loop of the same worker under an accepting proposal policy: the model READs both files, then
// emits `frames` built from the anchors that READ published, then concludes.
const program = async (ctx: Ctx, sequence: number, frames: (a: Anchors, b: Anchors) => string[]): Promise<{ edits: EditRow[]; published: [Anchors, Anchors] }> => {
    const { db, engine, workspaceId, workerId } = ctx;
    const loopId = await insertLoop(db, workerId, sequence, "Apply the fix.", { proposals: "accept", attended: false });
    const reads = [DEBUG, HELPERS].map((file) => PlurnkParser.frame(`READ (file:///${file}) <1,-1>`, null)).join("\n\n");
    const respond = async (content: string, args: Parameters<Mock["generate"]>[0]) =>
        await new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
    let calls = 0;
    let published: [Anchors, Anchors] | null = null;
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    provider.generate = async (args) => {
        calls += 1;
        if (calls === 1) return await respond(reads, args);
        if (calls === 2) {
            published = await anchorsFromLog(ctx);
            return await respond(frames(...published).join("\n\n"), args);
        }
        return await respond(PlurnkParser.frame("KILL", "Done."), args);
    };
    const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 6, maxStrikes: 3, messages: [{ role: "user", content: "Apply the fix." }] });
    assert.equal(result.result.status, 200, JSON.stringify(result.result).slice(0, 300));
    assert.ok(published, "the program ran");
    const rows = (await Promise.all(result.turnIds.map((id) => db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ turn_id: id })))).flat();
    const edits = rows.filter(({ op, origin }) => op === "EDIT" && origin === "model").map(({ status_rx, rx }) => {
        const parsed = JSON.parse(rx) as { receipt?: { effect?: { result?: string; context?: string } }; problem?: { unresolvedAnchors?: Unresolved[] } };
        return {
            status: status_rx,
            landed: parsed.receipt?.effect?.result ?? null,
            unresolved: parsed.problem?.unresolvedAnchors ?? null,
            context: parsed.receipt?.effect?.context?.split("\n") ?? null,
        };
    });
    return { edits, published };
};

const fileLines = async ({ root }: Ctx, file: string): Promise<string[]> => (await readFile(join(root, file), "utf8")).replace(/\n$/u, "").split("\n");
const expectLines = (lines: readonly string[], mutate: (draft: string[]) => void): string[] => { const draft = [...lines]; mutate(draft); return draft; };
const set = (draft: string[], line: number, ...body: string[]): void => { draft.splice(line - 1, 1, ...body); };
const setRange = (draft: string[], from: number, to: number, ...body: string[]): void => { draft.splice(from - 1, to - from + 1, ...body); };

type Case = {
    name: string;
    frames: (a: Anchors, b: Anchors) => string[];
    outcomes: Array<[status: number, landed: string | null | undefined]>;
    debug?: (draft: string[]) => void;
    helpers?: (draft: string[]) => void;
    unresolved?: (a: Anchors, b: Anchors) => Array<Unresolved[] | null>;
};

// Every program below is one model turn on the seeded file. `landed` is the receipt's effect; `undefined`
// leaves it unchecked (a deletion's receipt names no result region).
const COHERENT: Case[] = [
    {
        name: "far apart: the rollout's fix with the anchors of the lines it meant",
        frames: (a) => [edit(DEBUG, a(8), HTTP_IMPORT), edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<8>"], [200, "<11>"], [200, "<23>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); set(d, 11, URLS_IMPORT); set(d, 23, EXCEPT_404); },
    },
    {
        name: "adjacent lines, ascending: the second anchor survives the first edit to its neighbour",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(12), "from django.utils import timezone  # kept")],
        outcomes: [[200, "<11>"], [200, "<12>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); },
    },
    {
        name: "adjacent lines, descending",
        frames: (a) => [edit(DEBUG, a(12), "from django.utils import timezone  # kept"), edit(DEBUG, a(11), URLS_IMPORT)],
        outcomes: [[200, "<12>"], [200, "<11>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); },
    },
    {
        name: "own insertion above, then a hash below: the anchor follows its line down",
        frames: (a) => [edit(DEBUG, a(7), "from django.conf import settings\nfrom django.core.exceptions import ImproperlyConfigured"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7,8>"], [200, "<24>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); set(d, 7, "from django.conf import settings", "from django.core.exceptions import ImproperlyConfigured"); },
    },
    {
        name: "own shrink above (two lines into one), then a hash below: the anchor follows its line up",
        frames: (a) => [edit(DEBUG, `${a(7)},${a(8)}`, "from django.conf import settings  # merged"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7>"], [200, "<22>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); setRange(d, 7, 8, "from django.conf import settings  # merged"); },
    },
    {
        name: "own deletion above, then a hash below",
        frames: (a) => [edit(DEBUG, a(6), null), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, undefined], [200, "<22>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); setRange(d, 6, 6); },
    },
    {
        name: "an enclosing range after an inner edit: both endpoints survive, the range rewrites the current lines",
        frames: (a) => [edit(DEBUG, a(22), "        resolver_match = resolve(request.path_info)"), edit(DEBUG, `${a(21)},${a(23)}`, "    try:\n        match = resolve(request.path)\n    except Http404:")],
        outcomes: [[200, "<22>"], [200, "<21,23>"]],
        debug: (d) => { setRange(d, 21, 23, "    try:", "        match = resolve(request.path)", "    except Http404:"); },
    },
    {
        name: "numeric insertion above, then a hash below: continuity is about splices, not about how they were addressed",
        frames: (a) => [edit(DEBUG, "7", "from django.conf import settings\nimport logging"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<7,8>"], [200, "<24>"]],
        debug: (d) => { set(d, 23, EXCEPT_404); set(d, 7, "from django.conf import settings", "import logging"); },
    },
    {
        name: "hash insertion above, then a numeric scope below: numbers address current coordinates ({§edit-execution})",
        frames: (a) => [edit(DEBUG, a(7), "from django.conf import settings\nimport logging"), edit(DEBUG, "23", "        resolver_match = resolve(request.path_info)")],
        outcomes: [[200, "<7,8>"], [200, "<23>"]],
        debug: (d) => { set(d, 22, "        resolver_match = resolve(request.path_info)"); set(d, 7, "from django.conf import settings", "import logging"); },
    },
    {
        name: "an offset anchor whose base line's neighbour was edited earlier: the base carries, the offset applies ({§anchor-offset})",
        frames: (a) => [edit(DEBUG, a(21), "    try:  # guarded"), edit(DEBUG, `${a(22)}+1`, EXCEPT_404)],
        outcomes: [[200, "<21>"], [200, "<23>"]],
        debug: (d) => { set(d, 21, "    try:  # guarded"); set(d, 23, EXCEPT_404); },
    },
    {
        name: "two files in one program, each by its own anchors",
        frames: (a, b) => [edit(DEBUG, a(11), URLS_IMPORT), edit(HELPERS, b(3), "GAMMA")],
        outcomes: [[200, "<11>"], [200, "<3>"]],
        debug: (d) => { set(d, 11, URLS_IMPORT); },
        helpers: (d) => { set(d, 3, "GAMMA"); },
    },
    {
        name: "a failing middle EDIT leaves both neighbours applied and names only its own anchor",
        frames: (a) => [edit(DEBUG, a(8), HTTP_IMPORT), edit(DEBUG, "@451ok", "nope"), edit(DEBUG, a(23), EXCEPT_404)],
        outcomes: [[200, "<8>"], [409, null], [200, "<23>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); set(d, 23, EXCEPT_404); },
        unresolved: () => [null, [{ anchor: "@451ok", kind: "missing" }], null],
    },
    {
        name: "the same line twice: the second edit addresses it by current coordinate",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, "11", `${URLS_IMPORT}  # confirmed`)],
        outcomes: [[200, "<11>"], [200, "<11>"]],
        debug: (d) => { set(d, 11, `${URLS_IMPORT}  # confirmed`); },
    },
    {
        name: "a twin neighbourhood created by this program does not detach the original line's anchor",
        frames: (a) => [
            edit(DEBUG, "29", [DEBUG_LINES[28], ...DEBUG_LINES.slice(19, 24)].join("\n")),
            edit(DEBUG, a(22), "        resolver_match = resolve(request.path_info)"),
        ],
        outcomes: [[200, "<29,34>"], [200, "<22>"]],
        debug: (d) => { set(d, 22, "        resolver_match = resolve(request.path_info)"); set(d, 29, DEBUG_LINES[28]!, ...DEBUG_LINES.slice(19, 24)); },
    },
];

const REFUSED: Case[] = [
    {
        name: "the old anchor of a line this program already replaced",
        frames: (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(11), "from django.urls import resolve, reverse")],
        outcomes: [[200, "<11>"], [409, null]],
        debug: (d) => { set(d, 11, URLS_IMPORT); },
        unresolved: (a) => [null, [{ anchor: a(11), kind: "missing" }]],
    },
    {
        name: "the old anchor of a line this program already deleted",
        frames: (a) => [edit(DEBUG, a(12), null), edit(DEBUG, a(12), "from django.utils import timezone")],
        outcomes: [[200, undefined], [409, null]],
        debug: (d) => { setRange(d, 12, 12); },
        unresolved: (a) => [null, [{ anchor: a(12), kind: "missing" }]],
    },
    {
        name: "a range whose one endpoint this program already replaced names that endpoint alone",
        frames: (a) => [edit(DEBUG, a(23), EXCEPT_404), edit(DEBUG, `${a(21)},${a(23)}`, "    try:\n        match = resolve(request.path)\n    except Http404:")],
        outcomes: [[200, "<23>"], [409, null]],
        debug: (d) => { set(d, 23, EXCEPT_404); },
        unresolved: (a) => [null, [{ anchor: a(23), kind: "missing" }]],
    },
    {
        name: "another file's anchor is foreign here; the sibling after it still applies",
        frames: (a, b) => [edit(DEBUG, b(3), "GAMMA"), edit(DEBUG, a(8), HTTP_IMPORT)],
        outcomes: [[409, null], [200, "<8>"]],
        debug: (d) => { set(d, 8, HTTP_IMPORT); },
        unresolved: (_a, b) => [[{ anchor: b(3), kind: "missing" }], null],
    },
];

const check = async (ctx: Ctx, c: Case, edits: EditRow[], a: Anchors, b: Anchors): Promise<void> => {
    assert.deepEqual(
        edits.map(({ status, landed }, index) => [status, c.outcomes[index]?.[1] === undefined ? undefined : landed]),
        c.outcomes.map(([status, landed]) => [status, landed]),
        `${c.name}: outcomes ${JSON.stringify(edits.map(({ status, landed, unresolved }) => ({ status, landed, unresolved })))}`,
    );
    if (c.unresolved !== undefined) {
        assert.deepEqual(edits.map(({ unresolved }) => unresolved), c.unresolved(a, b), `${c.name}: each refusal names exactly its own unresolved anchors`);
    }
    assert.deepEqual(await fileLines(ctx, DEBUG), expectLines(DEBUG_LINES, c.debug ?? (() => {})), `${c.name}: ${DEBUG} after the program`);
    assert.deepEqual(await fileLines(ctx, HELPERS), expectLines(HELPERS_LINES, c.helpers ?? (() => {})), `${c.name}: ${HELPERS} after the program`);
};

for (const c of COHERENT) test(`{§edit-anchor-continuity}: coherent program, ${c.name}`, async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, c.frames);
        await check(ctx, c, edits, published[0], published[1]);
    });
});

for (const c of REFUSED) test(`{§edit-batch-receipt}: refused attempt, ${c.name}`, async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, c.frames);
        await check(ctx, c, edits, published[0], published[1]);
    });
});

test("{§edit-receipt-anchored-context}: every EDIT receipt carries its own padded window, and a later receipt supersedes a neighbour's anchor", async () => {
    await withProject(async (ctx) => {
        const { edits, published } = await program(ctx, 1, (a) => [edit(DEBUG, a(11), URLS_IMPORT), edit(DEBUG, a(12), "from django.utils import timezone  # kept"), edit(DEBUG, a(23), EXCEPT_404)]);
        const [a] = published;
        assert.deepEqual(edits.map(({ status, landed }) => [status, landed]), [[200, "<11>"], [200, "<12>"], [200, "<23>"]]);
        const contexts = edits.map(({ context }) => context!);
        assert.deepEqual(contexts.map((lines) => lines.length), [9, 9, 9], "four lines above and four below each single-line change");
        const anchorAt = (lines: string[], line: number): string => {
            const match = lines.map((text) => /^(@[0-9A-Za-z]{5}) +(\d+):/u.exec(text)).find((m) => m !== null && Number(m[2]) === line);
            assert.ok(match, `line ${line} in ${JSON.stringify(lines)}`);
            return match[1]!;
        };
        assert.notEqual(anchorAt(contexts[0]!, 12), a(12), "after line 11 changed, the first receipt already shows line 12 under a new anchor (its neighbourhood changed)");
        assert.equal(edits[1]!.landed, "<12>", "yet the program's original anchor for line 12 still landed there ({§edit-anchor-continuity})");
        assert.notEqual(anchorAt(contexts[1]!, 11), anchorAt(contexts[0]!, 11), "the second receipt supersedes the first receipt's anchor for line 11");
        assert.equal(anchorAt(contexts[2]!, 23), anchorAt(contexts[2]!, 23));
        assert.match(contexts[2]![4]!, /^@[0-9A-Za-z]{5} +23:    except Http404:$/u, "the changed line sits in the middle of its window");
    });
});

test("{§edit-anchor-continuity}: across programs, a neighbour's packet anchor is stale and refused; the receipt's anchor is current; a far anchor still holds", async () => {
    await withProject(async (ctx) => {
        const first = await program(ctx, 1, (a) => [edit(DEBUG, a(11), URLS_IMPORT)]);
        assert.deepEqual(first.edits.map(({ status, landed }) => [status, landed]), [[200, "<11>"]]);
        const [stale] = first.published;
        const second = await program(ctx, 2, (a) => {
            assert.notEqual(a(12), stale(12), "line 12's anchor changed with its neighbourhood");
            assert.equal(a(23), stale(23), "line 23's anchor did not");
            return [
                edit(DEBUG, stale(12), "from django.utils import timezone  # stale attempt"),
                edit(DEBUG, a(12), "from django.utils import timezone  # kept"),
                edit(DEBUG, stale(23), EXCEPT_404),
            ];
        });
        assert.deepEqual(second.edits.map(({ status, landed, unresolved }) => [status, landed, unresolved]), [
            [409, null, [{ anchor: stale(12), kind: "missing" }]],
            [200, "<12>", null],
            [200, "<23>", null],
        ]);
        assert.deepEqual(await fileLines(ctx, DEBUG), expectLines(DEBUG_LINES, (d) => { set(d, 11, URLS_IMPORT); set(d, 12, "from django.utils import timezone  # kept"); set(d, 23, EXCEPT_404); }));
    });
});

test("{§edit-anchor-continuity}: after a whole-file rewrite, every earlier anchor is stale", async () => {
    await withProject(async (ctx) => {
        const first = await program(ctx, 1, () => [edit(DEBUG, "1,-1", "# rewritten\n")]);
        assert.equal(first.edits[0]!.status, 200);
        const [original] = first.published;
        const second = await program(ctx, 2, () => [edit(DEBUG, original(23), EXCEPT_404)]);
        assert.deepEqual(second.edits.map(({ status, unresolved }) => [status, unresolved]), [[409, [{ anchor: original(23), kind: "missing" }]]]);
        assert.deepEqual(await fileLines(ctx, DEBUG), ["# rewritten"]);
    });
});
