import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import Dsl from "./dsl.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import SeamSocket from "./_seam.ts";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import { rpcCall, subscribeNotifications, connect, withDaemon, waitFor, runLoopToTerminal, rpcProblem } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { insertWorkspace, insertSession, insertLoop, insertTurn, openMigrated } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { namedModelSession } from "./_sessions.ts";
import { Validator, type PlurnkStatement, type ProblemDetails } from "@plurnk/plurnk-contracts";
import { type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { Mock } from "@plurnk/plurnk-providers";
import { type Db } from "../../src/core/Db.ts";


describe("Daemon.workspace-and-seam", () => {
const rejectedProblem = async (run: () => unknown): Promise<ProblemDetails> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof OperationFailureError);
        return error.result.problem;
    }
    assert.fail("Expected operation failure.");
};


test("{§methods-workspace-create} workspace.create returns id+name, mints no session, and emits notification", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "workspace/created");
            const response = await rpcCall(ws, 1, "workspace.create", { name: "alpha" });
            const result = response.result as { id: number; name: string };
            assert.equal(result.name, "alpha");
            assert.ok(result.id > 0);
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.id, result.id);
            assert.equal(params.name, "alpha");

            const workspaceList = await db.test_list_workspaces.all<{ name: string }>();
            assert.ok(workspaceList.some((s) => s.name === "alpha"));
            assert.deepEqual(await daemon.listSessions(result.id), [], "creating a workspace mints no session");
        } finally { ws.close(); }
    });
});

test("{§execution-output-identity} workspace.create with no name auto-generates a unique name", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create");
            const result = response.result as { id: number; name: string };
            assert.match(result.name, /^[0-9A-Za-z]{5}$/, "{§execution-output-identity}: five anchor-alphabet characters, no prefix");
            assert.match(result.name, /[A-Za-z]/u, "{§execution-output-identity}: a generated name is not a decimal ID");
        } finally { ws.close(); }
    });
});

test("{§execution-output-identity} workspace.create with a project root and no name is named after the root and selects that workspace next time", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "project-"));
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        const ws = await connect(addr);
        try {
            const first = (await rpcCall(ws, 1, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.equal(first.name, `~/${basename(inside)}`, "the root's path with the daemon's home abbreviated to ~");
            const again = (await rpcCall(ws, 2, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.equal(again.id, first.id, "a second default launch on the same project selects the same workspace");
            const [pair] = await Promise.all([
                daemon.createWorkspace({ projectRoot: inside }),
                daemon.createWorkspace({ projectRoot: inside }),
            ].map((p) => p.then(({ workspaceId }) => workspaceId)));
            assert.equal(pair, first.id, "a concurrent pair resolves to the one workspace");
            assert.equal((await daemon.listWorkspaces()).filter(({ name }) => name === first.name).length, 1, "no second workspace of that name");
            const far = (await rpcCall(ws, 3, "workspace.create", { projectRoot: outside })).result as { name: string };
            assert.equal(far.name, outside, "outside the home the name is the absolute path");
            await assert.rejects(daemon.createWorkspace({ name: first.name, projectRoot: inside }), (error: unknown) =>
                error instanceof OperationFailureError && (error.result.problem?.type ?? "").endsWith("name-conflict"), "an explicit name that exists is a conflict, never a selection");
            // The default is a convention, not a mapping: a renamed workspace is not re-selected by its old default.
            await daemon.renameWorkspace(first.id, "renamed-workspace");
            const fresh = (await rpcCall(ws, 4, "workspace.create", { projectRoot: inside })).result as { id: number; name: string };
            assert.notEqual(fresh.id, first.id);
            assert.equal(fresh.name, first.name);
        } finally {
            ws.close();
            await rm(inside, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("{§methods-workspace-create} read-only selection uses exactly the ID, literal name or folder-derived default and creates nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const projectRoot = join(new HostPaths().home, "read-only-selection");
        const folder = await daemon.createWorkspace({ projectRoot });
        const literal = await daemon.createWorkspace({ name: `${folder.workspaceId}#user` });
        const before = await daemon.listWorkspaces();
        const events: string[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method) => { events.push(method); });
        try {
            assert.equal((await daemon.attachWorkspace({ workspaceId: folder.workspaceId })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ name: folder.workspaceName })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ projectRoot })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ projectRoot: `${projectRoot}/../read-only-selection/.` })).workspaceId, folder.workspaceId);
            assert.equal((await daemon.attachWorkspace({ name: literal.workspaceName })).workspaceId, literal.workspaceId);
            for (const selection of [{ workspaceId: 999999 }, { name: "absent" }, { projectRoot: `${projectRoot}-absent` }]) {
                await assert.rejects(daemon.attachWorkspace(selection), (error: unknown) =>
                    error instanceof OperationFailureError && error.result.status === 404 && (error.result.problem?.type ?? "").endsWith("workspace-not-found"));
            }
            assert.deepEqual(await daemon.listWorkspaces(), before);
            assert.deepEqual(await daemon.listSessions(folder.workspaceId), []);
            assert.deepEqual(await daemon.listSessions(literal.workspaceId), []);
            assert.deepEqual(events, [], "selection emits no creation or activation events");
            await daemon.renameWorkspace(folder.workspaceId, "renamed-selection");
            await assert.rejects(daemon.attachWorkspace({ projectRoot }), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 404 && (error.result.problem?.type ?? "").endsWith("workspace-not-found"),
                "a stored project folder does not become a second lookup identity after rename");
            assert.equal((await daemon.attachWorkspace({ name: "renamed-selection" })).workspaceId, folder.workspaceId);
        } finally { unsubscribe(); }
    });
});

test("{§methods-workspace-create} selection rejects ambiguous, empty and invalid inputs without creating anything", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const cases = [
            [{}, "identity-invalid"],
            [{ workspaceId: 1, name: "a" }, "identity-invalid"],
            [{ name: "a", projectRoot: "/a" }, "identity-invalid"],
            [{ workspaceId: 1, projectRoot: "/a" }, "identity-invalid"],
            [{ workspaceId: 0 }, "identifier-invalid"],
            [{ name: "" }, "name-invalid"],
            [{ projectRoot: null }, "identity-invalid"],
            [{ projectRoot: "relative" }, "project-root-not-absolute"],
        ] as const;
        for (const [selection, code] of cases) {
            await assert.rejects(daemon.attachWorkspace(selection as Parameters<ApplicationPort["attachWorkspace"]>[0]), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 400 &&  error.result.problem?.type.endsWith(`/${code}`),
                JSON.stringify(selection));
        }
        assert.deepEqual(await daemon.listWorkspaces(), []);
    });
});

test("{§execution-output-identity} every envelope, row and created notice carries the folder's label beside it: a default name equals it, any other name leaves it be", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "label ü √ "));
        const outside = await mkdtemp(join(tmpdir(), "plurnk-label-"));
        const created: Array<{ name?: unknown; projectRoot?: unknown; projectLabel?: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => { if (method === "workspace/created") created.push(params as never); });
        try {
            const named = await daemon.createWorkspace({ projectRoot: inside });
            const label = `~/${basename(inside)}`;
            assert.deepEqual([named.workspaceName, named.projectRoot, named.projectLabel], [label, inside, label], "a default name is its folder's label");
            const listed = (await daemon.listWorkspaces()).find(({ id }) => id === named.workspaceId);
            assert.equal(listed?.project_label, label);
            assert.equal(listed?.name, listed?.project_label, "a client compares name and label by equality");
            assert.deepEqual(created.at(-1), { id: named.workspaceId, name: label, projectRoot: inside, projectLabel: label });

            const explicit = await daemon.createWorkspace({ name: "explicit", projectRoot: inside });
            assert.deepEqual([explicit.workspaceName, explicit.projectLabel], ["explicit", label], "an explicit name is kept; the label comes from the folder alone");
            await daemon.renameWorkspace(named.workspaceId, "renamed");
            const attached = await daemon.attachWorkspace({ workspaceId: named.workspaceId });
            assert.deepEqual([attached.workspaceName, attached.projectLabel], ["renamed", label], "renaming changes no label");

            const far = await daemon.createWorkspace({ projectRoot: outside });
            assert.deepEqual([far.workspaceName, far.projectLabel], [outside, outside], "outside the home the label is the absolute spelling");
            const headless = await daemon.createWorkspace({ name: "no-folder" });
            assert.equal(headless.projectLabel, null);
            assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId)?.project_label, null, "no folder, no invented label");
        } finally {
            unsubscribe();
            await rm(inside, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });
});

