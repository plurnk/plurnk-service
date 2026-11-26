import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import {
    Problems,
    UNKNOWN_POSITION,
    type FunctionalityFamilyHandle,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import { SkillResourceError } from "@plurnk/plurnk-agent-skills";
import type { ResolvedEditStatement, ResourceTreeSource, SchemeCtx } from "@plurnk/plurnk-schemes";
import createPersonasModule from "./daemon-module.ts";
import * as PersonasBarrel from "./index.ts";
import {
    Module,
    PERSONAS_FAMILY,
    PERSONAS_OWNER,
    PersonaScheme,
    PersonasActionError,
    PersonasFunctionality,
    inferPersonaNameFromPath,
    parsePersonaDefinitionObject,
    servicePersonas,
    type PersonaSourceSeam,
} from "./index.ts";

const url = (raw: string, hostname: string | null, pathname: string): ParsedPath => ({
    kind: "url",
    raw,
    scheme: "persona",
    username: null,
    password: null,
    hostname,
    port: null,
    pathname,
    query: null,
    fragment: null,
});

describe("@plurnk/plurnk-personas", () => {
    const createFixture = async (
        t: TestContext,
        options: {
            readonly headless?: boolean;
            readonly persistedState?: unknown;
            readonly env?: NodeJS.ProcessEnv;
        } = {},
    ) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-personas-mod-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const home = join(root, "home");
        const project = join(root, "project");
        const xdgPlurnk = join(root, "xdg-plurnk");
        const xdgAgents = join(root, "xdg-agents");
        const homeAgents = join(home, ".agents");
        await mkdir(home, { recursive: true });
        await mkdir(project, { recursive: true });
        await mkdir(xdgPlurnk, { recursive: true });
        await mkdir(xdgAgents, { recursive: true });
        await mkdir(homeAgents, { recursive: true });

        let moduleState: unknown = options.persistedState ?? null;
        const seam: PersonaSourceSeam = {
            workspacePaths: async () => ({
                home,
                projectRoot: options.headless === true ? null : project,
                configurationRoots: [
                    ...(options.headless === true ? [] : [{ scope: "project", directory: join(project, ".agents") }]),
                    { scope: "plurnk", directory: xdgPlurnk },
                    { scope: "xdg-global", directory: xdgAgents },
                    { scope: "global", directory: homeAgents },
                ],
            }),
            readWorkspaceModuleState: async () => moduleState,
        };
        const functionality = new PersonasFunctionality(
            seam,
            options.env === undefined
                ? { env: { PLURNK_PERSONAS_ENABLED: "1" } }
                : { env: options.env },
        );
        return {
            root,
            home,
            project,
            xdgPlurnk,
            xdgAgents,
            homeAgents,
            seam,
            functionality,
            setModuleState: (next: unknown) => {
                moduleState = next;
            },
        };
    };

    test("{§persona-discovery} barrel and daemon-module factory expose module, family, and contained config diagnostics", async (t) => {
        assert.equal(PERSONAS_FAMILY, "personas");
        assert.equal(PERSONAS_OWNER, "@plurnk/plurnk-personas");
        assert.equal(typeof PersonasBarrel.Module.init, "function");
        assert.equal(typeof createPersonasModule, "function");

        const defaultMod = createPersonasModule();
        assert.deepEqual(defaultMod.contained, []);

        const invalidMod = Module.init({
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_bad: "{broken",
            },
        });
        assert.equal(invalidMod.contained.length, 1);
        assert.equal(invalidMod.contained[0]?.key, "PLURNK_PERSONAS_bad");

        const { seam } = await createFixture(t);
        let registeredSchemeName = "";
        let registeredSource: ResourceTreeSource | null = null;
        const readers: Array<(workspaceId: number) => Promise<readonly unknown[]>> = [];
        const handle: FunctionalityFamilyHandle = {
            invoke: async () => ({ status: 200, body: { family: "personas", definitions: [], offset: 0, total: 0 } }),
            refresh: async () => {},
        };
        const mod = Module.init({
            env: { PLURNK_PERSONAS_ENABLED: "1" },
        });
        await mod.setup({
            ...seam,
            registerFunctionalityAdapter: () => handle,
            registerPersonaReader: (reader) => {
                readers.push(reader);
            },
            registerResourceTreeScheme: async (name, source) => {
                registeredSchemeName = name;
                registeredSource = source;
            },
        });
        assert.equal(registeredSchemeName, "persona");
        assert.ok(registeredSource !== null);
        assert.equal(readers.length, 1);
        assert.deepEqual(await readers[0](1), []);
        await assert.rejects(
            () =>
                mod.setup({
                    ...seam,
                    registerFunctionalityAdapter: () => handle,
                    registerPersonaReader: () => {},
                    registerResourceTreeScheme: async () => {},
                }),
            /personas module already set up/u,
        );
    });

    test("{§persona-discovery} discovers directory and single-file personas across the 4-tier cascade, merges cold workspace state, and isolates malformed files", async (t) => {
        const { project, xdgPlurnk, xdgAgents, homeAgents, functionality, setModuleState } = await createFixture(t);
        const projectAgentsDir = join(project, ".agents", "personas");
        await mkdir(join(projectAgentsDir, "reviewer"), { recursive: true });
        await mkdir(join(xdgPlurnk, "personas"), { recursive: true });
        await mkdir(join(xdgAgents, "personas"), { recursive: true });
        await mkdir(join(homeAgents, "personas"), { recursive: true });

        await writeFile(
            join(projectAgentsDir, "reviewer", "PERSONA.md"),
            "---\nname: reviewer\ndescription: Project reviewer\nmodel: fast\neffort: high\n---\nReview carefully.\n",
        );
        await writeFile(join(projectAgentsDir, "reviewer", "checklist.md"), "# Security\n");
        await writeFile(
            join(projectAgentsDir, "reviewer.md"),
            "---\nname: reviewer\ndescription: Shadowed\n---\nShadowed.\n",
        );
        await writeFile(
            join(projectAgentsDir, "architect.md"),
            "---\nname: architect\ndescription: System architect\neffort: medium\n---\nDesign cleanly.\n",
        );
        await writeFile(
            join(projectAgentsDir, "broken.md"),
            "---\nname: broken\ndescription: Empty body\n---\n   \n",
        );
        await writeFile(
            join(xdgPlurnk, "personas", "operator.md"),
            "---\nname: operator\ndescription: XDG operator\n---\nOperate.\n",
        );
        await writeFile(
            join(xdgAgents, "personas", "researcher.md"),
            "---\nname: researcher\ndescription: XDG researcher\n---\nResearch.\n",
        );
        await writeFile(
            join(homeAgents, "personas", "writer.md"),
            "---\nname: writer\ndescription: Home writer\n---\nWrite.\n",
        );

        setModuleState({
            version: 1,
            definitions: {
                writer: { origin: "service", enabled: false },
                custom: {
                    origin: "workspace",
                    enabled: true,
                    definition: { description: "Custom inline", body: "Act custom." },
                },
            },
        });

        const list = await functionality.read(1);
        assert.deepEqual(
            list.map((p) => p.name),
            ["architect", "custom", "operator", "researcher", "reviewer"],
        );
        assert.equal(functionality.notices(1).length, 1);
        assert.equal(functionality.configurationNotices({ workspaceId: 1 }).length, 1);
        assert.deepEqual(await functionality.trees(1).get("reviewer")?.list(), ["PERSONA.md", "checklist.md"]);
        assert.deepEqual(await functionality.trees(1).get("custom")?.list(), ["PERSONA.md"]);
    });

    test("{§persona-discovery} discover, admit, prepare, publish/undo, hotload refresh, and cold ConfigurationError handling", async (t) => {
        const { root, project, functionality } = await createFixture(t);
        const extDir = join(root, "pack");
        await mkdir(join(extDir, "triage"), { recursive: true });
        await writeFile(
            join(extDir, "triage", "PERSONA.md"),
            "---\nname: triage\ndescription: Issue triager\n---\nTriage issues.\n",
        );
        await writeFile(
            join(extDir, "mentor.md"),
            "---\nname: mentor\ndescription: Code mentor\n---\nMentor engineers.\n",
        );
        await writeFile(
            join(root, "unnamed-single.md"),
            "---\ndescription: Single file without name\n---\nStill valid when targeted directly.\n",
        );
        await writeFile(join(extDir, "invalid.md"), "not frontmatter");

        const fromDir = await functionality.discover({ source: extDir }, { workspaceId: 1 });
        assert.deepEqual(fromDir.map((c) => c.alias), ["mentor", "triage"]);
        const filtered = await functionality.discover({ source: extDir, query: "ment" }, { workspaceId: 1 });
        assert.deepEqual(filtered.map((c) => c.alias), ["mentor"]);

        const fromFile = await functionality.discover({ source: join(root, "unnamed-single.md") }, { workspaceId: 1 });
        assert.equal(fromFile[0]?.alias, "unnamed-single");
        const fromDirectDir = await functionality.discover({ source: join(extDir, "triage") }, { workspaceId: 1 });
        assert.equal(fromDirectDir[0]?.alias, "triage");

        await mkdir(join(root, "empty-pack"), { recursive: true });
        await assert.rejects(
            () => functionality.discover({ source: join(root, "empty-pack") }, { workspaceId: 1 }),
            PersonasActionError,
        );

        // Open discovery over active roots
        await mkdir(join(project, ".agents", "personas"), { recursive: true });
        await writeFile(
            join(project, ".agents", "personas", "helper.md"),
            "---\nname: helper\ndescription: Project helper\n---\nHelp out.\n",
        );
        const openAll = await functionality.discover({}, { workspaceId: 1 });
        assert.deepEqual(openAll.map((c) => c.alias), ["helper"]);
        const openFiltered = await functionality.discover({ query: "nomatch" }, { workspaceId: 1 });
        assert.deepEqual(openFiltered, []);

        // Source-backed directory & file admit + prepare
        const admittedDir = await functionality.admit(
            { alias: "triage", source: join(extDir, "triage"), effort: "medium" },
            { workspaceId: 1 },
        );
        const admittedFile = await functionality.admit(
            { alias: "mentor", source: join(extDir, "mentor.md"), model: "fast" },
            { workspaceId: 1 },
        );
        assert.equal(admittedDir.alias, "triage");
        assert.equal(admittedFile.alias, "mentor");

        await assert.rejects(() => functionality.discover({ source: "   " }, { workspaceId: 1 }), PersonasActionError);
        await assert.rejects(
            () => functionality.discover({ source: join(root, "nope") }, { workspaceId: 1 }),
            PersonasActionError,
        );
        await assert.rejects(
            () => functionality.discover({ source: join(extDir, "invalid.md") }, { workspaceId: 1 }),
            PersonasActionError,
        );

        const admitted = await functionality.admit(
            { alias: "professor", description: "Teacher", body: "Teach from invariants.", effort: "high" },
            { workspaceId: 1 },
        );
        assert.equal(admitted.alias, "professor");

        await assert.rejects(() => functionality.admit({ alias: "BAD!" }, { workspaceId: 1 }), PersonasActionError);
        await assert.rejects(
            () => functionality.admit({ alias: "good", unknown: 1 }, { workspaceId: 1 }),
            PersonasActionError,
        );

        let refreshCalls = 0;
        functionality.attach({
            invoke: async () => ({ status: 200, body: { family: "personas", definitions: [], offset: 0, total: 0 } }),
            refresh: async () => {
                refreshCalls += 1;
            },
        });

        const controller = new AbortController();
        const prepared = await functionality.prepare({
            workspaceId: 1,
            enabled: new Map([
                ["professor", { definition: admitted.definition }],
                ["triage", { definition: admittedDir.definition }],
                ["mentor", { definition: admittedFile.definition }],
                ["missing-src", { definition: { source: join(project, "does-not-exist.md") } }],
            ]),
            previous: null,
            admissions: [],
            failure: "publish-unavailable",
            signal: controller.signal,
            progress: () => {},
            retain: () => () => {},
        });
        assert.equal(prepared.outcomes.get("professor")?.state, "active");
        assert.equal(prepared.outcomes.get("missing-src")?.state, "unavailable");

        const undo = prepared.publish();
        await prepared.commit();
        assert.deepEqual((await functionality.read(1)).map((p) => p.name), ["mentor", "professor", "triage"]);
        assert.equal(refreshCalls, 1);

        undo?.();
        assert.equal(functionality.trees(1).size, 0);
        await functionality.teardown(prepared.snapshot, { workspaceId: 1 });

        await assert.rejects(
            () =>
                functionality.prepare({
                    workspaceId: 1,
                    enabled: new Map([["missing-src", { definition: { source: join(project, "does-not-exist.md") } }]]),
                    previous: null,
                    admissions: [],
                    failure: "reject",
                    signal: controller.signal,
                    progress: () => {},
                    retain: () => () => {},
                }),
            PersonasActionError,
        );

        const headless = await createFixture(t, { headless: true });
        await assert.rejects(
            () => headless.functionality.admit({ alias: "rel", source: "personas/rel.md" }, { workspaceId: 2 }),
            /requires a workspace project root/u,
        );
        await assert.rejects(
            () => headless.functionality.discover({ source: "personas/rel.md" }, { workspaceId: 2 }),
            /requires a workspace project root/u,
        );

        const brokenEnv = await createFixture(t, {
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_broken: "not-json",
            },
        });
        assert.deepEqual(await brokenEnv.functionality.read(3), []);
        assert.equal(brokenEnv.functionality.notices(3)[0]?.kind, "configuration_unavailable");
    });

    test("{§persona-discovery} {§persona-scheme} PersonaScheme normalizes addresses, translates refusals, and executes whole editBatch and origin-aware kill", async () => {
        const invocations: Array<{ verb: string; params: unknown }> = [];
        const definitions = [
            { alias: "local", origin: "workspace" as const, state: "active" as const, definition: { description: "L", body: "B" } },
            { alias: "svc", origin: "service" as const, state: "active" as const, definition: { description: "S", body: "B" } },
            { alias: "off-svc", origin: "service" as const, state: "disabled" as const, definition: { description: "O", body: "B" } },
        ];
        const scheme = new PersonaScheme(
            { trees: () => new Map() },
            async (verb, params) => {
                invocations.push({ verb, params });
                if (verb === "list") return { status: 200, body: { family: "personas", definitions, offset: 0, total: definitions.length } };
                if (verb === "replace" && (params as { alias?: string }).alias === "conflict") {
                    const problem = Problems.create("personas:functionality", "conflict", 409, "Conflict.");
                    throw Object.assign(new Error(problem.detail), { problem });
                }
                return { status: 200 };
            },
        );

        assert.deepEqual(
            scheme.normalizeAddress(url("persona://professor/PERSONA.md", "professor", "/PERSONA.md")),
            { authority: "professor", pathname: "/PERSONA.md" },
        );
        assert.deepEqual(
            scheme.normalizeAddress(url("persona://professor.md", "professor.md", "")),
            { authority: "professor", pathname: "/PERSONA.md" },
        );
        assert.deepEqual(
            scheme.normalizeAddress(url("persona:///professor/refs/a.md", null, "/professor/refs/a.md")),
            { authority: "professor", pathname: "/refs/a.md" },
        );
        assert.deepEqual(
            scheme.normalizeAddress(url("persona:///professor", null, "/professor")),
            { authority: "professor", pathname: "/PERSONA.md" },
        );
        assert.deepEqual(
            scheme.normalizeAddress(url("persona:///", null, "/"), { forFind: true }),
            { authority: "*", pathname: "/" },
        );

        assert.equal(
            PersonasFunctionality.refusal({ code: "ENOENT" }, { authority: "p", pathname: "/PERSONA.md" })?.status,
            404,
        );
        assert.equal(
            PersonasFunctionality.refusal(
                new SkillResourceError("SKILL_PATH_OUTSIDE_ROOT", "Escape."),
                { authority: "p", pathname: "/../x" },
            )?.status,
            403,
        );
        assert.equal(
            PersonasFunctionality.refusal(
                new SkillResourceError("SKILL_RESOURCE_NOT_FILE", "Dir."),
                { authority: "p", pathname: "/d" },
            )?.status,
            400,
        );
        assert.equal(PersonasFunctionality.refusal(new Error("boom"), { authority: "p", pathname: "/x" }), null);

        const deleted: string[] = [];
        const ctx = {
            workspaceId: 1,
            sessionId: 2,
            entries: {
                delete: async (pathname: string) => {
                    deleted.push(pathname);
                    return { status: 200 };
                },
            },
        } as unknown as SchemeCtx;

        const edit = (target: ParsedPath | null, body: string | null, scoped = false): ResolvedEditStatement => ({
            op: "edit",
            headers: null,
            aside: null,
            target,
            lineMarker: scoped ? { marks: [1, 2] } : null,
            matcher: null,
            body,
            position: UNKNOWN_POSITION,
        });

        assert.equal((await scheme.editBatch([], ctx)).status, 400);
        assert.equal((await scheme.editBatch([edit(url("persona://local/PERSONA.md", "local", "/PERSONA.md"), "x", true)], ctx)).status, 400);
        assert.equal((await scheme.editBatch([edit(url("persona://BAD!/PERSONA.md", "BAD!", "/PERSONA.md"), "x")], ctx)).status, 400);
        assert.equal((await scheme.editBatch([edit(url("persona://local/PERSONA.md", "local", "/PERSONA.md"), "   ")], ctx)).status, 400);

        const mdEdit = await scheme.editBatch(
            [edit(url("persona://local.md", "local.md", ""), "---\ndescription: Updated\neffort: high\n---\nBody.\n")],
            ctx,
        );
        assert.deepEqual(mdEdit, { status: 200 });
        assert.deepEqual(invocations.at(-1), {
            verb: "replace",
            params: { alias: "local", description: "Updated", body: "Body.", effort: "high" },
        });
        assert.deepEqual(deleted, ["/PERSONA.md"]);

        const conflictEdit = await scheme.editBatch(
            [edit(url("persona://conflict.md", "conflict.md", ""), JSON.stringify({ description: "C", body: "B" }))],
            ctx,
        );
        assert.equal(conflictEdit.status, 409);

        const kill = (target: ParsedPath | null, scoped = false): KillStatement => ({
            op: "kill",
            headers: null,
            remote: null,
            aside: null,
            target,
            lineMarker: scoped ? { marks: [1, 2] } : null,
            matcher: null,
            body: null,
            position: UNKNOWN_POSITION,
        });

        assert.equal((await scheme.kill(kill(url("persona://local/PERSONA.md", "local", "/PERSONA.md"), true), ctx)).status, 400);
        assert.equal((await scheme.kill(kill(null), ctx)).status, 400);
        assert.equal((await scheme.kill(kill(url("persona://unknown/PERSONA.md", "unknown", "/PERSONA.md")), ctx)).status, 404);
        assert.equal((await scheme.kill(kill(url("persona://off-svc/PERSONA.md", "off-svc", "/PERSONA.md")), ctx)).status, 404);

        assert.deepEqual(await scheme.kill(kill(url("persona://local/PERSONA.md", "local", "/PERSONA.md")), ctx), { status: 200 });
        assert.deepEqual(invocations.at(-1), { verb: "remove", params: { alias: "local" } });

        assert.deepEqual(await scheme.kill(kill(url("persona://svc/PERSONA.md", "svc", "/PERSONA.md")), ctx), { status: 200 });
        assert.deepEqual(invocations.at(-1), { verb: "disable", params: { alias: "svc" } });

        // Additional definition edge cases
        assert.equal(inferPersonaNameFromPath("/a/triage/PERSONA.md", "no-yaml"), "triage");
        assert.equal(inferPersonaNameFromPath("/a/mentor.md", "no-yaml"), "mentor");
        assert.throws(() => parsePersonaDefinitionObject(null), /must be a JSON object/u);
        assert.throws(() => parsePersonaDefinitionObject({ source: "/a", model: "  " }), /non-empty string/u);
        assert.throws(() => parsePersonaDefinitionObject({ source: "/a", effort: "bogus" }), /must be one of/u);
        assert.equal(
            servicePersonas({
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_code_reviewer: JSON.stringify({ source: "/srv/r", model: "fast" }),
                PLURNK_PERSONAS_code_reviewer_ENABLED: "0",
            })[0]?.enabled,
            false,
        );
    });

    test("{§persona-discovery} cold-workspace reads LRU-evict beyond the cache cap without disturbing active snapshots", async (t) => {
        const { project, functionality } = await createFixture(t);
        const projectAgentsDir = join(project, ".agents", "personas");
        await mkdir(projectAgentsDir, { recursive: true });
        await writeFile(
            join(projectAgentsDir, "helper.md"),
            "---\nname: helper\ndescription: Helper persona\n---\nHelp.\n",
        );

        // Publish an active snapshot for workspace 100.
        const admitted = await functionality.admit(
            { alias: "active-one", description: "Active", body: "Active body." },
            { workspaceId: 100 },
        );
        const prepared = await functionality.prepare({
            workspaceId: 100,
            enabled: new Map([["active-one", { definition: admitted.definition }]]),
            previous: null,
            admissions: [],
            failure: "reject",
            signal: new AbortController().signal,
            progress: () => {},
            retain: () => () => {},
        });
        prepared.publish();
        await prepared.commit();
        assert.equal(functionality.trees(100).has("active-one"), true);

        // Cold-read 20 distinct workspaces (exceeding COLD_WORKSPACE_CACHE_LIMIT = 16).
        for (let ws = 1; ws <= 20; ws += 1) {
            await functionality.read(ws);
        }
        assert.equal(functionality.trees(1).size, 0, "oldest cold workspace was LRU-evicted");
        assert.equal(functionality.trees(4).size, 0, "fourth cold workspace was LRU-evicted");
        assert.equal(functionality.trees(5).size, 1, "fifth cold workspace remains inside the 16-workspace window");
        assert.equal(functionality.trees(20).size, 1, "most recent cold workspace remains cached");
        assert.equal(functionality.trees(100).has("active-one"), true, "active published snapshot is never evicted by cold reads");

        await functionality.teardown(prepared.snapshot, { workspaceId: 100 });
        assert.equal(functionality.trees(100).size, 0, "teardown clears the active workspace snapshot");
    });
});
