import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { UNKNOWN_POSITION, type ParsedPath, type ProjectRootConfinement } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement, SchemeCtx } from "@plurnk/plurnk-schemes";
import {
    PersonaScheme,
    PersonasActionError,
    PersonasFunctionality,
    type PersonaDefinition,
    type PersonaSourceSeam,
} from "./index.ts";

const makeFixture = async (
    t: TestContext,
    options: {
        readonly env?: NodeJS.ProcessEnv;
        readonly confinement: ProjectRootConfinement;
        readonly headless?: boolean;
        readonly persistedState?: unknown;
    },
) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-personas-confine-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const project = join(root, "project");
    const outside = join(root, "outside");
    const xdgPlurnk = join(root, "xdg-plurnk");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(xdgPlurnk, { recursive: true });

    let moduleState: unknown = options.persistedState ?? null;
    const seam: PersonaSourceSeam = {
        workspacePaths: async () => ({
            home,
            projectRoot: options.headless === true ? null : project,
            projectRootConfinement: options.confinement,
            configurationRoots: [
                ...(options.headless === true ? [] : [{ scope: "project", directory: join(project, ".agents") }]),
                { scope: "plurnk", directory: xdgPlurnk },
            ],
        }),
        readWorkspaceModuleState: async () => moduleState,
    };
    const functionality = new PersonasFunctionality(seam, {
        env: options.env ?? { PLURNK_PERSONAS_ENABLED: "1" },
    });
    return {
        root,
        project,
        outside,
        xdgPlurnk,
        seam,
        functionality,
        setModuleState: (next: unknown) => {
            moduleState = next;
        },
    };
};

