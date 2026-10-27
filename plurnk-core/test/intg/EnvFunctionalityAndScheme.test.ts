import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { TEST_OWNER, serverProposals, ownSession } from "./_approval.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { type FunctionalityListResult, type PlurnkStatement, type FunctionalityDiscoverResult, type FunctionalityMutationResult } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors, makeRawMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession, openMigrated } from "./_db.ts";
import { type Db } from "../../src/core/Db.ts";
import { waitForDb, waitFor } from "./_rpc.ts";
import { modelOperation } from "./_sessions.ts";
import { Digest } from "@plurnk/plurnk-digest";
import { copyStmt, editStmt, findStmt, killStmt, readStmt, regex } from "./_dsl.ts";

describe("env-functionality", () => {
// {§functionality-coordinator} {§env-functionality} — the environment family beneath the shared
// coordinator, registered by Core. Session-scoped client actions, one durable value per session, and
// the model's manager bound to the invoking session: the shared verbs, acting for one session.
const VERBS = ["add", "disable", "discover", "enable", "list", "remove", "replace"];

for (const scope of ["session", "workspace"] as const) {
    test(`{§functionality-model-projection} ${scope} env admission precedes the next shell invocation`, { timeout: 15_000 }, async (t) => {
        serverProposals(t, "accept");
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse([
                PlurnkParser.frame("plurnk (env)", JSON.stringify({ verb: "add", scope, alias: "SETTLEMENT_WITNESS", definition: { value: "settled" } })),
                PlurnkParser.frame("sh", 'printf "%s" "$SETTLEMENT_WITNESS"'),
                PlurnkParser.frame("NOTE", "Review the shell output."),
            ].join("\n\n")),
            makeRawMockResponse(PlurnkParser.frame("SEND [200]", "Finished.")),
        ] });
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `env-ordered-${scope}` });
        const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
        const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Configure the witness and print it.", maxTurns: 2 });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
        const rows = await daemon.readLog({ workspaceId, sessionId, limit: Number.MAX_SAFE_INTEGER });
        assert.equal(rows.find((row) => row.origin === "model" && row.op === "plurnk")?.status_rx, 201);
        assert.ok(rows.some((row) => row.op === "READ" && row.scheme === "sh" && row.status_rx === 200 && JSON.stringify(row.rx).includes("settled")), "the command receives the just-published environment value");
    });
}

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const valueOf = (definition: object | undefined): string => {
    assert.ok(definition !== undefined && "value" in definition && typeof definition.value === "string", "an env definition carries a string value");
    return definition.value;
};

// A refusal is the verb's own operation result — the one shape the client action layer and the
// model's manager both convert — never a thrown fault.
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
    } catch (cause) {
        assert.ok(cause instanceof OperationFailureError, `a refusal is an operation result, not ${String(cause)}`);
        return cause.result.problem.type;
    }
    throw new Error("expected a refusal");
};

// The root node_modules holds the workspace packages, so `discover` can read a sibling's declarations.
const boot = async (db: Db): Promise<Daemon> => {
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: resolve("..", "node_modules") });
    await daemon.start();
    return daemon;
};

