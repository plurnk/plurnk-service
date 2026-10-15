// {§env-scheme} — the environment registry as an address space: what `list` projects is what
// env:///NAME reads, writes land on the dispatching Worker's own layer, and a value has no lines.
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parsePath } from "@plurnk/plurnk-parser";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { ownWorker } from "./_approval.ts";
import { insertWorker, openMigrated } from "./_db.ts";
import { copyStmt, editStmt, findStmt, killStmt, readStmt, regex } from "./_dsl.ts";
import { modelOperation } from "./_workers.ts";

const PROBLEMS = "https://problems.plurnk.xyz";
const env = (name: string) => parsePath(`env:///${name}`)!;

test("{§env-scheme} every effective name reads at env:///NAME; EDIT and KILL act on the Worker's own layer", async (t) => {
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
    const alice = await insertWorker(db, workspaceId, null, "alice", "model");
    await ownWorker(db, workspaceId, alice);
    const bob = await insertWorker(db, workspaceId, null, "bob", "model");
    await ownWorker(db, workspaceId, bob);
    await daemon.invokeModuleAction("workspace.env.add", { alias: "TEAM_DEFAULT", definition: { value: "shared" } }, { scope: "workspace", workspaceId });

    // Each worker's own operation: an env:/// address is the dispatching Worker's registry ({§env-scheme}).
    const as = (workerId: number) => (statement: PlurnkStatement) => modelOperation(daemon, db, { workspaceId, workerId, statement });
    const dispatch = as(alice);
    const content = async (workerId: number, name: string): Promise<string | number> => {
        const result = await as(workerId)(readStmt(env(name)));
        return result.status === 200 ? String(result.content) : result.status;
    };
    const state = async (workerId: number, alias: string): Promise<string | undefined> => {
        const listed = await daemon.invokeModuleAction("worker.env.list", {}, { scope: "worker", workspaceId, workerId }) as FunctionalityListResult;
        const definition = listed.definitions.find((entry) => entry.alias === alias);
        return definition === undefined ? undefined : `${definition.origin}:${definition.state}`;
    };
    const find = async (path: string, matcher: ReturnType<typeof regex> | null = null): Promise<string[]> => {
        const result = await dispatch({ ...findStmt(parsePath(path), matcher), lineMarker: { marks: [1, -1] } });
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.ok(Array.isArray(result.results));
        return (result.results.flat() as Array<{ path: string }>).map(({ path }) => path);
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
    const copied = await dispatch(copyStmt(env("TEAM_DEFAULT"), parsePath("worker:///value.txt")!));
    assert.equal(copied.status, 201, JSON.stringify(copied));
    assert.equal(String((await dispatch(readStmt(parsePath("worker:///value.txt")))).content).trimEnd(), "shared");

    // EDIT sets a Worker's own value: a new name, and an override of an inherited one, for alice alone.
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/target"))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/target");
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), "worker:active");
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/replaced"))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/replaced", "EDIT replaces an already-local value");
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), ""))).status, 200);
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 204, "an empty value reads as an empty resource");
    const emptyValue = await daemon.invokeModuleAction("worker.env.list", {}, { scope: "worker", workspaceId, workerId: alice }) as FunctionalityListResult;
    assert.deepEqual(emptyValue.definitions.find(({ alias }) => alias === "CARGO_TARGET_DIR")?.definition, { value: "" });
    await daemon.invokeModuleAction("worker.env.disable", { alias: "CARGO_TARGET_DIR" }, { scope: "worker", workspaceId, workerId: alice });
    assert.equal((await dispatch(editStmt(env("CARGO_TARGET_DIR"), "/tmp/offline"))).status, 200);
    assert.equal(await state(alice, "CARGO_TARGET_DIR"), "worker:disabled", "replacement does not enable a disabled definition");
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), 404);
    await daemon.invokeModuleAction("worker.env.enable", { alias: "CARGO_TARGET_DIR" }, { scope: "worker", workspaceId, workerId: alice });
    assert.equal(await content(alice, "CARGO_TARGET_DIR"), "/tmp/offline");
    assert.equal(await content(bob, "CARGO_TARGET_DIR"), 404, "a sibling sees nothing of alice's layer");
    assert.equal((await dispatch(editStmt(env("ENV_WITNESS"), "mine"))).status, 200);
    assert.equal(await content(alice, "ENV_WITNESS"), "mine");
    assert.equal(await state(alice, "ENV_WITNESS"), "worker:active");
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
