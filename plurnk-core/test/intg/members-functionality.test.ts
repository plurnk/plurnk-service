import { ownWorker, serverProposals, TEST_OWNER } from "./_approval.ts";
// {§members-functionality} {§functionality-addressing} {§members-model-scope} {§members-projection}
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { waitForDb } from "./_rpc.ts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import MembersFunctionality from "../../src/server/MembersFunctionality.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { awaitExecOutcome } from "./_execs.ts";
import { fixtureExecutors, makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { insertWorkspace, insertWorker, openMigrated, rootWorkspace } from "./_db.ts";
import { modelOperation } from "./_workers.ts";
import type { Db } from "../../src/core/Db.ts";

const execFileP = promisify(execFile);

type Definition = { alias: string; origin: string; state: string; definition?: { glob: string; provenance?: { kind: string } }; detail?: { effect: string; pattern: string; matched: number; files: string[]; ignored: number } };
type Candidate = { alias?: string; definition: { glob: string }; provenance: { kind: string; source: string }; summary?: string };
type Receipt = { status: number; family: string; alias?: string; definitions?: Definition[]; removed?: true };

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const workspaceContext = (workspaceId: number) => ({ scope: "workspace" as const, workspaceId });

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
        workspace_id: workspaceId, scheme: "file", authority: "", pathname,
    })) !== undefined;

for (const decision of ["auto", "accept", "reject"] as const) test(`{§op-execution-order} members ${decision} settles before a READ in the same model turn`, { timeout: 30_000 }, async (t) => {
    serverProposals(t, decision === "auto" ? "accept" : "review");
    const root = await gitProject();
    await withEnv({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root", PLURNK_SERVICE_GIT_AUTO: "1" }, async () => {
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: 1_000_000, responses: [
            makeRawMockResponse([
                PlurnkParser.frame("members (add)", JSON.stringify({ files: ["loose.md"] })),
                PlurnkParser.frame("READ (loose.md)", ""),
                PlurnkParser.frame("NOTE", "Review the admitted file."),
            ].join("\n\n")),
            makeMockResponse(PlurnkParser.frame("SEND [200]", "Read the file.")),
        ] });
        const daemon = new Daemon({ db, provider });
        const results: Array<{ status: number; body?: string }> = [];
        try {
            const workspaceId = await insertWorkspace(db, "ordered-members");
            await rootWorkspace(db, workspaceId, root);
            const workerId = await insertWorker(db, workspaceId, null, "reader", "model");
            if (decision !== "auto") await ownWorker(db, workspaceId, workerId);
            daemon.subscribeToEvents((_id, method, params) => {
                if (method !== "operation/event") return;
                const event = params as { phase: string; origin: string; statement: PlurnkStatement; result?: { status: number; body?: string } };
                if (event.phase === "settled" && event.origin === "model" && event.statement.op === "READ" && event.result !== undefined) results.push(event.result);
            });
            await daemon.start();
            const loop = await daemon.runLoop({ workspaceId, workerId, prompt: "Admit loose.md and read it.", maxTurns: 2 });
            if (decision !== "auto") {
                const proposals = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
                assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "nothing publishes before approval");
                assert.deepEqual(results, [], "the next READ waits for the decision");
                await daemon.resolveProposal(proposals[0].logEntryId, { decision }, { workspaceId, address: TEST_OWNER });
                if (decision === "reject") {
                    // {§membership-auto-add} — the READ of the file still unadmitted proposes its admission in its turn,
                    // after the rejection settled; refused as well, the READ settles rejected.
                    const again = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1 && items[0].op === "READ");
                    assert.deepEqual(results, [], "the READ waits for its own decision");
                    await daemon.resolveProposal(again[0].logEntryId, { decision: "reject" }, { workspaceId, address: TEST_OWNER });
                }
            }
            const lifecycle = new LoopLifecycle(db);
            await waitForDb(() => lifecycle.status(loop.loopId), (status) => status !== null && status >= 200);
            assert.deepEqual(results.map(({ status }) => status), [decision === "reject" ? 400 : 200], "the read observes the settled decision, not a merely started manager stream");
            assert.equal(await memberOf(db, workspaceId, "loose.md"), decision !== "reject");
        } finally { await daemon.stop(); await db.close(); }
    }).finally(() => rm(root, { recursive: true, force: true }));
});