test("{§functionality-coordinator} env projects session-scoped actions; its state belongs to one session and its manager acts for the invoking session", async () => {
    const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,ENV_WITNESS";
    process.env.ENV_WITNESS = "ambient";
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-env-family-"));
    const dbPath = join(scratch, "plurnk.db");
    const db = await openMigrated(dbPath);
    let daemon = await boot(db);
    let quiescent = false;
    try {
        const workspaceId = await insertWorkspace(db, `env-family-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice", "model");
        await ownSession(db, workspaceId, alice);
        const bob = await insertSession(db, workspaceId, null, "bob", "model");
        await ownSession(db, workspaceId, bob);
        const invoke = <T>(sessionId: number, verb: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> =>
            daemon.invokeModuleAction(`session.env.${verb}`, params, { scope: "session", workspaceId, sessionId }) as Promise<T>;
        const listed = async (sessionId: number) => (await invoke<FunctionalityListResult>(sessionId, "list")).definitions;
        const stateOf = async (sessionId: number, alias: string): Promise<string | undefined> => {
            const definition = (await listed(sessionId)).find((entry) => entry.alias === alias);
            return definition === undefined ? undefined : `${definition.origin}:${definition.state}`;
        };

        // Both scopes use the same verbs; the action context binds their owner.
        assert.deepEqual(
            daemon.listModuleActions().filter(({ name }) => name.includes(".env.")).map(({ name, scope }) => `${name}:${scope}`),
            ["session", "workspace"].flatMap((scope) => VERBS.map((verb) => `${scope}.env.${verb}:${scope}`)),
        );

        // The service baseline is what the ceiling admits, with its value, under the shell's alias grammar.
        assert.equal(await stateOf(alice, "PATH"), "service:active", "an uppercase name is an alias for this family");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:active");
        assert.equal(valueOf((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.definition), "ambient");
        assert.deepEqual((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.provenance,
            { kind: "environment", source: "ENV_WITNESS" });

        // add → session origin, active, for alice alone.
        const added = await invoke<FunctionalityMutationResult>(alice, "add", { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
        assert.equal(added.status, 201);
        assert.equal(added.definition?.origin, "session", "origin names ownership: alice set it, not the workspace");
        assert.equal(added.definition?.state, "active");
        assert.equal(await stateOf(bob, "CARGO_TARGET_DIR"), undefined, "a sibling sees nothing of it");

        // disable masks an ambient name for alice alone; enable restores it.
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "disable", { alias: "ENV_WITNESS" })).definition?.state, "disabled");
        assert.equal(await stateOf(bob, "ENV_WITNESS"), "service:active", "the sibling's ambient name is untouched");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "enable", { alias: "ENV_WITNESS" })).definition?.state, "active");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "disable", { alias: "ENV_WITNESS" })).definition?.state, "disabled");

        // Admission refusals are the verb's own outcome: a name a shell cannot export, and plurnk's own.
        assert.equal(await refusal(() => invoke(alice, "add", { alias: "9NOPE", definition: { value: "x" } })), "https://problems.plurnk.xyz/env/functionality/name-invalid");
        assert.equal(await refusal(() => invoke(alice, "add", { alias: "PLURNK_SERVICE_DB_PATH", definition: { value: "/tmp/steal.db" } })), "https://problems.plurnk.xyz/env/functionality/name-reserved");
        assert.equal(await refusal(() => invoke(alice, "enable", { alias: "GHOST" })), "https://problems.plurnk.xyz/functionality/alias-unknown");

        // {§configuration-repair-path}
        assert.equal(await refusal(() => invoke(alice, "remove", { alias: "ENV_WITNESS" })), "https://problems.plurnk.xyz/functionality/alias-service-owned");
        const shadow = await invoke<FunctionalityMutationResult>(alice, "add", { alias: "ENV_WITNESS", definition: { value: "mine" } });
        assert.equal(shadow.definition?.origin, "session");
        assert.equal(shadow.definition?.provenance, undefined, "a session's override is not the ambient configuration");
        assert.equal(valueOf(shadow.definition?.definition), "mine");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "remove", { alias: "ENV_WITNESS" })).removed, true);
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:active", "removal restores inherited enabledness");
        assert.deepEqual((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.provenance,
            { kind: "environment", source: "ENV_WITNESS" });
        assert.equal(valueOf((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.definition), "ambient");
        await invoke(alice, "disable", { alias: "ENV_WITNESS" });

        // remove forgets a session entry; discover is inert and reads a sibling package's declaration.
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "remove", { alias: "CARGO_TARGET_DIR" })).removed, true);
        assert.equal(await stateOf(alice, "CARGO_TARGET_DIR"), undefined);
        const discovered = await invoke<FunctionalityDiscoverResult>(alice, "discover", { query: "PAGER" });
        assert.equal(discovered.candidates.find(({ alias }) => alias === "PAGER")?.provenance.source, "@plurnk/plurnk-execs");
        assert.equal(await stateOf(alice, "PAGER"), undefined, "discovery persisted nothing");
        // {§functionality-replacement} A request naming no input is the whole catalog; a client's
        // own configuration is no input, refused by the shared schema check.
        const catalog = (await invoke<FunctionalityDiscoverResult>(alice, "discover", {})).candidates;
        assert.ok(catalog.some(({ alias }) => alias === "PAGER"), "the empty request lists the catalog");
        assert.ok(catalog.length > discovered.candidates.length, "the whole catalog, not a query's matches");
        assert.equal(await refusal(() => invoke(alice, "discover", { configuration: {} })), "https://problems.plurnk.xyz/functionality/arguments-invalid");
        assert.equal(await refusal(() => invoke(alice, "discover", { source: ".env" })), "https://problems.plurnk.xyz/env/functionality/source-unknown");
        assert.deepEqual((await invoke<FunctionalityDiscoverResult>(alice, "discover", {
            source: "@plurnk/plurnk-execs", query: "no-such-catalog-name",
        })).candidates, []);

        // Persistence: alice's shaping survives a restart; bob's is untouched.
        await invoke(alice, "add", { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
        await daemon.stop();
        daemon = await boot(db);
        assert.equal(await stateOf(alice, "CARGO_TARGET_DIR"), "session:active");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled");
        assert.equal(await stateOf(bob, "ENV_WITNESS"), "service:active");
        assert.equal(await stateOf(bob, "CARGO_TARGET_DIR"), undefined);

        // Inheritance: a child of alice starts with her entries, each named for her; the child's own
        // entries carry no such name, and touching an inherited entry makes it the child's own.
        const carol = await insertSession(db, workspaceId, alice, "carol", "model");
        const inheritedOf = async (sessionId: number, alias: string) => (await listed(sessionId)).find((entry) => entry.alias === alias)?.inherited;
        assert.equal(await stateOf(carol, "CARGO_TARGET_DIR"), "session:active");
        assert.equal(await inheritedOf(carol, "CARGO_TARGET_DIR"), "alice", "list names the Session that set an inherited value");
        assert.equal(await stateOf(carol, "ENV_WITNESS"), "service:disabled", "a parent's masking of an ambient name travels too");
        assert.equal(await inheritedOf(carol, "ENV_WITNESS"), "alice");
        await invoke(carol, "add", { alias: "CAROL_ONLY", definition: { value: "c" } });
        assert.equal(await inheritedOf(carol, "CAROL_ONLY"), undefined, "an entry the child set itself names no source");
        await invoke(carol, "enable", { alias: "ENV_WITNESS" });
        assert.equal(await inheritedOf(carol, "ENV_WITNESS"), undefined, "a changed entry is the child's own");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled", "the child's change never reaches the parent");
        assert.equal(await stateOf(alice, "CAROL_ONLY"), undefined);

        // The model's projection: `plurnk (env)` is published on the `plurnk` manager, and Core binds it to the invoking
        // session at the operation, so alice's `list` is alice's and bob's is bob's.
        const outputs = async (): Promise<number> =>
            (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "plurnk", prefix: "/%" })).length;
        const exec = async (sessionId: number, program: string) => {
            const after = await outputs();
            const { status } = await modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(program) });
            return { status, result: () => awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after, timeoutMs: 10_000 }) };
        };
        const aliceList = await exec(alice, "````plurnk (env)````");
        assert.equal(aliceList.status, 200);
        const aliceView = await aliceList.result() as unknown as FunctionalityListResult;
        assert.equal(aliceView.definitions.find(({ alias }) => alias === "CARGO_TARGET_DIR")?.origin, "session");
        assert.equal(aliceView.definitions.find(({ alias }) => alias === "ENV_WITNESS")?.state, "disabled");
        const bobView = await (await exec(bob, "````plurnk (env)````")).result() as unknown as FunctionalityListResult;
        assert.equal(bobView.definitions.some(({ alias }) => alias === "CARGO_TARGET_DIR"), false, "the binding is per operation: bob's list is bob's");
        assert.equal(bobView.definitions.find(({ alias }) => alias === "ENV_WITNESS")?.state, "active");

        // A host verb proposes; acceptance persists for the invoking session and no other. Then the
        // spawn ({§execution-output-identity}): what alice set reaches alice's next command, bob's command sees
        // his own entry and the untouched ceiling — a registry, not a prefix.
        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        const accepted = async (sessionId: number, program: string): Promise<{ status: number; logEntryId: number }> => {
            const seen = proposals.length;
            const pending = modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(program) });
            await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10_000 });
            const logEntryId = proposals[seen];
            await daemon.resolveProposal(logEntryId, { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            return { status: (await pending).status, logEntryId };
        };
        const stdoutOf = async (logEntryId: number): Promise<string> => {
            const content = await waitForDb<string | null>(async () => {
                const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
                const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname?: string };
                if (pathname === undefined) return null;
                const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname });
                if (entry === undefined) return null;
                const channel = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entry.id, name: "stdout" });
                return channel?.state === "closed" ? channel.content : null;
            }, (value) => value !== null, { timeoutMs: 10_000 });
            return content!;
        };
        try {
            const before = await outputs();
            const bobAdded = await accepted(bob, `\`\`\`\`plurnk (env)\n${JSON.stringify({ verb: "add", alias: "BOB_ONLY", definition: { value: "1" } })}\n\`\`\`\``);
            assert.equal(bobAdded.status, 201, "the accepted add settled inside the operation");
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "plurnk", after: before, timeoutMs: 10_000 }) as unknown as FunctionalityMutationResult;
            assert.equal(outcome.definition?.origin, "session");
            assert.equal(await stateOf(bob, "BOB_ONLY"), "session:active", "an accepted model add persisted for the invoking session");
            assert.equal(await stateOf(alice, "BOB_ONLY"), undefined);

            const command = "````sh\necho \"target=[$CARGO_TARGET_DIR] witness=[$ENV_WITNESS] bob=[$BOB_ONLY]\"\n````";
            // The record lives on the spawn's output entry ({§execution-output-identity}), never on the
            // model's own log row.
            const recorded = async (logEntryId: number) => {
                const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
                const { pathname } = JSON.parse(log!.attrs) as { pathname: string };
                const output = await db.crud_find_workspace_entry.get<{ attributes: string }>({ workspace_id: workspaceId, scheme: "sh", authority: "", pathname });
                return (JSON.parse(output!.attributes) as { env: Record<string, { source: string; from?: string; value?: string }> }).env;
            };
            const aliceRun = await accepted(alice, command);
            assert.match(await stdoutOf(aliceRun.logEntryId), /target=\[\/tmp\/shared\] witness=\[\] bob=\[\]/,
                "alice's command receives what she set and not the ambient name she disabled");
            const bobRun = await accepted(bob, command);
            assert.match(await stdoutOf(bobRun.logEntryId), /target=\[\] witness=\[ambient\] bob=\[1\]/,
                "bob's command receives his own entry and the untouched ceiling");

            // The spawn records what it received, name by name with provenance, on its own log row.
            const aliceEnv = await recorded(aliceRun.logEntryId);
            assert.deepEqual(aliceEnv.CARGO_TARGET_DIR, { source: "session", value: "/tmp/shared" });
            assert.deepEqual(aliceEnv.ENV_WITNESS, { source: "masked" }, "a name alice withheld is recorded as masked, by her");
            assert.equal(aliceEnv.PATH?.source, "host");
            assert.deepEqual((await recorded(bobRun.logEntryId)).ENV_WITNESS, { source: "host", value: "ambient" });
            const carolRun = await accepted(carol, command);
            assert.match(await stdoutOf(carolRun.logEntryId), /target=\[\/tmp\/shared\] witness=\[ambient\] bob=\[\]/,
                "carol's command receives the value she inherited and the name she re-enabled");
            assert.deepEqual((await recorded(carolRun.logEntryId)).CARGO_TARGET_DIR, { source: "session", from: "alice", value: "/tmp/shared" },
                "the record names the Session that set an inherited value");
            await daemon.invokeModuleAction("workspace.env.add", { alias: "ENV_WITNESS", definition: { value: "workspace" } }, { scope: "workspace", workspaceId });
            const sharedRun = await accepted(bob, command);
            assert.match(await stdoutOf(sharedRun.logEntryId), /witness=\[workspace\]/u);
            assert.deepEqual((await recorded(sharedRun.logEntryId)).ENV_WITNESS, { source: "workspace", value: "workspace" });
            assert.equal(await stateOf(alice, "ENV_WITNESS"), "workspace:disabled", "the session's mask follows the name when its lower origin changes");
            const maskedRun = await accepted(alice, command);
            assert.match(await stdoutOf(maskedRun.logEntryId), /witness=\[\]/u);
            await invoke(bob, "add", { alias: "ENV_WITNESS", definition: { value: "session" } });
            const localRun = await accepted(bob, command);
            assert.match(await stdoutOf(localRun.logEntryId), /witness=\[session\]/u);
        } finally {
            unsubscribe();
        }

        // The digest renders what each spawn recorded, beside its operation ({§execution-output-identity}):
        // alice's own value and her masked name, carol's inherited value by its source.
        await daemon.stop();
        await db.close();
        quiescent = true;
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: join(scratch, "digest") });
        const waterfall = await readFile(join(scratch, "digest", "digest.md"), "utf8");
        assert.match(waterfall, /env: host [A-Z_,]+ · CARGO_TARGET_DIR=\/tmp\/shared \(session\) · ENV_WITNESS \(masked\)/u,
            "the waterfall names alice's spawn environment with each value's provenance");
        assert.match(waterfall, /CARGO_TARGET_DIR=\/tmp\/shared \(from alice\)/u, "and carol's inherited value by the Session that set it");
        assert.match(waterfall, /ENV_WITNESS=workspace \(workspace\)/u);
    } finally {
        if (!quiescent) {
            await daemon.stop();
            await db.close();
        }
        await rm(scratch, { recursive: true, force: true });
        delete process.env.ENV_WITNESS;
        if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
    }
});