test("{§execution-output-identity} {§notifications} a folderless workspace is created, listed, renamed and attached with its folder null throughout; a rename collision changes nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const renames: Array<[number | null, unknown]> = [];
        const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => { if (method === "workspace/renamed") renames.push([workspaceId, params]); });
        const headless = await daemon.createWorkspace({ name: "headless" });
        assert.equal(headless.projectRoot, null);
        const other = await daemon.createWorkspace({ name: "other" });
        const listed = (await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId);
        assert.equal(listed?.project_root, null, "listed without a folder");
        await assert.rejects(daemon.renameWorkspace(headless.workspaceId, "other"), (error: unknown) =>
            error instanceof OperationFailureError && (error.result.problem?.type ?? "").endsWith("name-conflict"));
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === headless.workspaceId)?.name, "headless", "a collision renames nothing");
        assert.deepEqual(renames, [], "a refused rename announces nothing");
        const renamed = await daemon.renameWorkspace(headless.workspaceId, "headless-2");
        assert.equal(renamed.name, "headless-2");
        unsubscribe();
        assert.deepEqual(renames, [[headless.workspaceId, { id: headless.workspaceId, name: "headless-2" }]], "a rename is announced once, in its workspace");
        const attached = await daemon.attachWorkspace({ workspaceId: headless.workspaceId });
        assert.equal(attached.workspaceName, "headless-2");
        assert.equal(attached.projectRoot, null, "renaming leaves the folder null");
        assert.notEqual(other.workspaceId, headless.workspaceId);
    });
});

// {§execution-output-identity} — the admission matrix: every refused spelling at creation and at rename, every
// retained spelling by exact identity, the default derivation, and a workspace that predates the rule.
const REFUSED_SEGMENTS: ReadonlyArray<readonly [name: string, segment: string]> = [
    [".", "."], ["..", ".."], ["a/../b", ".."], ["a/./b", "."], ["../x", ".."], ["x/..", ".."], ["./x", "."], ["x/.", "."],
    ["~/ptl/../etc", ".."], ["/abs/./path", "."],
];
const ILL_FORMED = [String.fromCharCode(0xd800), `lead${String.fromCharCode(0xdc00)}`, `mid${String.fromCharCode(0xd83d)}tail`];
const RETAINED = [
    "~/ptl/project", "/abs/path", "plain", "with space", "ünïcödé/名前", "😀/emoji", "a@b", "100%", "100%25", "%2E%2E", "a/%2E%2E/b", "%2F",
    ".config", "file.txt", "...", "a/.../b", "..x", "x..", ".x/y.", "q?x=1#frag", "back\\slash", "trailing/", "/", "a//b", "~", "a~b",
    "~/123", "/123", "123/project", "123#alice", "1.5", "1e3", "0x10", "-1", "+1", "１２３", " 123", "123 ",
];
const nameInvalid = (detail: RegExp) => (error: unknown): boolean =>
    error instanceof OperationFailureError && error.result.status === 400
    && (error.result.problem?.type ?? "").endsWith("/daemon/input/name-invalid") && detail.test(error.result.problem?.detail ?? "");

test("{§execution-output-identity} decimal ID spellings are refused at creation and rename without changing state", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const standing = await daemon.createWorkspace({ name: "standing" });
        for (const name of ["0", "1", "42", "00", "0042", "9007199254740993", "9".repeat(100)]) {
            const refusal = nameInvalid(/^name consists only of ASCII decimal digits, reserved for workspace IDs\.$/u);
            await assert.rejects(daemon.createWorkspace({ name }), refusal, `create ${name}`);
            await assert.rejects(daemon.renameWorkspace(standing.workspaceId, name), refusal, `rename to ${name}`);
        }
        assert.deepEqual((await daemon.listWorkspaces()).map(({ id, name }) => ({ id, name })), [
            { id: standing.workspaceId, name: "standing" },
        ]);
    });
});

test("{§execution-output-identity} a numeric folder basename produces a path name, retaining folder-default selection", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-numeric-folder-"));
        try {
            const projectRoot = join(root, "123");
            const created = await daemon.createWorkspace({ projectRoot });
            assert.equal(created.workspaceName, new HostPaths().abbreviateUserPath(projectRoot));
            assert.equal(created.projectRoot, projectRoot);
            assert.equal((await daemon.createWorkspace({ projectRoot })).workspaceId, created.workspaceId);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});

test("{§execution-output-identity} an existing numeric name remains listed, attachable and renameable without changing identity", async () => {
    await withDaemon(null, async (db, daemon) => {
        const workspaceId = await insertWorkspace(db, "42");
        const { sessionId } = await daemon.createSession({ workspaceId, name: "alice" });
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === workspaceId)?.name, "42");
        assert.equal((await daemon.attachWorkspace({ workspaceId })).workspaceName, "42");
        assert.equal((await daemon.attachWorkspace({ name: "42" })).workspaceId, workspaceId,
            "lookup preserves an existing label even when that spelling is no longer admitted for creation");
        await assert.rejects(daemon.renameWorkspace(workspaceId, "0042"), nameInvalid(/reserved for workspace IDs/u));
        assert.deepEqual(await daemon.renameWorkspace(workspaceId, "renamed"), { id: workspaceId, name: "renamed" });
        const attached = await daemon.attachWorkspace({ workspaceId });
        assert.deepEqual([attached.workspaceId, attached.workspaceName, attached.projectRoot], [workspaceId, "renamed", null]);
        assert.ok((await daemon.listSessions(workspaceId)).some(({ id, name }) => id === sessionId && name === "alice"));
    });
});

test("{§execution-output-identity} creation and rename refuse a '.' or '..' segment and ill-formed Unicode as name-invalid; a refusal creates and renames nothing", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const standing = await daemon.createWorkspace({ name: "standing" });
        for (const [name, segment] of REFUSED_SEGMENTS) {
            const refusal = nameInvalid(new RegExp(`^name '.*' has the path segment '${segment.replaceAll(".", "\\.")}'\\.$`, "u"));
            await assert.rejects(daemon.createWorkspace({ name }), refusal, `create ${JSON.stringify(name)}`);
            await assert.rejects(daemon.renameWorkspace(standing.workspaceId, name), refusal, `rename to ${JSON.stringify(name)}`);
        }
        for (const name of ILL_FORMED) {
            const refusal = nameInvalid(/^name is not well-formed Unicode: it holds an unpaired surrogate\.$/u);
            await assert.rejects(daemon.createWorkspace({ name }), refusal, "create with an unpaired surrogate");
            await assert.rejects(daemon.renameWorkspace(standing.workspaceId, name), refusal, "rename to an unpaired surrogate");
        }
        assert.deepEqual((await daemon.listWorkspaces()).map(({ id, name }) => ({ id, name })), [{ id: standing.workspaceId, name: "standing" }],
            "no refused creation made a workspace, and no refused rename changed the name");
        const refused = await daemon.createWorkspace({ name: "a/../b" }).catch((error: unknown) => error);
        assert.ok(refused instanceof OperationFailureError);
        assert.equal(refused.result.problem?.recovery, "Provide a name with no '.' or '..' between its slashes; a dot within a segment is ordinary.");
        assert.equal(refused.result.problem?.segment, "..");
        assert.equal(refused.result.problem?.retryable, false);
    });
});

