// Batteries-included executor coverage — every executor the service-owned
// default executor extensions ship, driven end-to-end through the REAL Exec
// scheme (dispatch → run/accept → spawn → read
// the captured output channel), not sh alone.
//
// Two axes: each runtime's output lands on its OWN
// declared channel (subprocess -> stdout), and host-effecting
// runtimes PROPOSE (accept) while pure/read ones are automatically accepted. The census requires
// every available self-contained tag to be covered and fails when a default tag is undiscovered
// ({§exec-registry-resolves}).

import test from "node:test";
import assert from "node:assert/strict";
import { ownSession } from "./_approval.ts";
import type { ExecStatement, RuntimeTag } from "@plurnk/plurnk-contracts";
import type { Effect } from "@plurnk/plurnk-execs";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { testExecutors } from "./_execs.ts";
import { localPath } from "./_dsl.ts";

// The host sets FORCE_COLOR; ANSI control bytes are the subject of this sanitizer.
// oxlint-disable-next-line eslint/no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

// {§exec-executor-slot} — the battery's third column is the program path, never a cwd.
const execStmt = (runtime: string, target: string | null, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: target === null ? null : localPath(target),
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Drive one executor through the full Exec path and return its captured, ANSI-stripped output —
// from the executor's OWN default channel (subprocess runtimes → stdout) —
// plus the one effect fact that drove automatic admission or proposal review.
const runExec = async (tag: string, body: string, cwd: string | null): Promise<{ status: number; out: string; effect: Effect; mimetype: string; declaredMimetype: string | undefined }> => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        const entry = registry.entry(tag);
        assert.ok(entry?.available, `the ${tag} executor is available`);
        const channel = entry.executor.defaultChannel;
        const declaredMimetype = entry.executor.channels[channel]?.mimetype;
        const workspaceId = await insertWorkspace(db, `batt-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "batteries");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt(tag, cwd, body),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Side-effecting (host) executors propose; pure/read ones are automatically
        // accepted within dispatch. The persisted effect is the deterministic fact —
        // a row-state check races automatic settlement. Accept only a host proposal.
        const proposal = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const effect = (JSON.parse(proposal?.attrs ?? "{}") as { effect: Effect }).effect;
        assert.ok(effect === "pure" || effect === "read" || effect === "host", "execution persists its canonical effect fact");
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
        assert.equal(out?.state, "closed", `${tag} output channel settled to closed by idle()`);
        return { status: result.status, out: stripAnsi(out?.content ?? ""), effect, mimetype: out?.mimetype ?? "", declaredMimetype };
    } finally {
        await db.close();
    }
};


// One deterministic specimen per bundled runtime. `gate` verifies its
// executor-owned effect fact through core admission. {§executor-effect}
const CASES: ReadonlyArray<{ tag: string; body: string; cwd: string | null; expect: string; gate: "propose" | "auto" }> = [
    // Subprocess runtimes execute arbitrary host code → ALWAYS `host` → always gated, even for a
    // visibly-harmless command (the executor classifies the target, never parses the command to judge it).
    { tag: "python3", body: "print(sum(range(101)))", cwd: null, expect: "5050\n", gate: "propose" },
    { tag: "js", body: "console.log(6 * 7)", cwd: null, expect: "42\n", gate: "propose" },
];

// Self-contained batteries tags — runnable deterministically with no external resource. The census
// REQUIRES every one of these that the host probes available to be covered by this suite (sh is
// covered by Exec.scheme.test.ts).
const SELF_CONTAINED = ["sh", "js", "python3"] as const;

test("{§exec-registry-resolves} execs batteries: coverage census — every self-contained default-install tag is exercised", async () => {
    const reg = await testExecutors();
    const available = new Set(reg.availableRuntimes());
    const covered = new Set(CASES.map((c) => c.tag).concat("sh")); // sh: Exec.scheme.test.ts
    // {§exec-registry-resolves}: the registry retains probe-failed entries as unavailable; a missing
    // entry means the default composition deleted or renamed a package, not that this host lacks it.
    const undiscovered = SELF_CONTAINED.filter((t) => reg.entry(t) === undefined);
    assert.deepEqual(undiscovered, [], `census tags missing from the bundle entirely (deleted/renamed package?): ${undiscovered.join(", ")}`);
    const exercised = SELF_CONTAINED.filter((t) => available.has(t) && covered.has(t));
    const unavailable = SELF_CONTAINED.filter((t) => !available.has(t));
    const uncovered = SELF_CONTAINED.filter((t) => available.has(t) && !covered.has(t));
    console.log(`  self-contained, exercised: ${exercised.join(", ")}`);
    console.log(`  unavailable in this env: ${unavailable.join(", ") || "(none)"}`);
    assert.deepEqual(uncovered, [], `every AVAILABLE self-contained batteries tag must be covered — uncovered: ${uncovered.join(", ")}`);

    // Subprocess runtimes declare text/stream on stdout.
    const declMime = (tag: string): string | undefined => {
        const e = reg.entry(tag);
        return e?.executor?.channels[e.executor.defaultChannel]?.mimetype;
    };
    for (const t of ["js", "python3"]) assert.equal(declMime(t), "text/stream", `${t} stdout channel is text/stream`);
});

for (const { tag, body, cwd, expect, gate } of CASES) {
    const label = `${tag}${cwd === null ? "" : ` (${gate} target)`}`;
    test(`{§executor-consumer-boundary} execs batteries: ${label} runs through the real Exec scheme, captures output, gates per effect`, async (t) => {
        const reg = await testExecutors();
        if (!reg.availableRuntimes().includes(tag)) {
            t.skip(`${tag} not available in this env (probe failed / resource-gated)`);
            return;
        }
        const { status, out, effect, mimetype, declaredMimetype } = await runExec(tag, body, cwd);
        assert.equal(status, 200, `${label} dispatch returns 200`);
        assert.equal(out, expect, `${label} output`);
        // The stream entry's channel carries the executor's OWN declared mimetype.
        // The Exec seed honors the declaration; the write never overwrites it.
        assert.equal(mimetype, declaredMimetype, `${label} channel carries the executor's declared mimetype`);
        // The security boundary: effect→gate must match. A host runtime MUST propose (be review-gated);
        // a pure/read one MUST auto-run. A regression that automatically admits
        // a host runtime would let arbitrary host code run ungated.
        assert.equal(effect === "host" ? "propose" : "auto", gate, `${label} effect drives the expected proposal policy`);
    });
}

test("{§exec-executor-slot} an unregistered executable tag fails without shell reinterpretation", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const registry = await testExecutors();
        engine.setExecutors(registry);
        assert.ok(!registry.availableRuntimes().includes("echo"), "precondition: echo is NOT a registered runtime");
        const workspaceId = await insertWorkspace(db, `batt-ft-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "ft");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: execStmt("echo", null, "hello fallthrough"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        // {§exec-executor-slot} — an unregistered executor name is refused as such, never reinterpreted
        // as a shell command word; the refusal lists what is registered.
        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
        assert.equal(result.problem?.requestedRuntime, "echo");
        assert.deepEqual(result.problem?.executors, registry.availableRuntimes(), "the refusal lists the registered executors");
        assert.equal(result.problem?.toolRuntimes, undefined, "an arbitrary unknown word names no tool runtime");
        const shell = await engine.dispatch({
            statement: execStmt("shell", null, "printf hello"),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(shell.status, 400);
        assert.equal(shell.problem?.requestedRuntime, "shell", "an unknown alias does not trigger an intent-presuming correction");
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname: "/1/1/1/sh" });
        assert.equal(entryRow, undefined, "an unknown tag never spawns or creates a shell stream");
    } finally { await db.close(); }
});
