// Batteries-included executor coverage — every EXEC[tag] the service-owned
// default executor leaf set ships, driven end-to-end through the REAL Exec
// scheme (dispatch → run/accept → spawn → read
// the captured output channel), not sh alone. Historically only EXEC[sh] (and one EXEC[node]) were
// exercised; the rest of the bundle (jq, sqlite, wat/wasm, awk, bc, perl, python, …) went untested.
//
// Two axes the suite gets right because the gap hid them: each runtime's output lands on its OWN
// declared channel (subprocess and native Git -> stdout; jq/sqlite/wat -> a JSON `results` channel), and host-effecting
// runtimes PROPOSE (accept) while pure/read ones are automatically accepted. The census
// REQUIRES every available self-contained tag to be covered, REPORTS the resource-gated ones
// (search is covered in the live tier; wasm needs a compiled module — its
// compile+run path is covered inline via `wat`), and FAILS on a census tag that is not even
// discovered ({§exec-registry-resolves}), so a deleted default leaf cannot masquerade as an
// environment-specific probe failure.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import type { Effect } from "@plurnk/plurnk-execs";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";

// The host sets FORCE_COLOR; ANSI control bytes are the subject of this sanitizer.
// oxlint-disable-next-line eslint/no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const execStmt = (runtime: string, cwd: string | null, body: string): ExecStatement => ({
    op: "EXEC", annotation: null, delimiter: "", signal: runtime,
    target: cwd === null ? null : { kind: "local", raw: cwd },
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Drive one EXEC[tag] through the full Exec path and return its captured, ANSI-stripped output —
// from the executor's OWN default channel (subprocess runtimes → stdout; jq/sqlite/wat → results) —
// plus the one effect fact that drove automatic admission or proposal review.
const runExec = async (tag: string, body: string, cwd: string | null): Promise<{ status: number; out: string; effect: Effect; mimetype: string; declaredMimetype: string | undefined }> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        const channel = registry.entry(tag)?.executor.defaultChannel ?? "stdout";
        const declaredMimetype = registry.entry(tag)?.executor.channels[channel]?.mimetype;
        const workspaceId = await insertWorkspace(db, `batt-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "batteries");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(tag, cwd, body),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Side-effecting (host) executors propose; pure/read ones are automatically
        // accepted within dispatch. The persisted effect is the deterministic fact —
        // a row-state check races automatic settlement. Accept only a host proposal.
        const proposal = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const effect = (JSON.parse(proposal?.attrs ?? "{}") as { effect: Effect }).effect;
        assert.ok(effect === "pure" || effect === "read" || effect === "host", "EXEC persists its canonical effect fact");
        if (effect === "host") engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        await exec.idle(); // the spawn runs async; idle() awaits its close

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: tag, pathname });
        // idle() awaits the spawn promise, which drains the channel-write queue before resolving, so the
        // output is committed by here — for auto-accepted and proposed runtimes alike. No poll, no close-race.
        const out = entryRow
            ? await db.test_get_channel.get<{ content: string; state: string; mimetype: string }>({ entry_id: entryRow.id, name: channel })
            : undefined;
        assert.equal(out?.state, "closed", `EXEC[${tag}] output channel settled to closed by idle()`);
        return { status: result.status, out: stripAnsi(out?.content ?? ""), effect, mimetype: out?.mimetype ?? "", declaredMimetype };
    } finally {
        await db.close();
    }
};


const tmp = mkdtempSync(join(tmpdir(), "plurnk-batt-"));

// One deterministic specimen per bundled runtime. `gate` verifies its
// executor-owned effect fact through core admission. {§executor-effect}
const CASES: ReadonlyArray<{ tag: string; body: string; cwd: string | null; expect: string; gate: "propose" | "auto" }> = [
    // Subprocess runtimes execute arbitrary host code → ALWAYS `host` → always gated, even for a
    // visibly-harmless command (the executor classifies the target, never parses the command to judge it).
    { tag: "awk", body: "BEGIN { print 6 * 7 }", cwd: null, expect: "42\n", gate: "propose" },
    { tag: "bc", body: "scale=4; 22/7", cwd: null, expect: "3.1428\n", gate: "propose" },
    { tag: "perl", body: "print join(',', 1..5)", cwd: null, expect: "1,2,3,4,5", gate: "propose" },
    { tag: "python", body: "print(sum(range(101)))", cwd: null, expect: "5050\n", gate: "propose" },
    { tag: "node", body: "console.log(6 * 7)", cwd: null, expect: "42\n", gate: "propose" },
    { tag: "bash", body: "echo $((6 * 7))", cwd: null, expect: "42\n", gate: "propose" },
    // Sandboxed/in-process computational runtimes earn `pure` when the target implies no host mutation.
    { tag: "jq", body: "[1,2,3] | add", cwd: null, expect: "6\n", gate: "auto" }, // inline filter → pure
    { tag: "sqlite", body: "SELECT 2 + 2 AS n", cwd: null, expect: '[{"n":4}]', gate: "auto" }, // :memory: → pure; rows as JSON
    { tag: "wat", body: '(module (func (export "main") (result i32) i32.const 42))', cwd: null, expect: '{"returned":42,"log":[],"exports":["main"]}', gate: "auto" }, // sandboxed module → pure
    // The boundary is TARGET-driven, not executor-driven: the SAME sqlite executor flips to `host` (gated)
    // the moment its target is a real db FILE it could mutate — the security line that the gate exists to draw.
    { tag: "sqlite", body: "SELECT 2 + 2 AS n", cwd: join(tmp, "app.db"), expect: '[{"n":4}]', gate: "propose" },
];

// Self-contained batteries tags — runnable deterministically with no external resource. The census
// REQUIRES every one of these that the host probes available to be covered by this suite (sh is
// covered by Exec.scheme.test.ts; native Git is exercised below when its binary is available).
const SELF_CONTAINED = ["sh", "bash", "node", "awk", "bc", "perl", "python", "jq", "sqlite", "wat", "git"] as const;
// Resource/binary-gated tags — need a server or a compiled artifact. Reported, not required here:
// search is exercised in the live tier; wasm needs a compiled module (its compile+run path is
// covered inline via `wat`). Protocol modules register their configured tags through the daemon
// module seam and are covered by module-runtime.test.ts rather than this installed-plugin census.
const RESOURCE_GATED = ["wasm", "search"] as const;

test("execs batteries: coverage census — every self-contained default-install tag is exercised", async () => {
    const reg = await testExecutors();
    const available = new Set(reg.availableRuntimes());
    const covered = new Set(CASES.map((c) => c.tag).concat("sh", "git")); // sh: Exec.scheme.test.ts; git: the init→status test below
    // {§exec-registry-resolves}: the registry retains probe-failed entries as unavailable; a missing
    // entry means the default composition deleted or renamed a package, not that this host lacks it.
    const undiscovered = [...SELF_CONTAINED, ...RESOURCE_GATED].filter((t) => reg.entry(t) === undefined);
    assert.deepEqual(undiscovered, [], `census tags missing from the bundle entirely (deleted/renamed package?): ${undiscovered.join(", ")}`);
    const exercised = SELF_CONTAINED.filter((t) => available.has(t) && covered.has(t));
    const gatedPresent = RESOURCE_GATED.filter((t) => available.has(t));
    const unavailable = [...SELF_CONTAINED, ...RESOURCE_GATED].filter((t) => !available.has(t));
    const uncovered = SELF_CONTAINED.filter((t) => available.has(t) && !covered.has(t));
    console.log(`  self-contained, exercised: ${exercised.join(", ")}`);
    console.log(`  resource-gated, present (covered elsewhere / needs resources): ${gatedPresent.join(", ") || "(none)"}`);
    console.log(`  unavailable in this env: ${unavailable.join(", ") || "(none)"}`);
    assert.deepEqual(uncovered, [], `every AVAILABLE self-contained batteries tag must be covered — uncovered: ${uncovered.join(", ")}`);
    assert.ok(available.has("jq") && available.has("sqlite") && available.has("wat"), "the core batteries executors (jq, sqlite, wat) are discovered and available");

    // Channel mimetype shape: a results-returning runtime declares the HONEST JSON family on its channel
    // so consumers route jsonpath/render correctly — sqlite/wat emit a single document (application/json),
    // jq is a streaming filter that emits newline-delimited values
    // ({§executor-default-inventory}: application/jsonl).
    // Subprocess runtimes declare text/stream on stdout.
    const declMime = (tag: string): string | undefined => {
        const e = reg.entry(tag);
        return e === undefined ? undefined : e.executor.channels[e.executor.defaultChannel]?.mimetype;
    };
    assert.equal(declMime("sqlite"), "application/json", "EXEC[sqlite] results channel is application/json (single document)");
    assert.equal(declMime("wat"), "application/json", "EXEC[wat] results channel is application/json (single document)");
    assert.equal(declMime("jq"), "application/jsonl", "EXEC[jq] results channel is application/jsonl (newline-delimited stream)");
    assert.equal(declMime("git"), "text/stream", "EXEC[git] exposes the native CLI stdout stream");
    for (const t of ["node", "awk", "bash"]) assert.equal(declMime(t), "text/stream", `EXEC[${t}] stdout channel is text/stream`);
});

for (const { tag, body, cwd, expect, gate } of CASES) {
    const label = `EXEC[${tag}]${cwd === null ? "" : ` (${gate} target)`}`;
    test(`execs batteries: ${label} runs through the real Exec scheme, captures output, gates per effect`, async (t) => {
        const reg = await testExecutors();
        if (!reg.availableRuntimes().includes(tag)) {
            t.skip(`EXEC[${tag}] not available in this env (probe failed / resource-gated)`);
            return;
        }
        const { status, out, effect, mimetype, declaredMimetype } = await runExec(tag, body, cwd);
        assert.equal(status, 200, `${label} dispatch returns 200`);
        assert.equal(out, expect, `${label} output`);
        // The stream entry's channel carries the executor's OWN declared mimetype — so a JSON-returning
        // runtime (sqlite/jq/wat → application/json) is routed by mimetype-aware consumers (jsonpath,
        // render), never mislabelled text/stream. The Exec seed honors the declaration; the write never overwrites it.
        assert.equal(mimetype, declaredMimetype, `${label} channel carries the executor's declared mimetype`);
        // The security boundary: effect→gate must match. A host runtime MUST propose (be review-gated);
        // a pure/read one MUST auto-run. A regression that automatically admits
        // a host runtime would let arbitrary host code run ungated.
        assert.equal(effect === "host" ? "propose" : "auto", gate, `${label} effect drives the expected proposal policy`);
    });
}