test("{§execution-output-identity} every other spelling is admitted as written at creation and at rename: no repair, no decoding, no collapse", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const created = new Map<number, string>();
        for (const name of RETAINED) {
            const workspace = await daemon.createWorkspace({ name });
            assert.equal(workspace.workspaceName, name, `create keeps ${JSON.stringify(name)} exactly`);
            created.set(workspace.workspaceId, name);
        }
        const listed = new Map((await daemon.listWorkspaces()).map(({ id, name }) => [id, name]));
        assert.deepEqual([...listed.entries()].toSorted(([a], [b]) => a - b), [...created.entries()].toSorted(([a], [b]) => a - b),
            "each name is stored as written and none collapsed into another");
        assert.equal(new Set(RETAINED).size, listed.size, "a literal %2E%2E, %2F and 100%25 stay distinct from what they would decode to");
        const carrier = await daemon.createWorkspace({ name: "carrier" });
        for (const name of RETAINED) {
            const target = `renamed ${name}`;
            assert.equal((await daemon.renameWorkspace(carrier.workspaceId, target)).name, target, `rename keeps ${JSON.stringify(target)} exactly`);
        }
    });
});

test("{§execution-output-identity} a root spelled with '.' or '..' derives the name of the folder it reaches; an ill-formed root is project-root-invalid", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const home = new HostPaths().home;
        const inside = await mkdtemp(join(home, "dotted-"));
        try {
            const plain = await daemon.createWorkspace({ projectRoot: inside });
            assert.equal(plain.workspaceName, `~/${basename(inside)}`);
            for (const spelling of [`${inside}/.`, `${inside}/sub/..`, `${home}/./${basename(inside)}`, `${inside}/../${basename(inside)}`]) {
                const selected = await daemon.createWorkspace({ projectRoot: spelling });
                assert.equal(selected.workspaceId, plain.workspaceId, `${spelling} selects the folder's workspace`);
                assert.equal(selected.workspaceName, plain.workspaceName, "and no dot segment reaches the name");
            }
            await assert.rejects(daemon.createWorkspace({ projectRoot: `${inside}/${String.fromCharCode(0xd800)}` }), (error: unknown) =>
                error instanceof OperationFailureError && error.result.status === 400
                && (error.result.problem?.type ?? "").endsWith("/project-root-invalid")
                && error.result.problem?.detail === "projectRoot is not well-formed Unicode: it holds an unpaired surrogate.");
            assert.equal((await daemon.listWorkspaces()).length, 1, "the refused root made no workspace");
        } finally { await rm(inside, { recursive: true, force: true }); }
    });
});

test("{§execution-output-identity} a workspace already carrying a refused spelling stays listed and attachable and is renamed like any other, keeping its id, folder and sessions", async () => {
    await withDaemon(null, async (db, daemon) => {
        const legacyId = await insertWorkspace(db, "old/../name");
        const { sessionId } = await daemon.createSession({ workspaceId: legacyId, name: "kept" });
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === legacyId)?.name, "old/../name", "enumeration hides nothing");
        const attached = await daemon.attachWorkspace({ workspaceId: legacyId });
        assert.equal(attached.workspaceName, "old/../name", "it is attached under the name it carries");
        await assert.rejects(daemon.renameWorkspace(legacyId, "still/./refused"), nameInvalid(/has the path segment '\.'/u));
        assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === legacyId)?.name, "old/../name", "the refused rename changed nothing");
        const renamed = await daemon.renameWorkspace(legacyId, "old/name");
        assert.deepEqual(renamed, { id: legacyId, name: "old/name" }, "the same workspace under an admitted name");
        const after = await daemon.attachWorkspace({ workspaceId: legacyId });
        assert.equal(after.projectRoot, attached.projectRoot, "its folder is untouched");
        assert.ok((await daemon.listSessions(legacyId)).some(({ id }) => id === sessionId), "its sessions are kept");
    });
});

test("{§methods-workspace-create} workspace.create on an already-attached connection re-binds in place (no reject)", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const first = await rpcCall(ws, 1, "workspace.create", { name: "first" });
            const second = await rpcCall(ws, 2, "workspace.create", { name: "second" });
            // {§methods-workspace-create}: re-binding is allowed; the connection switches in place.
            assert.equal(second.error, undefined, "re-create on a bound connection does not reject");
            assert.notEqual((second.result as { id: number }).id, (first.result as { id: number }).id, "switched to a fresh workspace");
        } finally { ws.close(); }
    });
});

test("{§methods} workspace.list returns workspaces most-recent-first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        await db.test_workspaces_insert_name_only.run({ name: "first" });
        await db.test_workspaces_insert_name_only.run({ name: "second" });

        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.list");
            const result = response.result as { workspaces: Array<{ id: number; name: string }> };
            assert.equal(result.workspaces.length, 2);
            const names = result.workspaces.map((s) => s.name).toSorted();
            assert.deepEqual(names, ["first", "second"]);
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} workspace.attach binds to an existing workspace and mints nothing", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const existing = await db.test_insert_workspace.get<{ id: number }>({ name: "existing" });

        const first = await connect(addr);
        const second = await connect(addr);
        try {
            for (const ws of [first, second]) {
                const response = await rpcCall(ws, 1, "workspace.attach", { id: existing?.id });
                const result = response.result as { id: number; name: string };
                assert.equal(result.id, existing?.id);
                assert.equal(result.name, "existing");
            }
            assert.deepEqual(await daemon.listSessions(existing!.id), [], "binding a workspace, from any number of connections, mints no session");
        } finally { first.close(); second.close(); }
    });
});

test("{§methods-workspace-create} workspace.attach to nonexistent workspace returns an exact Problem", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.attach", { id: 9999 });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/workspace/workspace-not-found");
            assert.equal(problem.status, 404);
            assert.equal(problem.workspaceId, 9999);
        } finally { ws.close(); }
    });
});

test("{§methods} providers.list returns parsed aliases with active marker", async () => {
    await withDaemon(new Mock({ contextWindow: 8192, responses: [] }), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const original = { ...process.env };
            try {
                process.env.PLURNK_MODEL_gemma = "openai/macher.gguf";
                process.env.PLURNK_MODEL_opus = "openrouter/anthropic/claude-opus";
                process.env.PLURNK_MODEL = "gemma";
                const response = await rpcCall(ws, 1, "providers.list");
                const result = response.result as {
                    aliases: Array<{ alias: string; provider: string; model: string; active: boolean; inputCapacity: number | null }>;
                };
                const gemma = result.aliases.find((a) => a.alias === "gemma");
                const opus = result.aliases.find((a) => a.alias === "opus");
                assert.ok(gemma !== undefined && opus !== undefined);
                assert.equal(gemma?.provider, "openai");
                assert.equal(gemma?.model, "macher.gguf");
                assert.equal(gemma?.active, true);
                assert.equal(opus?.active, false);
                const capacity = 8192 - Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
                assert.equal(gemma?.inputCapacity, capacity, "the active alias carries provider-derived input capacity");
                assert.equal(opus?.inputCapacity, null, "an inactive alias has no instantiated capacity");
            } finally {
                // Restore env so other tests aren't polluted.
                for (const k of Object.keys(process.env)) {
                    if (!(k in original)) delete process.env[k];
                }
                Object.assign(process.env, original);
            }
        } finally { ws.close(); }
    });
});
test("{§application-session-observation} workspace.sessions lists sessions in the workspace, most-recent first", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const workspace = await db.test_insert_workspace.get<{ id: number }>({ name: "list-sessions" });
        await db.test_sessions_insert.run({ workspace_id: workspace?.id, name: "first" });
        await db.test_sessions_insert.run({ workspace_id: workspace?.id, name: "second" });
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.sessions", { id: workspace?.id });
            const result = response.result as { sessions: Array<{ id: number; name: string; kind: string; lifecycle: string }> };
            assert.equal(result.sessions.length, 2);
            assert.deepEqual(result.sessions.map((r) => r.name).toSorted(), ["first", "second"]);
            // {§application-session-observation} — a session with no parent and no loop is an idle root (#523).
            assert.deepEqual(result.sessions.map((r) => [r.kind, r.lifecycle]), [["root", "idle"], ["root", "idle"]]);
        } finally { ws.close(); }
    });
});

