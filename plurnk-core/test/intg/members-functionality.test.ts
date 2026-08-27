// {§members-functionality} — file membership as one Functionality family, proven through the
// daemon: the client's `worker.members.<verb>` and the model's `## EXEC0 [members] (<verb>)` are
// one owner over one workspace overlay; the model's add is admitted only under the operator's
// ceiling ({§members-model-scope}); inclusions union and an exclusion wins across workers
// ({§members-projection}); a model definition never passes the repository's ignore rules; `list`
// says what every glob resolved to and `discover` explains one file or previews one glob.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import MembersFunctionality from "../../src/server/MembersFunctionality.ts";
import Owner from "../../src/core/Owner.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { awaitExecOutcome, insertWorkspace, insertWorker, openMigrated, rootWorkspace } from "./_helpers.ts";
import type { Db } from "../../src/core/Db.ts";

const execFileP = promisify(execFile);

type Definition = { alias: string; origin: string; state: string; detail?: { effect: string; pattern: string; matched: number; files: string[]; ignored: number } };
type Candidate = { alias?: string; definition: { glob: string }; provenance: { kind: string; source: string }; summary?: string };

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${input}`);
    const item = parsed.items.find((x) => x.kind === "statement" && x.statement.op !== "PLAN");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const workerContext = (workspaceId: number, workerId: number) => ({ scope: "worker" as const, workspaceId, workerId });

// A git project: README.md and big/tokenizer.json committed; loose.md, loose2.md, docs/guide.md
// untracked; ignored.log ignored.
const gitProject = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-members-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.log\n");
    await writeFile(join(root, "README.md"), "# tracked\n");
    await mkdir(join(root, "big"), { recursive: true });
    await writeFile(join(root, "big", "tokenizer.json"), "{\"vocab\":[]}\n");
    await git(["add", ".gitignore", "README.md", "big/tokenizer.json"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "chore: seed"]);
    await writeFile(join(root, "loose.md"), "# loose\n");
    await writeFile(join(root, "loose2.md"), "# loose two\n");
    await writeFile(join(root, "ignored.log"), "secret\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# guide\n");
    return root;
};

const withEnv = async (overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { await run(); } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const memberOf = async (db: Db, workspaceId: number, pathname: string): Promise<boolean> =>
    (await db.crud_find_workspace_entry.get<{ id: number }>({
        workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", authority: "", pathname,
    })) !== undefined;

const rows = async (db: Db, workspaceId: number): Promise<string[]> =>
    (await db.crud_list_workspace_constraints.all<{ effect: string; glob: string; source: string }>({ workspace_id: workspaceId }))
        .map(({ effect, glob, source }) => `${effect} ${glob} ${source}`);

test("{§members-functionality} client and model share one surface; the ceiling, the union, exclusion, ignore, list, and discover hold", async () => {
    const root = await gitProject();
    await withEnv({
        PLURNK_SERVICE_GIT_ALLOWED: "1",
        PLURNK_SERVICE_GIT_AUTO: "1",
        PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: undefined,   // shipped: none
        PLURNK_MEMBERS_DOCS: "docs/**",
        PLURNK_MEMBERS_ENABLED: "[\"docs\"]",
    }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `members-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const model = await insertWorker(db, workspaceId, null, "conversation", "model");
        const client = await insertWorker(db, workspaceId, null, "client-1", "client");
        const daemon = new Daemon({ db, provider: null });
        await daemon.start();
        const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>, workerId = model): Promise<T> =>
            daemon.invokeModuleAction(`worker.members.${verb}`, params, workerContext(workspaceId, workerId)) as Promise<T>;
        const definitions = async (workerId = model) => (await invoke<{ definitions: Definition[] }>("list", {}, workerId)).definitions;
        const states = async (workerId = model) => (await definitions(workerId)).map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
        const discover = async (query: string) => (await invoke<{ candidates: Candidate[] }>("discover", { query })).candidates[0]!;
        const operate = (program: string) => daemon.dispatchAsClient({ workspaceId, workerId: client, functionalityWorkerId: model, statement: parseOne(program) });
        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        // An accepted verb starts a stream: the dispatch reports `started`; the verb's own JSON
        // outcome closes the family's results channel — wait for it before settling.
        const outputs = async () => (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "members", prefix: "/%" })).length;
        const accepted = async (program: string) => {
            const seen = proposals.length;
            const before = await outputs();
            const pending = operate(program);
            while (proposals.length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
            await daemon.resolveProposal(proposals[seen]!, { decision: "accept" });
            const result = await pending;
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "members", after: before, timeoutMs: 60_000 }) as { status?: number; problem?: { type?: string; recovery?: string } };
            return { result, outcome };
        };
        try {
            // The baseline: tracked is a member, loose is not ({§membership-baseline}).
            assert.equal(await memberOf(db, workspaceId, "README.md"), true);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "an untracked file is dark until added");

            // Service definitions from the operator's env ride like PLURNK_MCP_*: docs is enabled by
            // default, and list says what it resolved to.
            assert.deepEqual(await states(), ["docs:service:active"]);
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "docs/guide.md"), true, "an enabled service definition projects onto the overlay");
            assert.ok((await rows(db, workspaceId)).includes("include docs/** members"), "a human-authored definition projects with source members");
            assert.deepEqual((await definitions())[0]?.detail, { effect: "include", pattern: "docs/**", matched: 1, files: ["docs/guide.md"], ignored: 0 });
            const doc = (await db.engine_list_workspace_entries.all<{ scheme: string; pathname: string; channel: string; content: string }>({ workspace_id: workspaceId }))
                .find((row) => row.scheme === "worker" && row.pathname === "/_plurnk/members/docs.md" && row.channel === "body");
            assert.ok(doc !== undefined, "an enabled definition is one generated document under worker://~/_plurnk/members/");
            assert.match(doc.content, /^# docs\n\n## Summary\n\ninclude `docs\/\*\*` → 1 file\n/u, "the document summary is what the glob resolved to");
            assert.match(doc.content, /\| origin \| service \|/u);

            // discover explains one file — tracked, included, ignored, untracked, absent — and
            // previews a glob without adding anything.
            assert.equal((await discover("README.md")).provenance.kind, "member");
            assert.match(String((await discover("README.md")).summary), /tracked by git/u);
            assert.match(String((await discover("docs/guide.md")).summary), /included by `docs\/\*\*`/u);
            const loose = await discover("loose.md");
            assert.equal(loose.provenance.kind, "candidate");
            assert.deepEqual(loose.definition, { glob: "loose.md" });
            assert.equal((await discover("ignored.log")).provenance.kind, "ignored");
            assert.equal((await discover("nope.md")).provenance.kind, "absent");
            const preview = await discover("*.md");
            assert.equal(preview.provenance.kind, "preview");
            assert.match(String(preview.summary), /would include 2 files \(1 already members, 0 ignored/u);
            assert.match(String((await discover("!README.md")).summary), /would exclude 1 member: README\.md/u);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "discover admits nothing");
            assert.deepEqual(await states(), ["docs:service:active"], "discover records nothing");

            // A client action adds a loose file: a worker-origin definition, active, projected, member.
            const added = await invoke<{ status: number; alias: string }>("add", { alias: "loose", definition: { glob: "loose.md" } });
            assert.equal(added.status, 201);
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "a client-added glob admits the file");
            assert.deepEqual(await states(), ["docs:service:active", "loose:worker:active"]);
            assert.deepEqual((await definitions()).find((d) => d.alias === "loose")?.detail, { effect: "include", pattern: "loose.md", matched: 1, files: ["loose.md"], ignored: 0 });

            // The model's add under the shipped ceiling (none) is refused up front, naming git add.
            const { result: refused, outcome } = await accepted('## EXEC0 [members] (add)\n{"alias":"grab","definition":{"glob":"loose2.md"}}');
            assert.equal(refused.status, 200, "the accepted proposal settled inside the turn; the verb's own outcome rides the results channel");
            assert.equal(outcome.status, 403);
            assert.equal(outcome.problem?.type, "https://problems.plurnk.xyz/members/functionality/model-scope");
            assert.match(String(outcome.problem?.recovery), /git add/u);
            assert.equal(await memberOf(db, workspaceId, "loose2.md"), false, "nothing widened");
            assert.deepEqual(await states(), ["docs:service:active", "loose:worker:active"], "no definition was recorded");

            // Under scope root the model's glob is admitted and projected as source model; a model
            // glob over an ignored path admits nothing, and list says so.
            process.env.PLURNK_SERVICE_MEMBERS_MODEL_SCOPE = "root";
            const granted = await accepted('## EXEC0 [members] (add)\n{"alias":"grab","definition":{"glob":"loose2.md"}}');
            assert.equal(granted.outcome.status, 201, "the model's definition is added and enabled");
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "loose2.md"), true, "a model glob inside the root is a member under scope root");
            assert.ok((await rows(db, workspaceId)).includes("include loose2.md model"), "a model-proposed definition projects with source model");
            assert.equal((await accepted('## EXEC0 [members] (add)\n{"alias":"sneak","definition":{"glob":"ignored.log"}}')).outcome.status, 201);
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "ignored.log"), false, "a model glob never passes .gitignore");
            assert.deepEqual((await definitions()).find((d) => d.alias === "sneak")?.detail, { effect: "include", pattern: "ignored.log", matched: 0, files: [], ignored: 1 });

            // An exclusion is a `!glob` definition: it removes a tracked member, list counts what it
            // removed, and discover names the exclusion.
            const excluded = await invoke<{ status: number }>("add", { alias: "no-big", definition: { glob: "!big/**" } });
            assert.equal(excluded.status, 201);
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "big/tokenizer.json"), false, "an exclusion removes a tracked file from membership");
            assert.ok((await rows(db, workspaceId)).includes("exclude big/** members"));
            assert.deepEqual((await definitions()).find((d) => d.alias === "no-big")?.detail, { effect: "exclude", pattern: "big/**", matched: 1, files: ["big/tokenizer.json"], ignored: 0 });
            const gone = await discover("big/tokenizer.json");
            assert.equal(gone.provenance.kind, "excluded");
            assert.match(String(gone.summary), /excluded by `!big\/\*\*`/u);
            await invoke("remove", { alias: "no-big" });
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "big/tokenizer.json"), true, "removing the exclusion restores the tracked member");

            // Union across workers, an exclusion wins: a child excludes what the parent included;
            // removal restores it.
            const child = await insertWorker(db, workspaceId, model, "child", "model");
            const hidden = await invoke<{ status: number }>("add", { alias: "no-loose", definition: { glob: "!loose.md" } }, child);
            assert.equal(hidden.status, 201);
            await daemon.settleFunctionality(child);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "an exclusion from any worker wins over an inclusion from another");
            await invoke("remove", { alias: "no-loose" }, child);
            await daemon.settleFunctionality(child);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "removing the exclusion restores the union");

            // Disabling is per worker: the child's birth snapshot still holds the inclusion, so the
            // union keeps the file until no worker holds it.
            await invoke("disable", { alias: "loose" });
            await daemon.settleFunctionality(model);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "the child's inherited copy still holds the inclusion: the union keeps it");
            assert.deepEqual((await states()).filter((s) => s.startsWith("loose:")), ["loose:worker:disabled"]);
            await invoke("disable", { alias: "loose" }, child);
            await daemon.settleFunctionality(child);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "once no worker holds the inclusion, the file is dark again");
        } finally {
            unsubscribe();
            await daemon.stop();
            await db.close();
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("{§members-model-scope} the ceiling: none refuses every model definition, root admits inside it, the workspace narrows the service", async () => {
    const root = await gitProject();
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `members-scope-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const who = { workspaceId, workerId: model };
    const engine = (): never => { throw new Error("prepare is not exercised here"); };
    const refusedAs = async (run: () => Promise<unknown>, code: string, status: number) => {
        const error = await run().then(() => null, (cause: unknown) => cause);
        assert.ok(error instanceof OperationFailureError, `expected an OperationFailureError, got ${String(error)}`);
        assert.equal(error.result.status, status);
        assert.equal(error.result.problem?.type, `https://problems.plurnk.xyz/members/functionality/${code}`);
        return error.result.problem as { recovery?: string; scope?: string };
    };
    try {
        const closed = new MembersFunctionality({ db, engine, environ: {} });
        const refused = await refusedAs(() => closed.admit({ definition: { glob: "notes.md" } }, who, "operation"), "model-scope", 403);
        assert.match(String(refused.recovery), /git add/u);
        await refusedAs(() => closed.admit({ definition: { glob: "!notes.md" } }, who, "operation"), "model-scope", 403);
        assert.deepEqual(await closed.admit({ alias: "notes", definition: { glob: "notes.md" } }, who, "action"), {
            alias: "notes",
            definition: { glob: "notes.md", provenance: { kind: "client-action" } },
        });
        assert.deepEqual(await closed.admit({ definition: { glob: "!**/*.lock" } }, who), {
            alias: "no-lock",
            definition: { glob: "!**/*.lock", provenance: { kind: "client-action" } },
        });

        const rooted = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root" } });
        assert.deepEqual(await rooted.admit({ alias: "notes", definition: { glob: "notes.md" } }, who, "operation"), {
            alias: "notes",
            definition: { glob: "notes.md", provenance: { kind: "model-proposal" } },
        });
        await refusedAs(() => rooted.admit({ definition: { glob: "../secrets/*.pem" } }, who, "operation"), "model-scope", 403);
        await refusedAs(() => rooted.admit({ definition: { glob: "!" } }, who, "operation"), "definition-invalid", 400);
        await refusedAs(() => rooted.admit({ definition: { pattern: "x" } }, who, "action"), "definition-invalid", 400);

        // A permissive service (namespace) narrowed by the workspace to root.
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ membersModelScope: "root" }) });
        const wide = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace" } });
        assert.deepEqual(await wide.admit({ alias: "shared", definition: { glob: "../shared/*.md" } }, who, "action"), {
            alias: "shared",
            definition: { glob: "../shared/*.md", provenance: { kind: "client-action" } },
        });
        assert.deepEqual(await wide.admit({ alias: "inside", definition: { glob: "loose.md" } }, who, "operation"), {
            alias: "inside",
            definition: { glob: "loose.md", provenance: { kind: "model-proposal" } },
        });
        const narrowed = await refusedAs(() => wide.admit({ alias: "shared", definition: { glob: "../shared/*.md" } }, who, "operation"), "model-scope", 403);
        assert.equal(narrowed.scope, "root", "settings.membersModelScope narrows the service's namespace to root");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