// {§execution-output-identity} — a module reading the environment on a Session's behalf sees that Session's own
// overrides above the workspace layer, exactly what its commands run under; the workspace read
// never includes them.
test("{§functionality-coordinator} readSessionEnvironment layers the Session's overrides over the workspace's defaults", async () => {
    const db = await openMigrated();
    const daemon = await boot(db);
    try {
        const workspaceId = await insertWorkspace(db, `env-seam-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice", "model");
        await ownSession(db, workspaceId, alice);
        const bob = await insertSession(db, workspaceId, null, "bob", "model");
        await ownSession(db, workspaceId, bob);
        await daemon.invokeModuleAction("workspace.env.add", { alias: "TZ", definition: { value: "Europe/Paris" } }, { scope: "workspace", workspaceId });
        await daemon.invokeModuleAction("session.env.add", { alias: "TZ", definition: { value: "Asia/Tokyo" } }, { scope: "session", workspaceId, sessionId: alice });
        const ambient = { TZ: "UTC", PATH: process.env.PATH ?? "" };
        assert.equal((await daemon.readWorkspaceEnvironment(workspaceId))(ambient).TZ, "Europe/Paris", "the workspace layer over the ambient value");
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, "Asia/Tokyo", "alice's own override wins for alice");
        assert.equal((await daemon.readSessionEnvironment(workspaceId, bob))(ambient).TZ, "Europe/Paris", "bob inherits the workspace layer");
        const sessionContext = { scope: "session" as const, workspaceId, sessionId: alice };
        const removed = await daemon.invokeModuleAction("session.env.remove", { alias: "TZ" }, sessionContext) as FunctionalityMutationResult;
        assert.deepEqual(removed.definition, { alias: "TZ", origin: "workspace", state: "active", definition: { value: "Europe/Paris" } });
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, "Europe/Paris", "removal restores the shared value for subsequent commands");
        await daemon.invokeModuleAction("session.env.add", { alias: "TZ", definition: { value: "Asia/Tokyo" } }, sessionContext);
        await daemon.invokeModuleAction("workspace.env.disable", { alias: "TZ" }, { scope: "workspace", workspaceId });
        const disabled = await daemon.invokeModuleAction("session.env.remove", { alias: "TZ" }, sessionContext) as FunctionalityMutationResult;
        assert.deepEqual(disabled.definition, { alias: "TZ", origin: "workspace", state: "disabled", definition: { value: "Europe/Paris" } });
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, undefined, "removal also inherits a workspace mask");
        await daemon.invokeModuleAction("workspace.env.enable", { alias: "TZ" }, { scope: "workspace", workspaceId });
        assert.equal((await daemon.readSessionEnvironment(workspaceId, alice))(ambient).TZ, "Europe/Paris", "no session mask is left behind when the workspace changes");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("env-scheme", () => {
// {§env-functionality} — the environment registry as an address space: what `list` projects is what
// env:///NAME reads, writes land on the dispatching Session's own layer, and a value has no lines.
const PROBLEMS = "https://problems.plurnk.xyz";
const env = (name: string) => parsePath(`env:///${name}`)!;

test("{§env-functionality} every effective name reads at env:///NAME; EDIT and KILL act on the Session's own layer", async (t) => {
    const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    const previousWitness = process.env.ENV_WITNESS;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,ENV_WITNESS";
    process.env.ENV_WITNESS = "ambient";
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: resolve("..", "node_modules") });
    t.after(async () => {
        await daemon.stop();
        await db.close();
        if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT; else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
        if (previousWitness === undefined) delete process.env.ENV_WITNESS; else process.env.ENV_WITNESS = previousWitness;
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: `env-scheme-${crypto.randomUUID()}` });
    const alice = await insertSession(db, workspaceId, null, "alice", "model");
    await ownSession(db, workspaceId, alice);
    const bob = await insertSession(db, workspaceId, null, "bob", "model");
    await ownSession(db, workspaceId, bob);
    await daemon.invokeModuleAction("workspace.env.add", { alias: "TEAM_DEFAULT", definition: { value: "shared" } }, { scope: "workspace", workspaceId });

    // Each session's own operation: an env:/// address is the dispatching Session's registry ({§env-functionality}).
    const as = (sessionId: number) => (statement: PlurnkStatement) => modelOperation(daemon, db, { workspaceId, sessionId, statement });
    const dispatch = as(alice);
    const content = async (sessionId: number, name: string): Promise<string | number> => {
        const result = await as(sessionId)(readStmt(env(name)));
        return result.status === 200 ? String(result.content) : result.status;
    };
    const state = async (sessionId: number, alias: string): Promise<string | undefined> => {
        const listed = await daemon.invokeModuleAction("session.env.list", {}, { scope: "session", workspaceId, sessionId }) as FunctionalityListResult;
        const definition = listed.definitions.find((entry) => entry.alias === alias);
        return definition === undefined ? undefined : `${definition.origin}:${definition.state}`;
    };
    const find = async (path: string, matcher: ReturnType<typeof regex> | null = null): Promise<string[]> => {
        const result = await dispatch({ ...findStmt(parsePath(path), matcher), lineMarker: { marks: [1, -1] } });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.ok(Array.isArray(result.results));
        return (result.results.flat() as Array<{ path: string }>).map((item) => item.path);
    };

    // READ: the ceiling's ambient names, workspace defaults; a name outside the ceiling is no resource.
    assert.equal(await content(alice, "ENV_WITNESS"), "ambient");
    assert.equal(await content(alice, "TEAM_DEFAULT"), "shared");
    assert.equal(await content(alice, "PLURNK_SERVICE_DB_PATH"), 404, "reserved names are absent from the env resource projection");
    assert.equal(await content(alice, "GHOST"), 404);

    // FIND lists the names in effect and a pattern matches values.
    const listed = await find("env:///*");
    for (const name of ["ENV_WITNESS", "TEAM_DEFAULT", "PATH"]) assert.ok(listed.includes(`env:///${name}`), `${name} in ${listed.join(" ")}`);
    assert.deepEqual(await find("env:///**", regex("^ambient$")), ["env:///ENV_WITNESS"]);

    // COPY carries a value into a file.
    const copied = await dispatch(copyStmt(env("TEAM_DEFAULT"), parsePath("workspace:///value.txt")!));
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal(String((await dispatch(readStmt(parsePath("workspace:///value.txt")))).content).trimEnd(), "shared");

    // EDIT sets a Session's own value: a new name, and an override of an inherited one, for alice alone.
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/target"))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/target");
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), "session:active");
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/replaced"))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/replaced", "EDIT replaces an already-local value");
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), ""))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 204, "an empty value reads as an empty resource");
    const emptyValue = await daemon.invokeModuleAction("session.env.list", {}, { scope: "session", workspaceId, sessionId: alice }) as FunctionalityListResult;
    assert.deepEqual(emptyValue.definitions.find(({ alias }) => alias === "CARGO_TARGET_DIR")?.definition, { value: "" });
    await daemon.invokeModuleAction("session.env.disable", { alias: "CARGO_TARGET_DIR" }, { scope: "session", workspaceId, sessionId: alice });
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/offline"))).status, 200);
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), "session:disabled", "replacement does not enable a disabled definition");
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 404);
    await daemon.invokeModuleAction("session.env.enable", { alias: "CARGO_TARGET_DIR" }, { scope: "session", workspaceId, sessionId: alice });
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/offline");
    assert.equal(await content(bob, "CARGO_TARGET_DIR"), 404, "a sibling sees nothing of alice's layer");
    assert.equal((await dispatch(editStmt(env("ENV_WITNESS"), "mine"))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), "mine");
    assert.equal(await state(alice, "ENV_WITNESS"), "session:active");
    assert.equal(await content(bob, "ENV_WITNESS"), "ambient");

    // A value has no lines: a line scope is the facet's refusal, a pattern the dispatcher's for any
    // scheme without text scopes; admission is the family's, and its refusal is the operation's result.
    const problem = async (statement: PlurnkStatement): Promise<string> => {
        const result = await dispatch(statement) as { status: number; problem?: { type?: string } };
        return `${result.status} ${String(result.problem?.type).replace(`${PROBLEMS}/`, "")}`;
    };
    assert.equal(await problem(editStmt(env("ENV_WITNESS"), "x", { marks: [1, 1] })), "400 scheme/env/value-whole");
    assert.equal(await problem(editStmt(env("ENV_WITNESS"), "x", null, regex("mine"))), "400 engine/dispatcher/pattern-unsupported");
    assert.equal(await problem(editStmt(env("9NOPE"), "x")), "400 scheme/env/name-invalid");
    assert.equal(await problem(editStmt(parsePath("env://host/NAME"), "x")), "400 scheme/env/name-invalid");
    assert.equal(await problem(editStmt(env("PLURNK_SERVICE_DB_PATH"), "/tmp/steal.db")), "400 env/functionality/name-reserved");
    assert.equal(await problem(killStmt(env("ENV_WITNESS"), { marks: [1, 1] })), "400 scheme/env/value-whole");
    assert.equal(await problem(killStmt(env("GHOST"))), "404 scheme/env/entry-not-found");

    // KILL retires the name from alice's commands: remove for her own entry (restoring what it
    // shadowed), disable for an inherited one (its definition kept), never the workspace's layer.
    assert.equal((await dispatch(killStmt(env("CARGO_TARGET_DIR")))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 404);
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), undefined);
    assert.equal((await dispatch(killStmt(env("ENV_WITNESS")))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), "ambient", "removing the override restores the inherited value");
    assert.equal((await dispatch(killStmt(env("ENV_WITNESS")))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), 404);
    assert.equal(await state(alice, "ENV_WITNESS"), "service:disabled", "an inherited name is withheld, not forgotten");
    assert.equal((await dispatch(killStmt(env("TEAM_DEFAULT")))).status, 200);
    assert.equal(await content(alice, "TEAM_DEFAULT"), 404);
    assert.equal(await content(bob, "TEAM_DEFAULT"), "shared", "the workspace default is untouched");
    assert.equal(await problem(killStmt(env("TEAM_DEFAULT"))), "404 scheme/env/entry-not-found");
});
});