const personaUrl = (raw: string, hostname: string, pathname: string): ParsedPath => ({
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

describe("@plurnk/plurnk-personas project-root confinement", () => {
    test("{§persona-discovery} {§persona-scheme} confined mode admits project-local persona files and directories while blocking escapes, symlinks, tilde paths, and folderless local sources without an existence oracle", async (t) => {
        const { project, outside, functionality } = await makeFixture(t, { confinement: "confined" });

        // Safe in-project personas (single file and directory)
        await mkdir(join(project, "team-personas", "reviewer"), { recursive: true });
        const inProjectFile = join(project, "team-personas", "architect.md");
        const inProjectDir = join(project, "team-personas", "reviewer");
        await writeFile(inProjectFile, "---\nname: architect\ndescription: Project architect\n---\nDesign carefully.\n");
        await writeFile(join(inProjectDir, "PERSONA.md"), "---\nname: reviewer\ndescription: Project reviewer\n---\nReview strictly.\n");

        // External host targets outside projectRoot
        const existingOutside = join(outside, "secret.md");
        const missingOutside = join(outside, "does-not-exist.md");
        await writeFile(existingOutside, "---\nname: secret\ndescription: Host secret\n---\nSecret body.\n");

        // Escaping symlinks inside projectRoot (live, dangling, and inner PERSONA.md)
        await symlink(existingOutside, join(project, "team-personas", "escaped-file.md"));
        await symlink(missingOutside, join(project, "team-personas", "dangling-escape.md"));
        await mkdir(join(project, "team-personas", "inner-escape"), { recursive: true });
        await symlink(existingOutside, join(project, "team-personas", "inner-escape", "PERSONA.md"));

        // 1. In-project relative and absolute sources work cleanly in discover and admit
        const discoveredDir = await functionality.discover({ source: "team-personas" }, { workspaceId: 1 });
        assert.deepEqual(
            discoveredDir.map((c) => c.alias ?? "").toSorted((a, b) => a.localeCompare(b)),
            ["architect", "reviewer"],
            "directory discovery inside projectRoot returns in-project personas and omits escaping symlinks",
        );

        const admittedRel = await functionality.admit({ alias: "architect", source: "team-personas/architect.md" }, { workspaceId: 1 });
        assert.equal(admittedRel.alias, "architect");
        const admittedAbs = await functionality.admit({ alias: "reviewer", source: inProjectDir }, { workspaceId: 1 });
        assert.equal(admittedAbs.alias, "reviewer");

        // 2. Existing outside, missing outside, traversal, tilde, live symlink, dangling symlink, and escaping PERSONA.md
        //    all fail with identical 403 persona-source-forbidden (no existence oracle).
        const blockedSources = [
            existingOutside,
            missingOutside,
            "../outside/secret.md",
            "~/secret.md",
            "team-personas/escaped-file.md",
            "team-personas/dangling-escape.md",
            "team-personas/inner-escape",
        ];
        const discoverErrors: Array<{ status: number; type: string; detail: string }> = [];
        for (const source of blockedSources) {
            await assert.rejects(
                () => functionality.discover({ source }, { workspaceId: 1 }),
                (err: unknown) => {
                    if (!(err instanceof PersonasActionError)) return false;
                    discoverErrors.push({ status: err.problem.status, type: err.problem.type, detail: err.problem.detail });
                    return err.problem.status === 403 && err.problem.type.endsWith("/persona-source-forbidden");
                },
            );
            await assert.rejects(
                () => functionality.admit({ alias: "leak", source }, { workspaceId: 1 }),
                (err: unknown) =>
                    err instanceof PersonasActionError
                    && err.problem.status === 403
                    && err.problem.type.endsWith("/persona-source-forbidden"),
            );
        }
        assert.equal(
            new Set(discoverErrors.map((e) => `${e.status}|${e.type}|${e.detail}`)).size,
            1,
            "existing, missing, traversal, tilde, and symlink escape refusals must be indistinguishable (no existence oracle)",
        );

        // 3. PersonaScheme.editBatch admits in-project JSON { source } and inline Markdown while refusing escaping { source }
        const scheme = new PersonaScheme(
            functionality,
            async (_verb, params, identity) => {
                await functionality.admit(params, identity);
                return { status: 200 };
            },
        );
        const ctx = {
            workspaceId: 1,
            sessionId: 1,
            entries: { delete: async () => ({ status: 200 }) },
        } as unknown as SchemeCtx;
        const makeEdit = (body: string): ResolvedEditStatement => ({
            op: "edit",
            headers: null,
            aside: null,
            target: personaUrl("persona://probe/PERSONA.md", "probe", "/PERSONA.md"),
            lineMarker: null,
            matcher: null,
            body,
            position: UNKNOWN_POSITION,
        });

        const blockedJsonEdit = await scheme.editBatch([makeEdit(JSON.stringify({ source: existingOutside }))], ctx);
        assert.equal(blockedJsonEdit.status, 403);
        assert.equal(blockedJsonEdit.problem?.type.endsWith("/persona-source-forbidden"), true);

        const okProjectEdit = await scheme.editBatch([{
            ...makeEdit(JSON.stringify({ source: "team-personas/architect.md" })),
            target: personaUrl("persona://architect/PERSONA.md", "architect", "/PERSONA.md"),
        }], ctx);
        assert.equal(okProjectEdit.status, 200);

        const okMarkdownEdit = await scheme.editBatch(
            [makeEdit("---\ndescription: Safe inline\n---\nWork cleanly.\n")],
            ctx,
        );
        assert.equal(okMarkdownEdit.status, 200);

        // 4. Folderless workspace under confined mode refuses local sources and allows inline personas
        const headless = await makeFixture(t, { confinement: "confined", headless: true });
        await assert.rejects(
            () => headless.functionality.admit({ alias: "leak", source: existingOutside }, { workspaceId: 2 }),
            (err: unknown) =>
                err instanceof PersonasActionError
                && err.problem.status === 403
                && err.problem.type.endsWith("/persona-source-forbidden"),
        );
        const inline = await headless.functionality.admit(
            { alias: "helper", description: "Inline helper", body: "Assist cleanly." },
            { workspaceId: 2 },
        );
        assert.equal(inline.alias, "helper");
    });

    test("{§persona-discovery} none mode refuses all non-exempt local workspace persona sources before disk I/O while allowing inline and operator personas", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-personas-none-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const opFile = join(root, "ops.md");
        await writeFile(opFile, "---\nname: ops\ndescription: Operator persona\n---\nOperator instructions.\n");

        const { outside, functionality } = await makeFixture(t, {
            confinement: "none",
            headless: true,
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_ops: JSON.stringify({ source: opFile }),
            },
        });
        const existing = join(outside, "existing.md");
        await writeFile(existing, "---\nname: existing\ndescription: Existing\n---\nBody.\n");

        for (const source of [existing, join(outside, "missing.md"), "relative.md", "   "]) {
            await assert.rejects(
                () => functionality.discover({ source }, { workspaceId: 1 }),
                (err: unknown) =>
                    err instanceof PersonasActionError
                    && err.problem.status === 403
                    && err.problem.type.endsWith("/persona-source-forbidden"),
            );
        }
        await assert.rejects(
            () => functionality.admit({ alias: "leak", source: existing }, { workspaceId: 1 }),
            (err: unknown) =>
                err instanceof PersonasActionError
                && err.problem.status === 403
                && err.problem.type.endsWith("/persona-source-forbidden"),
        );
        const inline = await functionality.admit(
            { alias: "helper", description: "Inline", body: "Inline body." },
            { workspaceId: 1 },
        );
        assert.equal(inline.alias, "helper");
        const loaded = await functionality.read(1);
        assert.deepEqual(loaded.map((p) => p.name), ["ops"]);
    });

    test("{§persona-discovery} operator env definitions and configured roots remain exempt under confined mode while persisted out-of-root workspace sources and alias-shadowing overrides are refused in prepare and cold read", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-personas-exempt-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const opFile = join(root, "ops.md");
        const wsEvilFile = join(root, "ws-evil.md");
        await writeFile(opFile, "---\nname: ops\ndescription: Operator persona\n---\nOperator instructions.\n");
        await writeFile(wsEvilFile, "---\nname: evil\ndescription: Persisted outside workspace file\n---\nShould not load.\n");

        const { project, xdgPlurnk, functionality, setModuleState } = await makeFixture(t, {
            confinement: "confined",
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_ops: JSON.stringify({ source: opFile }),
            },
        });
        await mkdir(join(xdgPlurnk, "personas"), { recursive: true });
        await writeFile(
            join(xdgPlurnk, "personas", "rooted.md"),
            "---\nname: rooted\ndescription: Configured root persona\n---\nRooted instructions.\n",
        );
        const inProjectFile = join(project, "local-ok.md");
        await writeFile(inProjectFile, "---\nname: local-ok\ndescription: Project persona\n---\nIn-project instructions.\n");

        const available = await functionality.available({ workspaceId: 1 });
        assert.deepEqual(available.map((item) => item.alias).toSorted(), ["ops", "rooted"]);

        const opDef = available.find((item) => item.alias === "ops")!.definition;
        const rootDef = available.find((item) => item.alias === "rooted")!.definition;
        const inlineDef: PersonaDefinition = { description: "Inline", body: "Inline instructions." };

        const controller = new AbortController();
        const prepared = await functionality.prepare({
            workspaceId: 1,
            enabled: new Map<string, { readonly definition: PersonaDefinition }>([
                ["ops", { definition: opDef }],
                ["rooted", { definition: rootDef }],
                ["inline", { definition: inlineDef }],
                ["local-ok", { definition: { source: "local-ok.md" } }],
                ["persisted-evil", { definition: { source: wsEvilFile } }],
            ]),
            previous: null,
            admissions: [],
            failure: "publish-unavailable",
            signal: controller.signal,
            progress: () => {},
            retain: () => () => {},
        });
        assert.equal(prepared.outcomes.get("ops")?.state, "active");
        assert.equal(prepared.outcomes.get("rooted")?.state, "active");
        assert.equal(prepared.outcomes.get("inline")?.state, "active");
        assert.equal(prepared.outcomes.get("local-ok")?.state, "active");
        const evilOutcome = prepared.outcomes.get("persisted-evil");
        assert.equal(evilOutcome?.state, "unavailable");
        if (evilOutcome?.state === "unavailable") {
            assert.equal(evilOutcome.problem.status, 403);
            assert.equal(evilOutcome.problem.type.endsWith("/persona-source-forbidden"), true);
        }

        // Shadowing an operator alias with an out-of-root workspace { source } does NOT inherit exemption.
        await assert.rejects(
            () => functionality.prepare({
                workspaceId: 1,
                enabled: new Map<string, { readonly definition: PersonaDefinition }>([
                    ["ops", { definition: { source: wsEvilFile } }],
                ]),
                previous: null,
                admissions: [],
                failure: "reject",
                signal: controller.signal,
                progress: () => {},
                retain: () => () => {},
            }),
            (err: unknown) =>
                err instanceof PersonasActionError
                && err.problem.status === 403
                && err.problem.type.endsWith("/persona-source-forbidden"),
        );

        // Cold read() admits operator/root/inline/in-project and blocks out-of-root persisted workspace definitions.
        setModuleState({
            version: 1,
            definitions: {
                "persisted-evil": { origin: "workspace", enabled: true, definition: { source: wsEvilFile } },
                "local-ok": { origin: "workspace", enabled: true, definition: { source: "local-ok.md" } },
                "persisted-inline": { origin: "workspace", enabled: true, definition: inlineDef },
                ops: { origin: "workspace", enabled: true, definition: { source: wsEvilFile } },
            },
        });
        const cold = await functionality.read(2);
        assert.deepEqual(cold.map((p) => p.name), ["local-ok", "persisted-inline", "rooted"]);
        assert.ok(
            functionality.notices(2).some((n) => n.message?.includes("outside the workspace project root") ?? false),
            "cold read emits warn notices for refused out-of-root workspace definitions",
        );
    });

    test("{§persona-discovery} project-root .agents/personas scan enforces physical realpath containment inside projectRoot", async (t) => {
        const { project, outside, functionality } = await makeFixture(t, { confinement: "confined" });
        const personasDir = join(project, ".agents", "personas");
        await mkdir(join(personasDir, "safe-dir"), { recursive: true });
        await writeFile(
            join(personasDir, "safe-dir", "PERSONA.md"),
            "---\nname: safe-dir\ndescription: In-project directory persona\n---\nSafe dir.\n",
        );
        await writeFile(
            join(personasDir, "safe-file.md"),
            "---\nname: safe-file\ndescription: In-project file persona\n---\nSafe file.\n",
        );

        const extDir = join(outside, "escaped-dir");
        await mkdir(extDir, { recursive: true });
        await writeFile(join(extDir, "PERSONA.md"), "---\nname: escaped-dir\ndescription: Escaped dir\n---\nLeaked dir.\n");
        const extFile = join(outside, "escaped-file.md");
        await writeFile(extFile, "---\nname: escaped-file\ndescription: Escaped file\n---\nLeaked file.\n");
        const extInnerFile = join(outside, "inner-escape.md");
        await writeFile(extInnerFile, "---\nname: inner-escape\ndescription: Escaped PERSONA.md\n---\nLeaked inner.\n");

        await symlink(extDir, join(personasDir, "escaped-dir"));
        await symlink(extFile, join(personasDir, "escaped-file.md"));
        await mkdir(join(personasDir, "inner-escape"), { recursive: true });
        await symlink(extInnerFile, join(personasDir, "inner-escape", "PERSONA.md"));

        const discovered = await functionality.available({ workspaceId: 1 });
        assert.deepEqual(discovered.map((item) => item.alias).toSorted(), ["safe-dir", "safe-file"]);
        const loaded = await functionality.read(1);
        assert.deepEqual(loaded.map((p) => p.name), ["safe-dir", "safe-file"]);
        assert.equal(functionality.notices(1).length, 0, "symlink escapes are silently omitted without leaking host paths");
    });
});