test("{§notifications} workspace/created notification broadcasts to other connected clients", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const observer = await connect(addr);
        const creator = await connect(addr);
        try {
            const observerNotifs = subscribeNotifications(observer, "workspace/created");

            await rpcCall(creator, 1, "workspace.create", { name: "broadcast-test" });

            const captured = observerNotifs();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string };
            assert.equal(params.name, "broadcast-test");
        } finally { observer.close(); creator.close(); }
    });
});
test("{§methods} the client-interface seam — subscribeToEvents delivers workspace-scoped engine events in-process", async () => {
    // The emit half of #broadcast, exposed as an in-process source: a transport module (plurnk-acp)
    // subscribes here and owns its client fan-out; core has no transport connections.
    await withDaemon(null, async (_db, daemon, addr) => {
        const received: Array<{ workspaceId: number | null; method: string; params: unknown }> = [];
        const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => { received.push({ workspaceId, method, params }); });
        const ws = await connect(addr);
        try {
            const s = ((await rpcCall(ws, 1, "workspace.create", { name: "seam" })).result as { id: number }).id;
            const isCreated = (e: { method: string; params: unknown }): boolean => e.method === "workspace/created" && (e.params as { id?: number }).id === s;
            await waitFor(() => received, (r) => r.some(isCreated), { timeoutMs: 4000 });
            assert.ok(received.some(isCreated), "the in-process subscriber received the engine event without core owning transport fan-out");
            unsubscribe();
            const countAfter = received.length;
            await rpcCall(ws, 2, "workspace.create", { name: "seam-2" });
            assert.equal(received.length, countAfter, "unsubscribe stops delivery — the seam is a clean subscription");
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam does not manufacture a resolver from an ownerless durable row", async () => {
    await withDaemon(null, async (db, daemon, _addr) => {
        const workspaceId = await insertWorkspace(db, `prop-seam-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const row = await db.engine_insert_log_entry.get<{ id: number }>({
            session_id: sessionId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "model", source: null, model_call_id: null, op: "EDIT",
            scheme: "workspace", username: null, password: null, hostname: null, port: null,
            pathname: "/x", query: null, fragment: null, lineMarker: null,
            tx: "````EDIT (workspace:///x)\nbody\n````", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ status: 202 }), mimetype_rx: "application/json",
            status_rx: 202, weight: 0, state: "proposed", outcome: null, attrs: "{}",
        });
        assert.ok(row !== undefined);
        const pending = await daemon.pendingProposals(workspaceId);
        assert.deepEqual(pending, [], "persistence without this process's lifecycle owner is not a stopped world");
        const problem = await rejectedProblem(() => daemon.resolveProposal(row.id, { decision: "accept" }, { workspaceId, address: TEST_OWNER }));
        assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending");
        assert.equal(problem.status, 409);
        assert.equal(problem.logEntryId, row.id);
    });
});

test("{§tokenomics} the client-interface seam — runLoop drives a loop end to end on the daemon's own provider + law", async () => {
    // The loop-control hook: the module supplies only workspace/session/prompt; runLoop fills in the provider
    // and the law-file system prompt (core's), fires the drain via the unified inject, and returns. The
    // outcome arrives on the event source, not a socket. `cancelDrain` (already public) is the cancel hook.
    // A window that comfortably holds the packet: this test drives a loop to CONCLUSION and asserts
    // 200, so the full system prompt (law/definition) + the materialized docs must fit the prompt
    // budget. This test verifies the seam path, not small-window viability
    // ({§tokenomics}).
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\ndone\n````", 50),
        makeMockResponse("````SEND [200]\ndone again\n````", 50),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-runloop" })).result as { id: number };
            const events: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

            assert.deepEqual(
                await db.test_entries_by_scheme_prefix.all({ workspace_id: created.id, scheme: "plurnk", prefix: "/%" }),
                [],
                "workspace creation remains passive until real work arrives",
            );
            assert.equal(
                daemon.workspaceDerivationStatus(created.id),
                null,
                "workspace creation does not launch semantic derivation",
            );

            // {§machine-processes} — loops run in a model session; the runtime actor, where a person's client
            // operations journal ({§connection-lifecycle}), is refused loudly as a loop home.
            const runtimeSessionId = await daemon.ensureRuntimeSession(created.id);
            const runtimeProblem = await rejectedProblem(() => daemon.runLoop({
                workspaceId: created.id,
                sessionId: runtimeSessionId,
                prompt: "go",
            }));
            assert.equal(runtimeProblem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(runtimeProblem.status, 409);
            assert.equal(runtimeProblem.sessionId, runtimeSessionId);
            // {§session-model-selection} — the model, reasoning, and spawn-model controls are model-session
            // surfaces: the runtime actor is refused before any policy row is initialized.
            for (const [surface, call] of [
                ["session.model.get", () => daemon.readSessionModel({ workspaceId: created.id, sessionId: runtimeSessionId })],
                ["session.model.set", () => daemon.setSessionModel({ workspaceId: created.id, sessionId: runtimeSessionId, selector: "mock/mocktest" })],
                ["session.effort.get", () => daemon.readSessionEffort({ workspaceId: created.id, sessionId: runtimeSessionId })],
                ["session.effort.set", () => daemon.setSessionEffort({ workspaceId: created.id, sessionId: runtimeSessionId, effort: "low" })],
                ["session.child.set", () => daemon.setSessionSpawnModel({ workspaceId: created.id, sessionId: runtimeSessionId, selector: null })],
            ] as const) {
                const refused = await rejectedProblem(call);
                assert.equal(refused.type, "https://problems.plurnk.xyz/daemon/session/model-session-required", `${surface} refuses a non-model session`);
                assert.equal(refused.status, 409);
            }
            const modelSessionId = await namedModelSession(daemon, created.id, "main");
            const res = await daemon.runLoop({ workspaceId: created.id, sessionId: modelSessionId, prompt: "go" });
            assert.equal(res.action, "enqueued_new_loop", "runLoop enqueued a fresh loop");
            assert.ok(res.loopId > 0, "runLoop returned the new loop id");

            const terminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === res.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((terminals[0].params as { result: { status: number } }).result.status, 200, "the loop runLoop started ran to conclusion (200) — driven and observed through the seam, no socket");

            // The first-turn feature holds on the seam path: Functionality activation materialized
            // the teaching skills into the model session before packet assembly.
            const docs = await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: created.id, scheme: "plurnk", prefix: "/%" });
            assert.ok(docs.length > 0);
            const docEdits = (await db.test_log_entries_by_session_op_full.all<{
                tx: string;
                origin: string;
            }>({ session_id: runtimeSessionId, op: "EDIT" })).filter(({ origin }) => origin === "_plurnk");
            assert.ok(docEdits.length > 0, "documentation publication dispatches structural EDIT statements");
            for (const { tx } of docEdits) {
                const statement = JSON.parse(tx) as unknown;
                assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
                const position = (statement as { position?: { line?: number; column?: number } }).position;
                assert.equal(position?.column, 0);
                assert.ok((position?.line ?? 0) > 0, "generated EDIT carries its honest position in the admitted turnOps source");
            }
            const publicationRows = async () => (await db.test_log_entries_by_session.all<{
                op: string;
                scheme: string | null;
                pathname: string | null;
                status_rx: number;
                origin: string;
            }>({ session_id: runtimeSessionId })).filter(({ origin, scheme }) =>
                origin === "_plurnk" && (scheme === "plurnk" || scheme === "mcp"));
            const publishedCount = (await publicationRows()).length;

            const second = await daemon.runLoop({ workspaceId: created.id, sessionId: modelSessionId, prompt: "go again" });
            const secondTerminals = await waitFor(
                () => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === second.loopId),
                (ts) => ts.length > 0,
                { timeoutMs: 8000 },
            );
            assert.equal((secondTerminals[0].params as { result: { status: number } }).result.status, 200, "reattaching to the workspace runs normally");

            const afterTwoLoops = await publicationRows();
            assert.equal(afterTwoLoops.length, publishedCount, "model loops never repeat unchanged session skills publication");
            assert.equal(afterTwoLoops.filter((row) => row.op === "EDIT" && row.status_rx >= 400).length, 0, "session skills publication produces no error rows");
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam — dispatchClientAction runs a client op through the engine and emits log/entry", async () => {
    // The op keystone: one seam op backs the whole op_* family. The module parses at its edge and hands
    // over the statement; the op is journaled client-origin, dispatched, and the entry emitted on the source.
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-dispatch" })).result as { id: number };
            const entries: Array<{ method: string; params: unknown }> = [];
            daemon.subscribeToEvents((_s, method, params) => { entries.push({ method, params }); });
            const operate = async (statement: PlurnkStatement) =>
                (await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [statement] }))[0];

            // WRITE then READ workspace:///x through the seam — a positive roundtrip proving dispatch + journal.
            const wrote = await operate(Dsl.buildEdit({ target: "workspace:///x", content: "seam" }));
            assert.equal(wrote.status, 201, "the client EDIT created the entry through the seam (201)");
            const read = await operate(Dsl.buildRead({ target: "workspace:///x" }));
            assert.equal(read.status, 200);
            assert.equal(read.content, "seam", "the value roundtripped — the op executed through the engine, not a shadow path");

            const emitted = entries.filter((e) => e.method === "log/entry");
            assert.ok(emitted.length >= 2, "each dispatched client op emitted a log/entry on the event source (acp fans out to its own clients)");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} {§connection-lifecycle} one client operation owns every statement in one loop of the runtime session, attributed to its person", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-action-journal" })).result as { id: number };
            const heard: Array<{ sessionId: number; loopId: number }> = [];
            const order: string[] = [];
            daemon.subscribeToEvents((_s, method) => { if (method === "log/entry") order.push("entry"); });
            const operation = (actor: string, statements: PlurnkStatement[]) => daemon.dispatchClientAction({
                workspaceId: created.id, actor, statements,
                onLoop: (loop) => { heard.push(loop); order.push("loop"); },
            });

            const results = await operation("test://primary", [
                Dsl.buildEdit({ target: "workspace:///x", content: "one action" }),
                Dsl.buildRead({ target: "workspace:///x" }),
            ]);
            assert.deepEqual(results.map((result) => result.status), [201, 200]);
            assert.equal(heard.length, 1, "the operation announced exactly one loop");
            assert.deepEqual(order, ["loop", "entry", "entry"], "the loop is announced before any statement runs");
            const [{ sessionId, loopId }] = heard;
            const runtime = await daemon.readSession({ workspaceId: created.id, identity: { id: sessionId } });
            assert.equal(runtime?.origin, "_plurnk", "the operation journals in the workspace's runtime session");
            assert.equal(runtime?.name, "_plurnk");

            const turns = await db.test_list_turns_in_loop.all<{ sequence: number; producer: string; kind: string }>({ loop_id: loopId });
            assert.deepEqual(
                turns.map(({ sequence, producer, kind }) => [sequence, producer, kind]),
                [[1, "client", "operation"], [2, "client", "operation"]],
                "each statement is a distinct ordered client operation turn in the one loop",
            );
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 200, "the loop closes 200 when the operation succeeds");
            const rows = (await db.test_log_entries_by_session.all<{ loop_id: number; origin: string; source: string | null }>({ session_id: sessionId }))
                .filter((row) => row.loop_id === loopId);
            assert.equal(rows.length, 2);
            assert.deepEqual(rows.map(({ origin, source }) => [origin, source]), [["client", null], ["client", null]],
                "every row the operation writes is a client-origin act, not an arrival");
            const promptSource = async (id: number) =>
                (await daemon.listSessionLoops({ workspaceId: created.id, sessionId })).find((loop) => loop.id === id)?.promptSource;
            assert.equal(await promptSource(loopId), "test://primary", "the operation's loop names its person");

            // A second person's operation is its own loop in the same runtime session, attributed to that person.
            await operation("test://secondary", [Dsl.buildRead({ target: "workspace:///x" })]);
            assert.equal(heard.length, 2);
            assert.equal(heard[1].sessionId, sessionId, "every person's operation journals in the one runtime session");
            assert.notEqual(heard[1].loopId, loopId, "each operation owns its own loop");
            assert.equal(await promptSource(heard[1].loopId), "test://secondary");
            assert.deepEqual((await daemon.listSessions(created.id)).map(({ origin }) => origin), ["_plurnk"],
                "client operations mint no session beyond the runtime session");
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam — readLog returns a workspace's journal, ownership-verified", async () => {
    // The module's primary render input. Seeded here via the dispatch seam, read back via readLog, and the
    // cross-workspace invariant proven: a workspace reads only its own sessions (core holds it, not the module).
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-read" })).result as { id: number };
            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "workspace:///x", content: "read me" })] });

            const entries = await daemon.readLog({ workspaceId: created.id, sessionId: await daemon.ensureRuntimeSession(created.id) });
            assert.ok(entries.length >= 1, "readLog returned the workspace's journal entries");
            assert.ok(entries.some((e) => e.op === "EDIT"), "the client EDIT is in the journal the seam read");

            const other = (await rpcCall(ws, 2, "workspace.create", { name: "seam-read-other" })).result as { id: number };
            const otherSession = await daemon.ensureRuntimeSession(other.id);
            const problem = await rejectedProblem(() => daemon.readLog({
                workspaceId: created.id,
                sessionId: otherSession,
            }));
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

test("{§methods} the client-interface seam — metadata reads surface providers, workspaces, sessions, and constraints", async () => {
    // The render surface beyond the journal: providers+budget, workspaces, sessions, and the constraint overlay.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-meta" })).result as { id: number };

            // providers + capacity — the active test alias is mocktest, carrying derived input capacity.
            const providers = daemon.listProviders();
            const active = providers.aliases.find((a) => a.active);
            assert.ok(active !== undefined, "listProviders reports the active alias");
            assert.equal(active.alias, "mocktest");
            assert.equal(typeof active.inputCapacity, "number", "the active alias carries resolved input capacity");

            // workspaces + sessions — the created workspace and its model session are present.
            const workspaces = await daemon.listWorkspaces();
            assert.ok(workspaces.some((s) => s.id === created.id), "listWorkspaces includes the created workspace");
            const modelSessionId = await namedModelSession(daemon, created.id, "main");
            const sessions = await daemon.listSessions(created.id);
            assert.deepEqual(sessions.map(({ id }) => id), [modelSessionId], "listSessions returns the workspace's sessions");

            // prompts — a thin delegation; assert the wiring resolves cleanly.
            const prompts = await daemon.listPrompts(created.id);
            assert.ok(Array.isArray(prompts), "listPrompts returns the workspace's prompt history");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} {§methods-workspace-create} the client-interface seam — workspace lifecycle: create/attach/rename", async () => {
    // {§methods-workspace-create}: the module decodes its protocol; core owns semantic validation,
    // the envelope, name invariants, membership, and workspace/created.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, _addr) => {
        const events: Array<{ method: string; params: unknown }> = [];
        daemon.subscribeToEvents((_s, method, params) => { events.push({ method, params }); });

        // create — returns the envelope + emits workspace/created.
        const env = await daemon.createWorkspace({ name: "seam-life" });
        assert.ok(env.workspaceId > 0, "createWorkspace returns the envelope");
        assert.deepEqual(
            Object.keys(env).toSorted(),
            ["projectLabel", "projectRoot", "workspaceId", "workspaceName"],
            "{§methods-workspace-create}: the envelope carries the workspace's identity only",
        );
        assert.ok(events.some((e) => e.method === "workspace/created" && (e.params as { id?: number }).id === env.workspaceId), "workspace/created emitted on the event source");

        const attached = await daemon.attachWorkspace({ workspaceId: env.workspaceId });
        assert.equal(attached.workspaceId, env.workspaceId, "attachWorkspace returns an envelope on the same workspace");
        assert.deepEqual(
            Object.keys(attached).toSorted(),
            ["projectLabel", "projectRoot", "workspaceId", "workspaceName"],
            "{§methods-workspace-create}: attach does not fabricate a bound-session or action-loop binding",
        );
        assert.deepEqual(await daemon.listSessions(env.workspaceId), [], "neither creation nor attachment mints a session");

        // rename — mutations return the applied value; a name collision is refused. (No root
        // mutation on the seam: the workspace pointer is set at workspace.create or never.)
        assert.equal((await daemon.renameWorkspace(env.workspaceId, "seam-life-2")).name, "seam-life-2");
        await daemon.createWorkspace({ name: "seam-life-other" });
        const renameProblem = await rejectedProblem(() =>
            daemon.renameWorkspace(env.workspaceId, "seam-life-other"));
        assert.equal(renameProblem.type, "https://problems.plurnk.xyz/daemon/workspace/name-conflict");
        assert.equal(renameProblem.status, 409);
        assert.equal(renameProblem.name, "seam-life-other");

    });
});

test("{§methods} the client-interface seam — readEntry returns an entry's shape and incremental channel slice", async () => {
    await withDaemon(null, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-entry" })).result as { id: number };
            await daemon.dispatchClientAction({ workspaceId: created.id, actor: TEST_OWNER, statements: [Dsl.buildEdit({ target: "workspace:///x", content: "hello world" })] });
            // A client reads entries from the perspective of a session of its workspace.
            const reader = await namedModelSession(daemon, created.id, "main");

            // full shape — the written content is on one of the entry's channels.
            const entry = (await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///x" })).entry!;
            const found = Object.entries(entry.channels).find(([, c]) => c.content.includes("hello"));
            assert.ok(found !== undefined, "readEntry returns the entry's channels with content");
            const [channel, chan] = found;
            assert.equal(chan.content, "hello world");
            assert.equal(chan.contentLength, 11);

            // {§methods}: an offset returns only that channel's remaining content.
            const sliced = (await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///x", channel, offset: 6 })).entry!;
            assert.equal(sliced.channels[channel].content, "world", "the incremental read returns only the delta from the offset");
            assert.equal(sliced.channels[channel].contentLength, 11, "contentLength is the full length — the next poll resumes from there");

            // a missing entry is 404; an offset without a channel is refused.
            const missing = await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///nope" });
            assert.equal(missing.status, 404);
            assert.ok("problem" in missing);
            assert.equal(missing.problem.type, "https://problems.plurnk.xyz/daemon/entry/entry-not-found");
            assert.equal(missing.problem.target, "workspace:///nope");
            const offset = await daemon.readEntry({ workspaceId: created.id, sessionId: reader, target: "workspace:///x", offset: 3 });
            assert.equal(offset.status, 400);
            assert.ok("problem" in offset);
            assert.equal(offset.problem.type, "https://problems.plurnk.xyz/daemon/entry/offset-channel-required");
            assert.equal(offset.problem.recovery, "Select the channel to read from the offset."); // {§operation-results}

            const networkEntry = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0,
                workspace_id: created.id,
                scheme: "https",
                authority: "example.org:8443",
                pathname: "/x?b=2&a=1&a=3",
            });
            assert.ok(networkEntry !== undefined);
            await db.test_seed_channel_hashed.run({
                entry_id: networkEntry.id,
                name: "body",
                content: "network body",
                mimetype: "text/plain",
                weight: 2,
                content_hash: null,
                state: "static",
            });
            const network = await daemon.readEntry({
                workspaceId: created.id,
                sessionId: reader,
                target: "https://example.org:8443/x?b=2&a=1&a=3#body",
            });
            assert.equal(network.status, 200);
            assert.equal(network.entry?.target, "https://example.org:8443/x?b=2&a=1&a=3");
            assert.equal(network.entry?.channels.body.content, "network body");

            const userinfo = await daemon.readEntry({
                workspaceId: created.id,
                sessionId: reader,
                target: "https://alice:secret@example.org:8443/x?b=2&a=1&a=3",
            });
            assert.equal(userinfo.status, 400);
            assert.ok("problem" in userinfo);
            assert.equal(userinfo.problem.type, "https://problems.plurnk.xyz/daemon/entry/userinfo-not-allowed");
            assert.doesNotMatch(JSON.stringify(userinfo), /alice|secret/);
        } finally { ws.close(); }
    });
});

test("{§application-session-observation} the client-interface seam — forkSession branches a session's log, ownership + name invariants held", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = (await rpcCall(ws, 1, "workspace.create", { name: "seam-fork" })).result as { id: number };
            // A model session with a completed loop to branch.
            const { finalStatus, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "branch me" });
            assert.equal(finalStatus, 200);
            const sourceSession = modelSessionId!;

            const branch = await daemon.forkSession({ workspaceId: created.id, sessionId: sourceSession, name: "My_branch" });
            assert.ok(branch.sessionId > 0 && branch.sessionId !== sourceSession, "forkSession created a new session");
            assert.equal(branch.parentSessionId, sourceSession, "the branch is lineaged to its parent");
            assert.equal(branch.sessionName, "My_branch");
            // {§application-session-observation} — the directory says how it was minted (#523).
            const observed = await daemon.readSession({ workspaceId: created.id, identity: { id: branch.sessionId } });
            assert.equal(observed?.kind, "fork");
            // A fork inherits its parent's loops by snapshot, so its latest loop is the completed one it forked from.
            assert.equal(observed?.lifecycle, "completed");
            const parent = await daemon.readSession({ workspaceId: created.id, identity: { id: sourceSession } });
            assert.equal(parent?.kind, "root");

            // invariants: the runtime actor's name and a foreign session are both refused.
            await assert.rejects(() => daemon.forkSession({ workspaceId: created.id, sessionId: sourceSession, name: "_plurnk" }), /must match \[A-Za-z0-9\]\[A-Za-z0-9_-\]\{0,62\}/);
            const invalidName = await rejectedProblem(() => daemon.forkSession({
                workspaceId: created.id,
                sessionId: sourceSession,
                name: "_invalid",
            }));
            assert.equal(invalidName.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
            assert.equal(invalidName.status, 400);
            assert.equal(invalidName.name, "_invalid");
            assert.equal(invalidName.retryable, false);
            const other = (await rpcCall(ws, 3, "workspace.create", { name: "seam-fork-other" })).result as { id: number };
            const otherSession = await namedModelSession(daemon, other.id, "main");
            const problem = await rejectedProblem(() => daemon.forkSession({
                workspaceId: created.id,
                sessionId: otherSession,
            }));
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
            assert.equal(problem.status, 409);
            assert.equal(problem.actualWorkspaceId, other.id);
        } finally { ws.close(); }
    });
});

});

describe("ApplicationPort.topology", () => {
test("{§notifications} {§application-session-observation} {§methods-workspace-create}{§methods-workspace-create}{§methods-workspace-create}: exterior adapters observe exact topology and durable loop state", async () => {
    const provider = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("````SEND [200]\ncomposed result\n````", 10)],
    });

    await withDaemon(provider, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({
            name: `application-topology-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const contextId = crypto.randomUUID();
        const taskId = crypto.randomUUID();
        const context = await daemon.createSession({
            workspaceId: workspace.workspaceId,
            name: contextId,
        });
        assert.deepEqual(
            await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: taskId } }),
            null,
            "an absent exact lookup is singular and explicit",
        );
        const task = await daemon.forkSession({
            workspaceId: workspace.workspaceId,
            sessionId: context.sessionId,
            name: taskId,
        });
        assert.equal(
            (await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { id: task.sessionId } }))?.name,
            taskId,
        );

        const roots = await daemon.listSessions(workspace.workspaceId, {
            origin: "model",
            parentSessionId: null,
        });
        const projectedContext = roots.find(({ id }) => id === context.sessionId);
        assert.ok(projectedContext);
        assert.deepEqual(projectedContext, {
            id: context.sessionId,
            name: contextId,
            created_at: projectedContext.created_at,
            origin: "model",
            owner: "_plurnk",
            parentSessionId: null,
            // {§application-session-observation} — a root session with no loop yet (#523).
            kind: "root",
            lifecycle: "idle",
            // {§machine-processes} — shown.
            hidden_at: null,
        });
        assert.equal(typeof projectedContext.created_at, "string");
        // {§methods-workspace-create} — an omitted parent filter returns every lineage
        // position; the child is listed beside its root, not hidden behind it.
        const everyPosition = await daemon.listSessions(workspace.workspaceId, { origin: "model" });
        assert.deepEqual(
            everyPosition.map(({ id }) => id).toSorted((left, right) => left - right),
            [context.sessionId, task.sessionId].toSorted((left, right) => left - right),
        );
        assert.ok(
            (await daemon.listSessions(workspace.workspaceId)).some(({ id }) => id === task.sessionId),
            "a query-less listing includes the child",
        );
        const children = await daemon.listSessions(workspace.workspaceId, {
            origin: "model",
            parentSessionId: context.sessionId,
        });
        assert.equal(children.length, 1);
        assert.deepEqual(children[0], {
            id: task.sessionId,
            name: taskId,
            created_at: children[0]?.created_at,
            origin: "model",
            owner: "_plurnk",
            parentSessionId: context.sessionId,
            // forkSession mints a FORK child (fork boundary set); no loop has run on it yet.
            kind: "fork",
            lifecycle: "idle",
            hidden_at: null,
        });

        const terminated: Array<{ loopId: number }> = [];
        const packets: Array<{ sessionId: number; loopId: number; packetCount: number }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number });
            if (method === "loop/packet") packets.push(params as { sessionId: number; loopId: number; packetCount: number });
        });
        try {
            const accepted = await daemon.runLoop({
                workspaceId: workspace.workspaceId,
                sessionId: task.sessionId,
                prompt: "produce the composed result",
                source: `acp://peer/contexts/${contextId}/tasks/${taskId}`,
            });
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId }) => loopId === accepted.loopId),
            );

            const loops = await daemon.listSessionLoops({
                workspaceId: workspace.workspaceId,
                sessionId: task.sessionId,
            });
            const own = loops.find(({ id }) => id === accepted.loopId);
            assert.deepEqual(own, {
                id: accepted.loopId,
                sessionId: task.sessionId,
                sequence: own?.sequence,
                status: 200,
                prompt: "produce the composed result",
                promptSource: `acp://peer/contexts/${contextId}/tasks/${taskId}`,
                claimedAt: own?.claimedAt,
                terminatedAt: own?.terminatedAt,
                terminalResult: {
                    status: 200,
                },
                packetCount: 1,
                waitUntil: null,
                // {§loop-completion} A peer's task is no session's operation.
                invocation: null,
            });
            assert.equal(typeof own?.terminatedAt, "string");
            assert.equal(typeof own?.claimedAt, "string");
            assert.ok(Date.parse(own.claimedAt!) <= Date.parse(own.terminatedAt!), "a loop first runs before it concludes");
            const messages = await daemon.readMessages({ workspaceId: workspace.workspaceId, sessionId: task.sessionId });
            assert.deepEqual(messages.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["composed result"]);
            assert.deepEqual(packets.map(({ sessionId, loopId, packetCount }) => ({ sessionId, loopId, packetCount })),
                [{ sessionId: task.sessionId, loopId: accepted.loopId, packetCount: 1 }], "packet chronology broadcasts once when inference evidence becomes durable");
        } finally {
            unsubscribe();
        }
    });
});