const rows = async (db: Db, workspaceId: number): Promise<string[]> =>
    (await db.crud_list_workspace_constraints.all<{ effect: string; glob: string; source: string }>({ workspace_id: workspaceId }))
        .map(({ effect, glob, source }) => `${effect} ${glob} ${source}`);

const problemOf = async (run: () => Promise<unknown>): Promise<{ type?: string; status?: number; detail?: string; recovery?: string; alias?: string }> => {
    const error = await run().then(() => null, (cause: unknown) => cause);
    assert.ok(error instanceof OperationFailureError, `expected an OperationFailureError, got ${String(error)}`);
    return { ...error.result.problem, status: error.result.status };
};

test("{§path-glob-matching} members discovery, scans, exclusions and SQL agree on escaped filenames", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "plurnk-members-glob-"));
    const root = join(temporary, String.raw`base\[1]`);
    const intended = String.raw`dir\name/a.txt`;
    const neighbor = "dir/name/a.txt";
    const pattern = String.raw`dir\\name/*.txt`;
    const names = [intended, neighbor, "dirname/a.txt", "a*.txt", "a/b.txt"];
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        for (const name of names) {
            await mkdir(dirname(join(root, name)), { recursive: true });
            await writeFile(join(root, name), name);
        }
        const workspaceId = await insertWorkspace(db, "members-escaped");
        await rootWorkspace(db, workspaceId, root);
        await daemon.start();
        const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
            daemon.invokeModuleAction(`workspace.members.${verb}`, params, workspaceContext(workspaceId)) as Promise<T>;
        const add = (...files: string[]) => invoke("add", { files });
        const definitions = async () => (await invoke<{ definitions: Definition[] }>("list", {})).definitions;
        const discover = async (query: string) => (await invoke<{ candidates: Candidate[] }>("discover", { query })).candidates[0];

        const preview = await discover(String.raw`dir\\name/a.txt`);
        assert.equal(preview.provenance.kind, "preview", "escape syntax is classified at the shared boundary");
        assert.match(preview.summary!, /^would include 1 file/u);
        await add(pattern);
        assert.equal(await memberOf(db, workspaceId, intended), true);
        assert.equal(await memberOf(db, workspaceId, neighbor), false);
        assert.deepEqual((await definitions()).find(({ alias }) => alias === pattern)?.detail?.files, [intended]);
        assert.deepEqual(await db.crud_constraint_including_by_definition.get({ workspace_id: workspaceId, key: intended }), { included: 1 });
        assert.equal(await db.crud_constraint_including_by_definition.get({ workspace_id: workspaceId, key: neighbor }), undefined);

        await add(String.raw`a\*.txt`);
        assert.equal(await memberOf(db, workspaceId, "a*.txt"), true);
        assert.equal(await memberOf(db, workspaceId, "a/b.txt"), false);
        await add("dir/name/*.txt");
        const exclusionPreview = await discover(`!${pattern}`);
        assert.match(exclusionPreview.summary!, /^would exclude 1 member/u);
        await add(`!${pattern}`);
        assert.equal(await memberOf(db, workspaceId, intended), false);
        assert.equal(await memberOf(db, workspaceId, neighbor), true);
        assert.deepEqual((await definitions()).find(({ alias }) => alias === `!${pattern}`)?.detail?.files, [intended]);
        assert.deepEqual(await db.crud_constraint_excluding.get({ workspace_id: workspaceId, key: intended }), { glob: pattern });
        assert.equal(await db.crud_constraint_excluding.get({ workspace_id: workspaceId, key: neighbor }), undefined);
    } finally {
        await daemon.stop();
        await db.close();
        await rm(temporary, { recursive: true, force: true });
    }
});

