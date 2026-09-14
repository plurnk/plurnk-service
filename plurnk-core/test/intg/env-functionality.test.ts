// {§functionality-scope} {§env-functionality} — the environment family beneath the shared
// coordinator, registered by Core. Worker-scoped client actions, one durable value per worker, and
// the model's manager bound to the invoking worker: the same six verbs, acting for one worker.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { FunctionalityDiscoverResult, FunctionalityListResult, FunctionalityMutationResult, PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import type { Db } from "../../src/core/Db.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { awaitExecOutcome, fixtureExecutors, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { waitFor, waitForDb } from "./_rpc.ts";

const VERBS = ["add", "disable", "discover", "enable", "list", "remove"];

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

test("{§functionality-scope} env projects worker-scoped actions; its state belongs to one worker and its manager acts for the invoking worker", async () => {
    const previousInherit = process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
    process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = "PATH,HOME,ENV_WITNESS";
    process.env.ENV_WITNESS = "ambient";
    const db = await openMigrated();
    let daemon = await boot(db);
    try {
        const workspaceId = await insertWorkspace(db, `env-family-${crypto.randomUUID()}`);
        const alice = await insertWorker(db, workspaceId, null, "alice", "client");
        const bob = await insertWorker(db, workspaceId, null, "bob", "client");
        const invoke = <T>(workerId: number, verb: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> =>
            daemon.invokeModuleAction(`worker.env.${verb}`, params, { scope: "worker", workspaceId, workerId }) as Promise<T>;
        const listed = async (workerId: number) => (await invoke<FunctionalityListResult>(workerId, "list")).definitions;
        const stateOf = async (workerId: number, alias: string): Promise<string | undefined> => {
            const definition = (await listed(workerId)).find((entry) => entry.alias === alias);
            return definition === undefined ? undefined : `${definition.origin}:${definition.state}`;
        };

        // Registration projects six worker-scoped actions and no workspace-scoped ones.
        assert.deepEqual(
            daemon.listModuleActions().filter(({ name }) => name.includes(".env.")).map(({ name, scope }) => `${name}:${scope}`),
            VERBS.map((verb) => `worker.env.${verb}:worker`),
        );

        // The service baseline is what the ceiling admits, with its value, under the shell's alias grammar.
        assert.equal(await stateOf(alice, "PATH"), "service:active", "an uppercase name is an alias for this family");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:active");
        assert.equal(valueOf((await listed(alice)).find((entry) => entry.alias === "ENV_WITNESS")?.definition), "ambient");

        // add → worker origin, active, for alice alone.
        const added = await invoke<FunctionalityMutationResult>(alice, "add", { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
        assert.equal(added.status, 201);
        assert.equal(added.definition?.origin, "worker", "origin names ownership: alice set it, not the workspace");
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

        // Service definitions are disable-only; a worker definition may shadow one, and removal reveals it disabled.
        assert.equal(await refusal(() => invoke(alice, "remove", { alias: "ENV_WITNESS" })), "https://problems.plurnk.xyz/functionality/alias-service-owned");
        const shadow = await invoke<FunctionalityMutationResult>(alice, "add", { alias: "ENV_WITNESS", definition: { value: "mine" } });
        assert.equal(shadow.definition?.origin, "worker");
        assert.equal(valueOf(shadow.definition?.definition), "mine");
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "remove", { alias: "ENV_WITNESS" })).removed, true);
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled", "removal reveals the service baseline, disabled — the next spawn is not silently changed");

        // remove forgets a worker entry; discover is inert and reads a sibling package's declaration.
        assert.equal((await invoke<FunctionalityMutationResult>(alice, "remove", { alias: "CARGO_TARGET_DIR" })).removed, true);
        assert.equal(await stateOf(alice, "CARGO_TARGET_DIR"), undefined);
        const discovered = await invoke<FunctionalityDiscoverResult>(alice, "discover", { query: "PAGER" });
        assert.equal(discovered.candidates.find(({ alias }) => alias === "PAGER")?.provenance.source, "@plurnk/plurnk-execs");
        assert.equal(await stateOf(alice, "PAGER"), undefined, "discovery persisted nothing");

        // Persistence: alice's shaping survives a restart; bob's is untouched.
        await invoke(alice, "add", { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } });
        await daemon.stop();
        daemon = await boot(db);
        assert.equal(await stateOf(alice, "CARGO_TARGET_DIR"), "worker:active");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled");
        assert.equal(await stateOf(bob, "ENV_WITNESS"), "service:active");
        assert.equal(await stateOf(bob, "CARGO_TARGET_DIR"), undefined);

        // Inheritance: a child of alice starts with her entries, each named for her; the child's own
        // entries carry no such name, and touching an inherited entry makes it the child's own.
        const carol = await insertWorker(db, workspaceId, alice, "carol", "client");
        const inheritedOf = async (workerId: number, alias: string) => (await listed(workerId)).find((entry) => entry.alias === alias)?.inherited;
        assert.equal(await stateOf(carol, "CARGO_TARGET_DIR"), "worker:active");
        assert.equal(await inheritedOf(carol, "CARGO_TARGET_DIR"), "alice", "list names the Worker that set an inherited value");
        assert.equal(await stateOf(carol, "ENV_WITNESS"), "service:disabled", "a parent's masking of an ambient name travels too");
        assert.equal(await inheritedOf(carol, "ENV_WITNESS"), "alice");
        await invoke(carol, "add", { alias: "CAROL_ONLY", definition: { value: "c" } });
        assert.equal(await inheritedOf(carol, "CAROL_ONLY"), undefined, "an entry the child set itself names no source");
        await invoke(carol, "enable", { alias: "ENV_WITNESS" });
        assert.equal(await inheritedOf(carol, "ENV_WITNESS"), undefined, "a changed entry is the child's own");
        assert.equal(await stateOf(alice, "ENV_WITNESS"), "service:disabled", "the child's change never reaches the parent");
        assert.equal(await stateOf(alice, "CAROL_ONLY"), undefined);

        // The model's projection: `env` is one published manager, and Core binds it to the invoking
        // worker at the operation, so alice's `list` is alice's and bob's is bob's.
        const outputs = async (): Promise<number> =>
            (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "env", prefix: "/%" })).length;
        const exec = async (workerId: number, program: string) => {
            const after = await outputs();
            const { status } = await daemon.dispatchAsClient({ workspaceId, workerId, statement: parseOne(program) });
            return { status, result: () => awaitExecOutcome(db, { workspaceId, scheme: "env", after, timeoutMs: 10_000 }) };
        };
        const aliceList = await exec(alice, "```env (list)```");
        assert.equal(aliceList.status, 200);
        const aliceView = await aliceList.result() as unknown as FunctionalityListResult;
        assert.equal(aliceView.definitions.find(({ alias }) => alias === "CARGO_TARGET_DIR")?.origin, "worker");
        assert.equal(aliceView.definitions.find(({ alias }) => alias === "ENV_WITNESS")?.state, "disabled");
        const bobView = await (await exec(bob, "```env (list)```")).result() as unknown as FunctionalityListResult;
        assert.equal(bobView.definitions.some(({ alias }) => alias === "CARGO_TARGET_DIR"), false, "the binding is per operation: bob's list is bob's");
        assert.equal(bobView.definitions.find(({ alias }) => alias === "ENV_WITNESS")?.state, "active");

        // A host verb proposes; acceptance persists for the invoking worker and no other. Then the
        // spawn ({§exec-env-scoped}): what alice set reaches alice's next command, bob's command sees
        // his own entry and the untouched ceiling — a registry, not a prefix.
        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspace, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        const accepted = async (workerId: number, program: string): Promise<{ status: number; logEntryId: number }> => {
            const seen = proposals.length;
            const pending = daemon.dispatchAsClient({ workspaceId, workerId, statement: parseOne(program) });
            await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10_000 });
            const logEntryId = proposals[seen]!;
            daemon.resolveProposal(logEntryId, { decision: "accept" });
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
            const added = await accepted(bob, `\`\`\`env (add)\n${JSON.stringify({ alias: "BOB_ONLY", definition: { value: "1" } })}\n\`\`\``);
            assert.equal(added.status, 200, "the accepted add settled inside the operation");
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "env", after: before, timeoutMs: 10_000 }) as unknown as FunctionalityMutationResult;
            assert.equal(outcome.definition?.origin, "worker");
            assert.equal(await stateOf(bob, "BOB_ONLY"), "worker:active", "an accepted model add persisted for the invoking worker");
            assert.equal(await stateOf(alice, "BOB_ONLY"), undefined);

            const command = "```sh\necho \"target=[$CARGO_TARGET_DIR] witness=[$ENV_WITNESS] bob=[$BOB_ONLY]\"\n```";
            assert.match(await stdoutOf((await accepted(alice, command)).logEntryId), /target=\[\/tmp\/shared\] witness=\[\] bob=\[\]/,
                "alice's command receives what she set and not the ambient name she disabled");
            assert.match(await stdoutOf((await accepted(bob, command)).logEntryId), /target=\[\] witness=\[ambient\] bob=\[1\]/,
                "bob's command receives his own entry and the untouched ceiling");
        } finally {
            unsubscribe();
        }
    } finally {
        await daemon.stop();
        await db.close();
        delete process.env.ENV_WITNESS;
        if (previousInherit === undefined) delete process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT;
        else process.env.PLURNK_SERVICE_EXEC_ENV_INHERIT = previousInherit;
    }
});