test("{§methods-workspace-create} {§session-scheme}: an exact read resolves every name a listing returns, the runtime session's included", async () => {
    await withDaemon(new Mock({ contextWindow: 16_384, responses: [] }), async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `session-read-${crypto.randomUUID()}`, projectRoot: null });
        const runtimeId = await RuntimeSession.ensure(db, workspace.workspaceId);
        const listed = (await daemon.listSessions(workspace.workspaceId)).find(({ id }) => id === runtimeId);
        assert.ok(listed !== undefined, "the listing returns the runtime session");
        const byName = await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: listed.name } });
        assert.deepEqual(byName, await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { id: runtimeId } }),
            "the listed name resolves the listed session: a lookup is no minting door");
        assert.equal(byName?.origin, "_plurnk", "and the reader sees what it is, so it can refuse to bind it");
        assert.equal(await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: "_absent" } }), null,
            "a name no session carries is absent, not malformed");
    });
});
});


describe("Daemon.workspace", () => {
interface RpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
}

const wsRpcCall = (ws: SeamSocket, id: number, method: string, params?: object): Promise<RpcResponse> =>
    new Promise((resolve, reject) => {
        const onMessage = (data: Buffer | string) => {
            const text = typeof data === "string" ? data : data.toString("utf8");
            const parsed = JSON.parse(text) as RpcResponse;
            if (parsed.id === id) { ws.off("message", onMessage); resolve(parsed); }
        };
        ws.on("message", onMessage);
        ws.on("error", reject);
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });

// The integration harness calls the in-process seam. {§rpc}
const withWsDaemon = async <T>(fn: (db: Db, addr: { daemon: Daemon }) => Promise<T>): Promise<T> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    await daemon.start();
    try { return await fn(db, { daemon }); }
    finally { await daemon.stop(); await db.close(); }
};