describe("session-module-state", () => {
// SPEC {§module-lifecycle} — a family declares whether its definitions belong to the
// workspace or to a session, and the coordinator keys state by that scope. `env` is the first
// session-scoped family: an environment is context (how this session works) rather than capability
// (what exists in this workspace).
//
// A sibling table rather than a nullable column, so the foreign key is real. These witnesses
// cover the two properties that choice buys: isolation between sessions, and a cascade that takes
// a session's definitions with it.
const OWNER = "@plurnk/plurnk-service";

test("{§module-lifecycle} session state is per session, not shared across siblings", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-${crypto.randomUUID()}`);
        const one = await insertSession(db, workspaceId);
        const two = await insertSession(db, workspaceId);

        await db.session_module_state_put.run({
            session_id: one, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { CARGO_TARGET_DIR: { origin: "session", enabled: true } } }),
        });

        const mine = await db.session_module_state_get.get<{ state: string }>({ session_id: one, namespace_owner: OWNER });
        const sibling = await db.session_module_state_get.get<{ state: string }>({ session_id: two, namespace_owner: OWNER });
        assert.match(mine!.state, /CARGO_TARGET_DIR/u);
        assert.equal(sibling, undefined, "a sibling session sees nothing of it — this is the whole reason for the scope");
    } finally { await db.close(); }
});

test("{§module-lifecycle} a session's definitions die with the session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-cascade-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await db.session_module_state_put.run({
            session_id: sessionId, namespace_owner: OWNER, state: JSON.stringify({ version: 1, definitions: {} }),
        });

        await db.test_delete_session.run({ id: sessionId });

        const orphan = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: OWNER });
        assert.equal(orphan, undefined, "the real foreign key cascades; a nullable column on the workspace table would have orphaned it");
    } finally { await db.close(); }
});

test("{§module-lifecycle} put replaces in place, keyed by (session, owner)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-replace-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const key = { session_id: sessionId, namespace_owner: OWNER };
        await db.session_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { A: {} } }) });
        await db.session_module_state_put.run({ ...key, state: JSON.stringify({ version: 1, definitions: { B: {} } }) });

        const row = await db.session_module_state_get.get<{ state: string }>(key);
        assert.match(row!.state, /"B"/u);
        assert.doesNotMatch(row!.state, /"A"/u, "one snapshot per (session, owner), replaced whole");
    } finally { await db.close(); }
});

// {§functionality-coordinator} — inheritance is a row copy at the child's creation, marked with its source.
const definitionsOf = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<Record<string, Record<string, unknown>>> => {
    const row = await db.session_module_state_get.get<{ state: string }>({ session_id: sessionId, namespace_owner: OWNER });
    return row === undefined ? {} : (JSON.parse(row.state) as { definitions: Record<string, Record<string, unknown>> }).definitions;
};

test("{§functionality-coordinator} a child starts with a copy of its parent's state, every entry named for its source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-state-inherit-${crypto.randomUUID()}`);
        const alice = await insertSession(db, workspaceId, null, "alice");
        await db.session_module_state_put.run({
            session_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: {
                CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" } },
                CI: { origin: "service", enabled: false },
            } }),
        });
        const bob = await insertSession(db, workspaceId, alice, "bob");
        assert.deepEqual(await definitionsOf(db, bob), {
            CARGO_TARGET_DIR: { origin: "session", enabled: true, definition: { value: "/tmp/shared" }, inherited: "alice" },
            CI: { origin: "service", enabled: false, inherited: "alice" },
        }, "copied faithfully, disabled entries included, each named for the Session that set it");

        // A snapshot, not a link: alice's later edit never reaches bob.
        await db.session_module_state_put.run({
            session_id: alice, namespace_owner: OWNER,
            state: JSON.stringify({ version: 1, definitions: { LATER: { origin: "session", enabled: true, definition: { value: "x" } } } }),
        });
        assert.deepEqual(Object.keys(await definitionsOf(db, bob)), ["CARGO_TARGET_DIR", "CI"]);

        // Depth is transitive and provenance names the origin, not the intermediate.
        const carol = await insertSession(db, workspaceId, bob, "carol");
        assert.equal((await definitionsOf(db, carol)).CARGO_TARGET_DIR.inherited, "alice", "a grandchild still names the Session that set the entry");

        // A parentless Session inherits nothing.
        const loner = await insertSession(db, workspaceId, null, "loner");
        assert.deepEqual(await definitionsOf(db, loner), {});
    } finally { await db.close(); }
});
});
