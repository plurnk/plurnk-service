import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { UNKNOWN_POSITION, type ParsedPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement, SchemeCtx } from "@plurnk/plurnk-schemes";
import {
    Module,
    PersonaScheme,
    PersonasActionError,
    PersonasFunctionality,
    allowLocalSources,
    personasPolicy,
    type PersonaDefinition,
    type PersonaSourceSeam,
} from "./index.ts";

const makeFixture = async (
    t: TestContext,
    options: {
        readonly env: NodeJS.ProcessEnv;
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
            configurationRoots: [
                ...(options.headless === true ? [] : [{ scope: "project", directory: join(project, ".agents") }]),
                { scope: "plurnk", directory: xdgPlurnk },
            ],
        }),
        readWorkspaceModuleState: async () => moduleState,
    };
    const functionality = new PersonasFunctionality(seam, { env: options.env });
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

describe("@plurnk/plurnk-personas confinement", () => {
    test("{§persona-discovery} allowLocalSources and personasPolicy validate boolean control and fail closed on malformed values", () => {
        assert.equal(allowLocalSources({ PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "1" }), true);
        assert.equal(allowLocalSources({ PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "0" }), false);
        assert.deepEqual(personasPolicy({ PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "0" }), { allowLocalSources: false });

        assert.throws(
            () => allowLocalSources({ PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "maybe" }),
            (err: unknown) => err instanceof ConfigurationError && err.key === "PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES",
        );

        const invalidMod = Module.init({
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "maybe",
            },
        });
        assert.equal(invalidMod.contained.length, 1);
        assert.equal(invalidMod.contained[0]?.key, "PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES");
    });

    test("{§persona-discovery} {§persona-scheme} PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES=0 blocks workspace discover/admit/edit source paths without an existence oracle while allowing inline personas", async (t) => {
        const { outside, functionality } = await makeFixture(t, {
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "0",
            },
        });
        assert.deepEqual(functionality.policy(), { allowLocalSources: false });

        const existingFile = join(outside, "secret.md");
        const missingFile = join(outside, "does-not-exist.md");
        await writeFile(existingFile, "---\nname: secret\ndescription: Host secret\n---\nSecret body.\n");

        // Discover must refuse existing, non-existent, relative, and empty sources with identical 403 before disk I/O.
        const discoverErrors: Array<{ status: number; type: string; detail: string }> = [];
        for (const source of [existingFile, missingFile, "relative/persona.md", "   "]) {
            await assert.rejects(
                () => functionality.discover({ source }, { workspaceId: 1 }),
                (err: unknown) => {
                    if (!(err instanceof PersonasActionError)) return false;
                    discoverErrors.push({
                        status: err.problem.status,
                        type: err.problem.type,
                        detail: err.problem.detail,
                    });
                    return err.problem.status === 403 && err.problem.type.endsWith("/persona-source-forbidden");
                },
            );
        }
        assert.equal(
            new Set(discoverErrors.map((e) => `${e.status}|${e.type}|${e.detail}`)).size,
            1,
            "existing, missing, relative, and empty source refusals must be indistinguishable (no existence oracle)",
        );

        // Admit must refuse workspace { source } (existing or missing) before disk I/O.
        for (const source of [existingFile, missingFile]) {
            await assert.rejects(
                () => functionality.admit({ alias: "leak", source }, { workspaceId: 1 }),
                (err: unknown) =>
                    err instanceof PersonasActionError
                    && err.problem.status === 403
                    && err.problem.type.endsWith("/persona-source-forbidden"),
            );
        }

        // Inline personas remain admitted and active.
        const inline = await functionality.admit(
            { alias: "helper", description: "Inline helper", body: "Assist cleanly." },
            { workspaceId: 1 },
        );
        assert.equal(inline.alias, "helper");

        // PersonaScheme.editBatch forwarding to admit refuses JSON { source } and accepts inline Markdown.
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

        const blockedJsonEdit = await scheme.editBatch([makeEdit(JSON.stringify({ source: existingFile }))], ctx);
        assert.equal(blockedJsonEdit.status, 403);
        assert.equal(blockedJsonEdit.problem?.type.endsWith("/persona-source-forbidden"), true);

        const okMarkdownEdit = await scheme.editBatch(
            [makeEdit("---\ndescription: Safe inline\n---\nWork cleanly.\n")],
            ctx,
        );
        assert.equal(okMarkdownEdit.status, 200);
    });

    test("{§persona-discovery} operator env definitions and configured roots remain exempt under PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES=0 while workspace source overrides and persisted workspace sources are refused in prepare and cold read", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-personas-exempt-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const opFile = join(root, "ops.md");
        const wsFile = join(root, "ws-evil.md");
        await writeFile(opFile, "---\nname: ops\ndescription: Operator persona\n---\nOperator instructions.\n");
        await writeFile(wsFile, "---\nname: evil\ndescription: Persisted workspace file\n---\nShould not load.\n");

        const env: NodeJS.ProcessEnv = {
            PLURNK_PERSONAS_ENABLED: "1",
            PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "0",
            PLURNK_PERSONAS_ops: JSON.stringify({ source: opFile }),
        };
        const { xdgPlurnk, functionality, setModuleState } = await makeFixture(t, { env });
        await mkdir(join(xdgPlurnk, "personas"), { recursive: true });
        await writeFile(
            join(xdgPlurnk, "personas", "rooted.md"),
            "---\nname: rooted\ndescription: Configured root persona\n---\nRooted instructions.\n",
        );

        // Open discovery and available() expose operator and configured-root personas.
        const available = await functionality.available({ workspaceId: 1 });
        assert.deepEqual(available.map((item) => item.alias).toSorted(), ["ops", "rooted"]);
        const open = await functionality.discover({}, { workspaceId: 1 });
        assert.deepEqual(open.map((c) => c.alias ?? "").toSorted((a, b) => a.localeCompare(b)), ["ops", "rooted"]);

        const opDef = available.find((item) => item.alias === "ops")!.definition;
        const rootDef = available.find((item) => item.alias === "rooted")!.definition;
        const inlineDef: PersonaDefinition = { description: "Inline", body: "Inline instructions." };

        // prepare() admits exact operator/root definitions + inline, and rejects workspace { source } and shadowed alias override.
        const controller = new AbortController();
        const prepared = await functionality.prepare({
            workspaceId: 1,
            enabled: new Map<string, { readonly definition: PersonaDefinition }>([
                ["ops", { definition: opDef }],
                ["rooted", { definition: rootDef }],
                ["inline", { definition: inlineDef }],
                ["persisted-evil", { definition: { source: wsFile } }],
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
        const evilOutcome = prepared.outcomes.get("persisted-evil");
        assert.equal(evilOutcome?.state, "unavailable");
        if (evilOutcome?.state === "unavailable") {
            assert.equal(evilOutcome.problem.status, 403);
            assert.equal(evilOutcome.problem.type.endsWith("/persona-source-forbidden"), true);
        }

        // Workspace override shadowing an operator alias with a different { source } is NOT exempt.
        await assert.rejects(
            () => functionality.prepare({
                workspaceId: 1,
                enabled: new Map<string, { readonly definition: PersonaDefinition }>([
                    ["ops", { definition: { source: wsFile } }],
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

        // Cold read() also preserves operator/root/inline and blocks persisted workspace { source } definitions.
        setModuleState({
            version: 1,
            definitions: {
                "persisted-evil": { origin: "workspace", enabled: true, definition: { source: wsFile } },
                "persisted-inline": { origin: "workspace", enabled: true, definition: inlineDef },
                ops: { origin: "workspace", enabled: true, definition: { source: wsFile } },
            },
        });
        const cold = await functionality.read(2);
        assert.deepEqual(cold.map((p) => p.name), ["persisted-inline", "rooted"]);
        assert.ok(
            functionality.notices(2).some((n) => n.message?.includes("Local filesystem persona sources are disabled") ?? false),
            "cold read emits warn notices for refused persisted workspace source definitions",
        );
    });

    test("{§persona-discovery} malformed PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES fails closed across policy, discover, admit, and cold read", async (t) => {
        const { outside, functionality } = await makeFixture(t, {
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "invalid",
            },
        });
        assert.deepEqual(functionality.policy(), { allowLocalSources: false });

        await assert.rejects(
            () => functionality.discover({ source: outside }, { workspaceId: 1 }),
            (err: unknown) =>
                err instanceof PersonasActionError
                && err.problem.status === 503
                && err.problem.type.endsWith("/configuration-invalid"),
        );
        await assert.rejects(
            () => functionality.admit({ alias: "bad", source: outside }, { workspaceId: 1 }),
            (err: unknown) =>
                err instanceof PersonasActionError
                && err.problem.status === 503
                && err.problem.type.endsWith("/configuration-invalid"),
        );
        assert.deepEqual(await functionality.read(1), []);
        assert.equal(functionality.notices(1)[0]?.kind, "configuration_unavailable");
    });

    test("{§persona-discovery} project-root .agents/personas scan enforces physical realpath containment inside projectRoot", async (t) => {
        const { project, outside, functionality } = await makeFixture(t, {
            env: {
                PLURNK_PERSONAS_ENABLED: "1",
                PLURNK_PERSONAS_ALLOW_LOCAL_SOURCES: "0",
            },
        });
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

        // External targets outside projectRoot.
        const extDir = join(outside, "escaped-dir");
        await mkdir(extDir, { recursive: true });
        await writeFile(
            join(extDir, "PERSONA.md"),
            "---\nname: escaped-dir\ndescription: Escaped dir\n---\nLeaked dir.\n",
        );
        const extFile = join(outside, "escaped-file.md");
        await writeFile(
            extFile,
            "---\nname: escaped-file\ndescription: Escaped file\n---\nLeaked file.\n",
        );
        const extInnerFile = join(outside, "inner-escape.md");
        await writeFile(
            extInnerFile,
            "---\nname: inner-escape\ndescription: Escaped PERSONA.md\n---\nLeaked inner.\n",
        );

        // 1. Directory symlink escaping projectRoot
        await symlink(extDir, join(personasDir, "escaped-dir"));
        // 2. Single-file symlink escaping projectRoot
        await symlink(extFile, join(personasDir, "escaped-file.md"));
        // 3. In-project directory whose PERSONA.md symlinks outside projectRoot
        await mkdir(join(personasDir, "inner-escape"), { recursive: true });
        await symlink(extInnerFile, join(personasDir, "inner-escape", "PERSONA.md"));

        const discovered = await functionality.available({ workspaceId: 1 });
        assert.deepEqual(discovered.map((item) => item.alias).toSorted(), ["safe-dir", "safe-file"]);
        const loaded = await functionality.read(1);
        assert.deepEqual(loaded.map((p) => p.name), ["safe-dir", "safe-file"]);
        assert.equal(functionality.notices(1).length, 0, "symlink escapes are silently omitted without leaking host paths");
    });
});