const wsConnect = (addr: { daemon: Daemon }): Promise<SeamSocket> => Promise.resolve(new SeamSocket(addr.daemon));

test("{§methods-workspace-create}: a bound connection switches workspaces without reconnecting", async () => {
    await withWsDaemon(async (_db, addr) => {
        const ws = await wsConnect(addr);
        try {
            const a = await wsRpcCall(ws, 1, "workspace.create", { name: "first" });
            const aId = (a.result as { id: number }).id;
            // Re-create on the SAME connection succeeds and rebinds.
            const b = await wsRpcCall(ws, 2, "workspace.create", { name: "second" });
            assert.equal(b.error, undefined, "re-create on a bound connection must not throw");
            const bId = (b.result as { id: number }).id;
            assert.notEqual(bId, aId, "the connection switched to a fresh workspace");
            // Re-attach to the first by id — also re-binds cleanly.
            const back = await wsRpcCall(ws, 3, "workspace.attach", { id: aId });
            assert.equal(back.error, undefined, "re-attach on a bound connection must not throw");
            assert.equal((back.result as { id: number }).id, aId, "switched back to the first workspace");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} workspace.rename mutates the workspace name; rejects collision + empty", async () => {
    await withWsDaemon(async (_db, addr) => {
        const ws = await wsConnect(addr);
        try {
            const created = await wsRpcCall(ws, 1, "workspace.create", { name: "rename-a" });
            const id = (created.result as { id: number }).id;

            // Rename the attached workspace — same id (immutable identity), new handle.
            const renamed = await wsRpcCall(ws, 2, "workspace.rename", { name: "rename-b" });
            const rr = renamed.result as { id: number; name: string };
            assert.equal(rr.id, id, "same workspace — its mutable name changed, not its identity");
            assert.equal(rr.name, "rename-b", "the workspace name is mutated");

            // The old name is freed — a new workspace can take it (and re-binds this connection).
            const reuse = await wsRpcCall(ws, 3, "workspace.create", { name: "rename-a" });
            assert.equal(reuse.error, undefined, "the freed name is available again");

            // Collision: rename the (now "rename-a") workspace to a name another workspace holds.
            const collide = await wsRpcCall(ws, 4, "workspace.rename", { name: "rename-b" });
            const collisionProblem = rpcProblem(collide);
            assert.equal(collisionProblem.type, "https://problems.plurnk.xyz/daemon/workspace/name-conflict");
            assert.equal(collisionProblem.name, "rename-b");

            // Empty name is a contract violation.
            const empty = await wsRpcCall(ws, 5, "workspace.rename", { name: "" });
            const emptyProblem = rpcProblem(empty);
            assert.equal(emptyProblem.type, "https://problems.plurnk.xyz/daemon/input/name-invalid");
            assert.equal(emptyProblem.field, "name");

            // Self-rename is a no-op, not a collision.
            const self = await wsRpcCall(ws, 6, "workspace.rename", { name: "rename-a" });
            assert.equal(self.error, undefined, "renaming to its own name is a no-op, not a collision");
            assert.equal((self.result as { name: string }).name, "rename-a");
        } finally { ws.close(); }
    });
});
});