test("execs batteries: EXEC[git] preserves native checkout argv through the assembled scheme path", async (t) => {
    const registry = await testExecutors();
    if (!registry.availableRuntimes().includes("git")) {
        t.skip("native Git is not available on PATH");
        return;
    }
    const repo = mkdtempSync(join(tmpdir(), "plurnk-batt-git-"));
    const init = await runExec("git", "init", repo);
    assert.equal(init.status, 200, "EXEC[git]:init dispatches 200");
    assert.equal(init.effect, "host", "native Git is host-effecting and proposal-gated");
    assert.equal(init.mimetype, "text/stream", "native Git stdout is a text stream");
    assert.equal((await runExec("git", "config user.email fixture@plurnk.invalid", repo)).status, 200);
    assert.equal((await runExec("git", 'config user.name "Plurnk Fixture"', repo)).status, 200);
    writeFileSync(join(repo, "fixture.txt"), "fixture\n");
    assert.equal((await runExec("git", "add fixture.txt", repo)).status, 200);
    assert.equal(
        (await runExec("git", '-c commit.gpgsign=false commit --no-verify -m "fixture"', repo)).status,
        200,
    );
    assert.equal(
        (await runExec("git", "checkout -b feature/module-loading", repo)).status,
        200,
        "native checkout -b is not translated into a different command",
    );
    const branch = await runExec("git", "branch --show-current", repo);
    assert.equal(branch.status, 200);
    assert.equal(branch.out.trim(), "feature/module-loading");
});

test("an unregistered executable tag fails without shell reinterpretation", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        assert.ok(!registry.availableRuntimes().includes("echo"), "precondition: echo is NOT a registered runtime");
        const workspaceId = await insertWorkspace(db, `batt-ft-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "ft");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: execStmt("echo", null, "hello fallthrough"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 501);
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/exec/runtime-not-registered");
        assert.equal(result.problem?.requestedRuntime, "echo");
        assert.ok(Array.isArray(result.problem?.availableRuntimes));
        assert.match(result.problem?.recovery as string, /^Use bare EXEC for a shell command/);
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname: "/1/1/1" });
        assert.equal(entryRow, undefined, "an unknown tag never spawns or creates a shell stream");
    } finally { await db.close(); }
});