for (const boundary of ["startup", "workspace inspection"] as const) {
    test(`{§configuration-repair-path} ${boundary} preserves inspection of invalid members without publishing a winner`, async () => {
        const db = await openMigrated();
        const daemon = new Daemon({ db, provider: null });
        try {
            const workspaceId = await insertWorkspace(db, "ambiguous-members");
            if (boundary === "workspace inspection") await daemon.start();
            await withEnv({
                PLURNK_MEMBERS_DOCS: "docs/**",
                PLURNK_MEMBERS_docs: "src/**",
                PLURNK_MEMBERS_ENABLED: "1",
            }, async () => {
                if (boundary === "startup") await daemon.start();
                await assert.rejects(
                    () => daemon.invokeModuleAction(
                        "workspace.members.list", {}, workspaceContext(workspaceId),
                    ),
                    (error: unknown) => {
                        assert.ok(error instanceof OperationFailureError);
                        assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/functionality/configuration-invalid");
                        assert.equal(error.result.problem.detail, "PLURNK_MEMBERS_DOCS is not a declared control; use a lowercase resource alias with underscores for hyphens and uppercase setting names.");
                        return true;
                    },
                );
                assert.deepEqual(await rows(db, workspaceId), [], "neither ambiguous definition changes membership");
            });
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
}

test("{§members-functionality} {§functionality-addressing} client and model share one surface named by globs; the ceiling, the union, exclusion, ignore, list, and discover hold", async () => {
    const root = await gitProject();
    await withEnv({
        PLURNK_SERVICE_GIT_ALLOWED: "1",
        PLURNK_SERVICE_GIT_AUTO: "1",
        PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none",
        PLURNK_MEMBERS_docs: "docs/**",
        PLURNK_MEMBERS_ENABLED: "1",
    }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `members-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const model = await insertWorker(db, workspaceId, null, "model", "model");
        await ownWorker(db, workspaceId, model);
        const daemon = new Daemon({ db, provider: null });
        await daemon.start();
        const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>, _workerId = model): Promise<T> =>
            daemon.invokeModuleAction(`workspace.members.${verb}`, params, workspaceContext(workspaceId)) as Promise<T>;
        const definitions = async (workerId = model) => (await invoke<{ definitions: Definition[] }>("list", {}, workerId)).definitions;
        const states = async (workerId = model) => (await definitions(workerId)).map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
        const discover = async (query: string) => (await invoke<{ candidates: Candidate[] }>("discover", { query })).candidates[0];
        // The model's own surface: its operations, reviewed by its owner.
        const operate = (program: string) => modelOperation(daemon, db, { workspaceId, workerId: model, statement: parseOne(program) });
        const proposals: number[] = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
        });
        // The dispatched result and the completed JSON output report the same settlement.
        const outputs = async () => (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: "members", prefix: "/%" })).length;
        const accepted = async (program: string) => {
            const seen = proposals.length;
            const before = await outputs();
            const pending = operate(program);
            while (proposals.length === seen) await new Promise((resolve) => setTimeout(resolve, 5));
            await daemon.resolveProposal(proposals[seen], { decision: "accept" }, { workspaceId, address: TEST_OWNER });
            const result = await pending;
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "members", after: before, timeoutMs: 60_000 }) as Receipt & { problem?: { type?: string; recovery?: string } };
            return { result, outcome };
        };
        const modelAdd = (...files: string[]) => accepted(`\`\`\`\`members (add)\n${JSON.stringify({ files })}\n\`\`\`\``);
        try {
            // {§functionality-addressing} — the surface: no replace, and the add and select inputs are the family's own.
            assert.deepEqual(
                daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.members.")).toSorted(),
                ["add", "disable", "discover", "enable", "list", "remove"].map((verb) => `workspace.members.${verb}`),
            );

            // The baseline: tracked is a member, loose is not ({§membership-baseline}).
            assert.equal(await memberOf(db, workspaceId, "README.md"), true);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "an untracked file is dark until added");
            // Service definitions from the operator's env ride like PLURNK_MCP_*: docs/** is enabled by
            // default, named by its glob, and list says what it resolved to and which key declared it.
            assert.deepEqual(await states(), ["docs/**:service:dormant"]);
            await invoke("enable", { file: "docs/**" });
            assert.deepEqual(await states(), ["docs/**:service:active"]);
            const invalid = await problemOf(() => invoke("add", { alias: "docs", definition: { glob: "docs/**" } }));
            assert.equal(invalid.type, "https://problems.plurnk.xyz/functionality/arguments-invalid", "an alias-named body is not the add input");
            assert.equal((await problemOf(() => invoke("enable", { alias: "docs" }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
            assert.equal((await problemOf(() => invoke("add", { files: [] }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid", "add names at least one glob");
            assert.deepEqual((await definitions())[0]?.definition, { glob: "docs/**", provenance: { kind: "service-configuration" } });
            assert.deepEqual((await definitions() as Array<{ provenance?: object }>)[0]?.provenance, { kind: "environment", source: "PLURNK_MEMBERS_docs" });
            await daemon.settleFunctionality(workspaceId);
            // {§functionality-document-body} — the runtime document teaches tracked-or-picked and the scope
            // lattice beneath its generated header, from plurnk-core/docs/members.md.
            const membersDoc = (await daemon.engine.referenceEntries(workspaceId)).find(({ pathname }) => pathname === "/_plurnk/plurnk/members.md");
            assert.ok(membersDoc, "the members runtime document is a reference entry");
            assert.match(membersDoc.content, /## When a file you need is not a member/u, "the body teaches the recovery when a file is not a member");
            assert.match(membersDoc.content, /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE/u, "the body names the scope ceiling");
            assert.doesNotMatch(membersDoc.content, /git add/u, "no recovery asks the model to change the repository");
            assert.match(membersDoc.content, /```members \(add\) <!--[^\n]*-->\n\{"files": \[\]\}\n```/u, "the verb table teaches the family's own add input");
            assert.match(membersDoc.content, /```members \(remove\) <!--[^\n]*-->\n\{"file": ""\}\n```/u, "and its select input");
            assert.doesNotMatch(membersDoc.content, /replace/u, "the family serves no replace, so nothing teaches one");
            assert.ok(membersDoc.content.indexOf("## Tools") < membersDoc.content.indexOf("## What makes a file visible"), "the generated verb table precedes the authored body");

            assert.equal(await memberOf(db, workspaceId, "docs/guide.md"), true, "an enabled service definition projects onto the overlay");
            assert.ok((await rows(db, workspaceId)).includes("include docs/** members"), "a human-authored definition projects with source members");
            assert.deepEqual((await definitions())[0]?.detail, { effect: "include", pattern: "docs/**", matched: 1, files: ["docs/guide.md"], ignored: 0 });
            // {§members-projection} — the document is named by the glob, percent-encoded as one segment.
            await operate("````READ (worker:///_plurnk/members/docs%2F%2A%2A.md) <1,-1>````");
            const doc = (await db.engine_list_workspace_entries.all<{ scheme: string; pathname: string; channel: string; content: string }>({ workspace_id: workspaceId }))
                .find((row) => row.scheme === "worker" && row.pathname === "/_plurnk/members/docs%2F%2A%2A.md" && row.channel === "body");
            assert.ok(doc !== undefined, "an enabled definition is one generated document under worker:///_plurnk/members/");
            assert.match(doc.content, /^# `docs\/\*\*`\n\n## Summary\n\ninclude `docs\/\*\*` → 1 file\n/u, "the document summary is what the glob resolved to");
            assert.match(doc.content, /\| origin \| service \|/u);

            // discover explains one file — tracked, included, ignored, untracked, absent — and
            // previews a glob without adding anything; a candidate is named by its glob.
            assert.equal((await discover("README.md")).provenance.kind, "member");
            assert.match(String((await discover("README.md")).summary), /tracked by git/u);
            assert.match(String((await discover("docs/guide.md")).summary), /included by `docs\/\*\*`/u);
            const loose = await discover("loose.md");
            assert.equal(loose.provenance.kind, "candidate");
            assert.equal(loose.alias, "loose.md");
            assert.deepEqual(loose.definition, { glob: "loose.md" });
            assert.equal((await discover("ignored.log")).provenance.kind, "ignored");
            assert.equal((await discover("nope.md")).provenance.kind, "absent");
            const preview = await discover("*.md");
            assert.equal(preview.provenance.kind, "preview");
            assert.equal(preview.alias, "*.md");
            assert.match(String(preview.summary), /would include 2 files \(1 already members, 0 ignored/u);
            assert.match(String((await discover("!README.md")).summary), /would exclude 1 member: README\.md/u);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "discover admits nothing");
            assert.deepEqual(await states(), ["docs/**:service:active"], "discover records nothing");
            // {§functionality-discover-advertisement} `query` is the one input: `source` is refused by the
            // shared schema check, and a query naming no path or pattern by the family itself.
            assert.equal((await problemOf(() => invoke("discover", { source: "README.md" }))).type, "https://problems.plurnk.xyz/functionality/arguments-invalid");
            const bare = await problemOf(() => invoke("discover", { query: "!" }));
            assert.equal(bare.type, "https://problems.plurnk.xyz/members/functionality/query-invalid");
            assert.equal(bare.detail, "'!' names no path or pattern.");

            // A client action adds a loose file: a workspace-origin definition, active, projected, member.
            // The receipt lists what the add admitted.
            const added = await invoke<Receipt>("add", { files: ["loose.md"] });
            assert.equal(added.status, 201);
            assert.equal(added.alias, undefined, "an addressing family's add receipt lists its definitions");
            assert.deepEqual(added.definitions?.map(({ alias, origin, state }) => `${alias}:${origin}:${state}`), ["loose.md:workspace:active"]);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "a client-added glob admits the file");
            assert.deepEqual(await states(), ["docs/**:service:active", "loose.md:workspace:active"]);
            assert.deepEqual((await definitions()).find((d) => d.alias === "loose.md")?.detail, { effect: "include", pattern: "loose.md", matched: 1, files: ["loose.md"], ignored: 0 });
            // Reapplying a definition is idempotent (200); naming it twice in one add is one definition.
            const again = await invoke<Receipt>("add", { files: ["loose.md", " loose.md "] });
            assert.equal(again.status, 200);
            assert.deepEqual(again.definitions?.map(({ alias }) => alias), ["loose.md"]);

            // The model's add under the shipped ceiling (none) is refused up front, naming the user's path.
            const { result: refused, outcome } = await modelAdd("loose2.md");
            assert.equal(refused.status, 403, "acceptance does not hide the coordinator's refusal");
            assert.equal(outcome.status, 403);
            assert.equal(outcome.problem?.type, "https://problems.plurnk.xyz/members/functionality/model-scope");
            assert.doesNotMatch(String(outcome.problem?.recovery), /\bgit\b/u, "its recovery asks nothing of the repository");
            assert.equal(await memberOf(db, workspaceId, "loose2.md"), false, "nothing widened");
            assert.deepEqual(await states(), ["docs/**:service:active", "loose.md:workspace:active"], "no definition was recorded");

            // Under scope root the model's glob is admitted and projected as source model; a model
            // glob over an ignored path admits nothing, and list says so. One add names several globs
            // and the receipt lists each; one glob past the scope refuses them all.
            process.env.PLURNK_SERVICE_MEMBERS_MODEL_SCOPE = "root";
            const granted = await modelAdd("loose2.md", "ignored.log");
            assert.equal(granted.outcome.status, 201, "the model's definitions are added and enabled");
            assert.deepEqual(granted.outcome.definitions?.map(({ alias, origin, state }) => `${alias}:${origin}:${state}`), ["loose2.md:workspace:active", "ignored.log:workspace:active"]);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose2.md"), true, "a model glob inside the root is a member under scope root");
            assert.ok((await rows(db, workspaceId)).includes("include loose2.md model"), "a model-proposed definition projects with source model");
            assert.equal(await memberOf(db, workspaceId, "ignored.log"), false, "a model glob never passes .gitignore");
            assert.deepEqual((await definitions()).find((d) => d.alias === "ignored.log")?.detail, { effect: "include", pattern: "ignored.log", matched: 0, files: [], ignored: 1 });
            const mixed = await modelAdd("docs/*.md", "../secrets/*.pem");
            assert.equal(mixed.outcome.status, 403, "one glob past the scope refuses the whole add");
            assert.equal((await definitions()).some((d) => d.alias === "docs/*.md"), false, "nothing of a refused add is recorded");
            // The same glob from the other authority is a different definition: the 409 names the way back.
            const taken = await modelAdd("loose.md");
            assert.equal(taken.outcome.status, 409);
            assert.equal(taken.outcome.problem?.type, "https://problems.plurnk.xyz/functionality/alias-exists");
            assert.equal(taken.outcome.problem?.recovery, "Remove it, then add it again.");
            assert.deepEqual((await definitions()).find((d) => d.alias === "loose.md")?.definition?.provenance, { kind: "client-action" }, "the client's definition stands");

            // An exclusion is a `!glob` definition: it removes a tracked member, list counts what it
            // removed, and discover names the exclusion. Remove names the glob.
            const excluded = await invoke<Receipt>("add", { files: ["!big/**"] });
            assert.equal(excluded.status, 201);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "big/tokenizer.json"), false, "an exclusion removes a tracked file from membership");
            assert.ok((await rows(db, workspaceId)).includes("exclude big/** members"));
            assert.deepEqual((await definitions()).find((d) => d.alias === "!big/**")?.detail, { effect: "exclude", pattern: "big/**", matched: 1, files: ["big/tokenizer.json"], ignored: 0 });
            const gone = await discover("big/tokenizer.json");
            assert.equal(gone.provenance.kind, "excluded");
            assert.match(String(gone.summary), /excluded by `!big\/\*\*`/u);
            const removed = await invoke<Receipt>("remove", { file: "!big/**" });
            assert.deepEqual(removed, { status: 200, family: "members", alias: "!big/**", removed: true });
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "big/tokenizer.json"), true, "removing the exclusion restores the tracked member");
            const unknown = await problemOf(() => invoke("remove", { file: "!big/**" }));
            assert.equal(unknown.type, "https://problems.plurnk.xyz/functionality/alias-unknown");
            assert.equal(unknown.detail, "'!big/**' is not available to this workspace.");

            // Union across workers, an exclusion wins: a child excludes what the parent included;
            // removal restores it.
            const child = await insertWorker(db, workspaceId, model, "child", "model");
            const hidden = await invoke<Receipt>("add", { files: ["!loose.md"] }, child);
            assert.equal(hidden.status, 201);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "an exclusion from any worker wins over an inclusion from another");
            await invoke("remove", { file: "!loose.md" }, child);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), true, "removing the exclusion restores the union");

            // Disable changes the workspace membership; no child keeps a copied definition.
            const disabled = await invoke<Receipt>("disable", { file: "loose.md" });
            assert.equal(disabled.alias, "loose.md");
            assert.equal(disabled.definitions, undefined, "a select verb names the one definition it concerned");
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "the shared inclusion is disabled for every worker");
            assert.deepEqual((await states()).filter((s) => s.startsWith("loose.md:")), ["loose.md:workspace:disabled"]);
            await invoke("disable", { file: "loose.md" }, child);
            await daemon.settleFunctionality(workspaceId);
            assert.equal(await memberOf(db, workspaceId, "loose.md"), false, "repeating disable leaves the shared state unchanged");
            // A service definition is disabled by its glob too, and cannot be removed here.
            await invoke("disable", { file: "docs/**" });
            assert.deepEqual((await states()).filter((s) => s.startsWith("docs/**:")), ["docs/**:service:disabled"]);
            assert.equal((await problemOf(() => invoke("remove", { file: "docs/**" }))).type, "https://problems.plurnk.xyz/functionality/alias-service-owned");
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
    const model = await insertWorker(db, workspaceId, null, "model", "model");
    const who = { workspaceId, workerId: model };
    const engine = (): never => { throw new Error("prepare is not exercised here"); };
    const refusedAs = async (run: () => Promise<unknown>, code: string, status: number) => {
        const error = await run().then(() => null, (cause: unknown) => cause);
        assert.ok(error instanceof OperationFailureError, `expected an OperationFailureError, got ${String(error)}`);
        assert.equal(error.result.status, status);
        assert.equal(error.result.problem?.type, `https://problems.plurnk.xyz/members/functionality/${code}`);
        return error.result.problem as { recovery?: string; scope?: string };
    };
    const admission = (glob: string, kind: "client-action" | "model-proposal") => ({ alias: glob, definition: { glob, provenance: { kind } } });
    try {
        const closed = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none", PLURNK_MEMBERS_ENABLED: "1" } });
        const refused = await refusedAs(() => closed.admit({ files: ["notes.md"] }, who, "operation"), "model-scope", 403);
        assert.doesNotMatch(String(refused.recovery), /\bgit\b/u, "the recovery asks nothing of the repository");
        await refusedAs(() => closed.admit({ files: ["!notes.md"] }, who, "operation"), "model-scope", 403);
        assert.deepEqual(await closed.admit({ files: ["notes.md"] }, who, "action"), [admission("notes.md", "client-action")]);
        assert.deepEqual(await closed.admit({ files: [" !**/*.lock ", "!**/*.lock"] }, who), [admission("!**/*.lock", "client-action")], "a glob is trimmed, and named twice is one definition");

        const rooted = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root", PLURNK_MEMBERS_ENABLED: "1" } });
        assert.deepEqual(await rooted.admit({ files: ["notes.md", "!drafts/**"] }, who, "operation"), [admission("notes.md", "model-proposal"), admission("!drafts/**", "model-proposal")]);
        await refusedAs(() => rooted.admit({ files: ["../secrets/*.pem"] }, who, "operation"), "model-scope", 403);
        await refusedAs(() => rooted.admit({ files: ["notes.md", "../secrets/*.pem"] }, who, "operation"), "model-scope", 403);
        // {§members-functionality} The scope judges the glob in key space, whatever its spelling.
        assert.deepEqual(await rooted.admit({ files: [join(root, "notes.md")] }, who, "operation"), [admission(join(root, "notes.md"), "model-proposal")],
            "an absolute glob inside the root is a root pattern");
        await refusedAs(() => rooted.admit({ files: [join(dirname(root), "secrets", "*.pem")] }, who, "operation"), "model-scope", 403);
        const bare = await refusedAs(() => rooted.admit({ files: ["!"] }, who, "operation"), "definition-invalid", 400);
        assert.match(String(bare.recovery), /docs\/\*\*/u);

        // A permissive service (namespace) narrowed by the workspace to root.
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ membersModelScope: "root" }) });
        const wide = new MembersFunctionality({ db, engine, environ: { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace", PLURNK_MEMBERS_ENABLED: "1" } });
        assert.deepEqual(await wide.admit({ files: ["../shared/*.md"] }, who, "action"), [admission("../shared/*.md", "client-action")]);
        assert.deepEqual(await wide.admit({ files: ["loose.md"] }, who, "operation"), [admission("loose.md", "model-proposal")]);
        const narrowed = await refusedAs(() => wide.admit({ files: ["../shared/*.md"] }, who, "operation"), "model-scope", 403);
        assert.equal(narrowed.scope, "root", "settings.membersModelScope narrows the service's namespace to root");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// {§members-functionality} {§fs-canonical-name} A definition's glob is matched against member keys: written absolute or from
// the root, beside it or farther out, it admits the same members, which READ reaches by either spelling; an exclusion
// spelled absolute removes what it names, and no member is stored under an absolute key.
test("{§members-functionality} {§fs-canonical-name} a glob spelled absolute or from the root admits the same members beyond the root, near or far, and READ reaches them", { timeout: 60_000 }, async (t) => {
    serverProposals(t, "accept");
    const base = await mkdtemp(join(tmpdir(), "plurnk-members-beyond-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const root = join(base, "ws", "project");
    await mkdir(root, { recursive: true });
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "README.md"), "# tracked\n");
    await git(["add", "README.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "chore: seed"]);
    // Beside the root and farther out: one file per spelling, and one an exclusion removes.
    const places = [{ dir: join(base, "ws", "shared"), key: "../shared" }, { dir: join(base, "far"), key: "../../far" }];
    for (const { dir } of places) {
        await mkdir(dir, { recursive: true });
        for (const name of ["relative.md", "absolute.md", "excluded.md"]) await writeFile(join(dir, name), `${dir}/${name}\n`);
    }
    await withEnv({ PLURNK_SERVICE_GIT_ALLOWED: "1", PLURNK_SERVICE_GIT_AUTO: "1", PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace", PLURNK_MEMBERS_ENABLED: "1" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `members-beyond-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const model = await insertWorker(db, workspaceId, null, "model", "model");
        await ownWorker(db, workspaceId, model);
        const daemon = new Daemon({ db, provider: null });
        await daemon.start();
        try {
            const operate = (program: string) => modelOperation(daemon, db, { workspaceId, workerId: model, statement: parseOne(program) });
            const files = places.flatMap(({ dir, key }) => [`${key}/relative.md`, join(dir, "absolute.md"), `${key}/excluded.md`, `!${join(dir, "excluded.md")}`]);
            await operate(`\`\`\`\`members (add)\n${JSON.stringify({ files })}\n\`\`\`\``);
            const outcome = await awaitExecOutcome(db, { workspaceId, scheme: "members", after: 0, timeoutMs: 30_000 }) as Receipt;
            assert.equal(outcome.status, 201);
            await daemon.settleFunctionality(workspaceId);
            for (const { dir, key } of places) {
                assert.deepEqual(outcome.definitions?.find(({ alias }) => alias === join(dir, "absolute.md"))?.detail?.files, [`${key}/absolute.md`],
                    `${key}: the absolute glob resolves to the member's key`);
                for (const name of ["relative.md", "absolute.md"]) {
                    assert.equal(await memberOf(db, workspaceId, `${key}/${name}`), true, `${key}/${name} is a member`);
                    for (const spelling of [`${key}/${name}`, join(dir, name)]) {
                        const read = await operate(`\`\`\`\`READ (${spelling})\`\`\`\``) as { status: number; content?: string | null };
                        assert.deepEqual([read.status, read.content], [200, `${dir}/${name}\n`], `READ ${spelling} reaches it`);
                    }
                }
                assert.equal(await memberOf(db, workspaceId, `${key}/excluded.md`), false, `${key}: an exclusion spelled absolute removes the member`);
            }
            assert.deepEqual(await db.test_entries_by_scheme_prefix.all({ workspace_id: workspaceId, scheme: "file", prefix: "/%" }), [],
                "no member is stored under an absolute key");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});