describe("seam-create-session", () => {
test("{§methods-workspace-create} {§methods-workspace-create}: fresh named session — empty log, runLoop accepts", async () => {
    const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\nhello from thread-2\n````", 10)] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "threads" });
            const workspaceId = (created.result as { id: number }).id;

            // A named, empty, model-origin root.
            const fresh = await daemon.createSession({ workspaceId, name: "Thread_2" });
            assert.equal(fresh.sessionName, "Thread_2", "the client's name IS the session name");
            assert.equal((await daemon.readLog({ workspaceId, sessionId: fresh.sessionId })).length, 0, "an EMPTY log — fork copies history, this must not");

            // runLoop accepts it (model-origin), and the full loop settles on that session.
            const terminated: Array<{ loopId: number; result: { status: number } }> = [];
            daemon.subscribeToEvents((_workspaceId, method, params) => {
                if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
            });
            const accepted = await daemon.runLoop({ workspaceId, sessionId: fresh.sessionId, prompt: "start thread 2" });
            assert.ok(accepted.loopId > 0, "runLoop accepts the fresh session");
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId, result }) => loopId === accepted.loopId && result.status === 200),
                { timeoutMs: 8000 },
            );

            // Name invariants mirror forkSession's: plurnk is an ordinary name; unmintable + taken are legible refusals.
            const plurnk = await daemon.createSession({ workspaceId, name: "plurnk" });
            assert.equal(plurnk.sessionName, "plurnk", "the operator may hold a session named plurnk");
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "_plurnk" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
                    assert.equal(error.result.problem.name, "_plurnk");
                    assert.equal(error.result.problem.recovery, "Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit."); // {§operation-results}
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "_invalid" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-invalid");
                    assert.equal(error.result.problem.status, 400);
                    assert.equal(error.result.problem.name, "_invalid");
                    assert.equal(error.result.problem.retryable, false);
                    return true;
                },
            );
            await assert.rejects(
                () => daemon.createSession({ workspaceId, name: "Thread_2" }),
                (error) => {
                    assert.ok(error instanceof OperationFailureError);
                    assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict");
                    assert.equal(error.result.problem.workspaceId, workspaceId);
                    assert.equal(error.result.problem.name, "Thread_2");
                    assert.equal(error.result.problem.recovery, "Choose another session name."); // {§operation-results}
                    return true;
                },
            );
            // Omission mints a distinct session with an opaque name.
            const anon = await daemon.createSession({ workspaceId });
            assert.match(anon.sessionName, /^[a-f0-9]{8}$/, "an unnamed session receives the ordinary opaque name");
        } finally { ws.close(); }
    });
});

test("{§execution-output-identity}: concurrent unnamed fresh sessions claim distinct short names", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `threads-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const sessions = await Promise.all(Array.from(
                { length: 8 },
                () => daemon.createSession({ workspaceId }),
            ));
            const names = sessions.map(({ sessionName }) => sessionName);

            assert.equal(new Set(names).size, sessions.length, "every fresh session remains individually addressable");
            for (const name of names) assert.match(name, /^[a-f0-9]{8}$/);
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: concurrent requests for one name create it once; the others are refused as name-conflict", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: `contest-${crypto.randomUUID()}` });
            const workspaceId = (created.result as { id: number }).id;
            const parent = await daemon.createSession({ workspaceId, name: "parent" });
            const attempts: Array<[string, () => Promise<unknown>]> = [
                ["create", () => daemon.createSession({ workspaceId, name: "contested" })],
                ["fork", () => daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "branched" })],
            ];
            for (const [label, attempt] of attempts) {
                const settled = await Promise.allSettled(Array.from({ length: 4 }, attempt));
                assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1, `${label}: one request claims the name`);
                for (const outcome of settled) {
                    if (outcome.status === "fulfilled") continue;
                    assert.ok(outcome.reason instanceof OperationFailureError, `${label}: ${String(outcome.reason)}`);
                    assert.equal(outcome.reason.result.problem.type, "https://problems.plurnk.xyz/daemon/session/name-conflict", label);
                    assert.equal(outcome.reason.result.problem.status, 409, label);
                }
            }
        } finally { ws.close(); }
    });
});
});


describe("workspace-project-root", () => {
test("{§methods-workspace-create} workspace.create with projectRoot round-trips and persists the column", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create", {
                name: "with-root", projectRoot: "/home/me/repo/foo",
            });
            const result = response.result as { id: number; name: string; projectRoot: string | null };
            assert.equal(result.name, "with-root");
            assert.equal(result.projectRoot, "/home/me/repo/foo");

            const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: result.id });
            assert.equal(row?.project_root, "/home/me/repo/foo");
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create} workspace.create without projectRoot leaves the column null (headless)", async () => {
    await withDaemon(null, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create", { name: "headless" });
            const result = response.result as { id: number; name: string; projectRoot: string | null };
            assert.equal(result.projectRoot, null);

            const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: result.id });
            assert.equal(row?.project_root, null);
        } finally { ws.close(); }
    });
});

test("{§operation-results} workspace.create rejects non-absolute projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const response = await rpcCall(ws, 1, "workspace.create", {
                name: "bad-root", projectRoot: "relative/path",
            });
            const problem = rpcProblem(response);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/input/project-root-not-absolute");
            assert.equal(problem.value, "relative/path");
            assert.equal(problem.recovery, "Provide an absolute project path."); // {§operation-results}
        } finally { ws.close(); }
    });
});

test("{§notifications} workspace/created notification carries projectRoot", async () => {
    await withDaemon(null, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const notifications = subscribeNotifications(ws, "workspace/created");
            await rpcCall(ws, 1, "workspace.create", {
                name: "with-notif", projectRoot: "/tmp/notif-test",
            });
            const captured = notifications();
            assert.equal(captured.length, 1);
            const params = captured[0] as { id: number; name: string; projectRoot: string | null };
            assert.equal(params.projectRoot, "/tmp/notif-test");
        } finally { ws.close(); }
    });
});
});
