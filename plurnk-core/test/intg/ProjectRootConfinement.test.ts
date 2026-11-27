import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { Module as PersonasModule } from "@plurnk/plurnk-personas";
import { Module as SkillsModule } from "@plurnk/plurnk-skills";
import Daemon from "../../src/server/Daemon.ts";
import ConfigPolicy from "../../src/core/ConfigPolicy.ts";
import GitMembership from "../../src/core/git-membership.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { PROJECT_ROOT_BASE_KEY } from "../../src/core/ProjectRootPolicy.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import File from "../../src/schemes/File.ts";
import { insertSession, insertWorkspace, openMigrated, rootWorkspace } from "./_db.ts";
import { MCP_CONTROLS } from "./_mcp-config.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

const execFileP = promisify(execFile);

const withEnv = async (overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        await run();
    } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const isProblem = (error: unknown, status: number, code: string): error is OperationFailureError =>
    error instanceof OperationFailureError
    && error.result.status === status
    && (error.result.problem?.type.endsWith(`/${code}`) ?? false);

const defaultConfigPolicy = () => {
    const allowlist = [...ConfigPolicy.parseAllowlist()];
    return { allowlist, writable: allowlist.length > 0 };
};

describe("ProjectRootConfinement", () => {
    test("{§operator-config-workspace-settings} unrestricted default preserves rooted workspaces, outside-root members, and namespace file creation", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-confinement-unrestricted-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const wsDir = join(scratch, "ws-a");
        const siblingDir = join(scratch, "ws-b");
        await mkdir(wsDir, { recursive: true });
        await mkdir(siblingDir, { recursive: true });
        await writeFile(join(siblingDir, "shared.txt"), "shared\n");

        await withEnv({
            [PROJECT_ROOT_BASE_KEY]: "",
            PLURNK_SERVICE_FILE_CREATE_SCOPE: "namespace",
            PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace",
        }, async () => {
            const db = await openMigrated();
            const daemon = new Daemon({ db, provider: null });
            await daemon.start();
            t.after(() => daemon.stop());

            assert.deepEqual(daemon.daemonPolicy(), {
                projectRoot: "unrestricted",
                families: ["env", "mcp", "members", "personas", "schedule", "skills"],
                familyScopes: {
                    env: ["service", "workspace", "session"],
                    mcp: ["service", "workspace"],
                    members: ["workspace"],
                    personas: ["service", "workspace"],
                    schedule: ["workspace"],
                    skills: ["service", "workspace"],
                },
                config: defaultConfigPolicy(),
                mcp: { workspaceTransports: ["stdio", "streamable-http"], publicOnly: false },
                skills: { workspaceSources: ["mcp", "git", "local"], publicOnly: false },
            });
            const created = await daemon.createWorkspace({ name: "ws-a", projectRoot: wsDir });
            assert.equal(created.projectRoot, wsDir);

            await daemon.invokeModuleAction(
                "workspace.members.add",
                { files: ["../ws-b/**"] },
                { scope: "workspace", workspaceId: created.workspaceId },
            );
            const plan = await GitMembership.planCreation(db, created.workspaceId, "../ws-b/created.txt");
            assert.equal(plan.ok, true);
        });
    });

    test("{§operator-config-workspace-settings} none mode permits only headless workspaces and refuses rooted creation, attachment, membership, and creation", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-confinement-none-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const wsDir = join(scratch, "rooted");
        await mkdir(wsDir, { recursive: true });
        await writeFile(join(wsDir, "note.txt"), "hello\n");

        const db = await openMigrated();
        // Seed a pre-existing rooted workspace before enabling `none` confinement.
        const preExistingId = await insertWorkspace(db, "pre-existing-rooted");
        await rootWorkspace(db, preExistingId, wsDir);

        await withEnv({
            [PROJECT_ROOT_BASE_KEY]: "none",
            PLURNK_SERVICE_FILE_CREATE_SCOPE: "namespace",
            PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace",
        }, async () => {
            const daemon = new Daemon({ db, provider: null });
            await daemon.start();
            t.after(() => daemon.stop());

            assert.deepEqual(daemon.daemonPolicy(), {
                projectRoot: "none",
                families: ["env", "mcp", "members", "personas", "schedule", "skills"],
                familyScopes: {
                    env: ["service", "workspace", "session"],
                    mcp: ["service", "workspace"],
                    members: ["workspace"],
                    personas: ["service", "workspace"],
                    schedule: ["workspace"],
                    skills: ["service", "workspace"],
                },
                config: defaultConfigPolicy(),
                mcp: { workspaceTransports: ["stdio", "streamable-http"], publicOnly: false },
                skills: { workspaceSources: ["mcp", "git", "local"], publicOnly: false },
            });

            const headless = await daemon.createWorkspace({ name: "headless-ok" });
            assert.equal(headless.projectRoot, null);
            const attachedHeadless = await daemon.attachWorkspace({ workspaceId: headless.workspaceId });
            assert.equal(attachedHeadless.workspaceId, headless.workspaceId);

            await assert.rejects(
                () => daemon.createWorkspace({ name: "denied", projectRoot: wsDir }),
                (err: unknown) => isProblem(err, 403, "project-root-forbidden"),
            );
            await assert.rejects(
                () => daemon.attachWorkspace({ workspaceId: preExistingId }),
                (err: unknown) => isProblem(err, 403, "project-root-forbidden"),
            );
            await assert.rejects(
                () => daemon.attachWorkspace({ name: "pre-existing-rooted" }),
                (err: unknown) => isProblem(err, 403, "project-root-forbidden"),
            );
            await assert.rejects(
                () => daemon.attachWorkspace({ projectRoot: wsDir }),
                (err: unknown) => isProblem(err, 403, "project-root-forbidden"),
            );
            await assert.rejects(
                () => daemon.invokeModuleAction(
                    "workspace.members.add",
                    { files: ["note.txt"] },
                    { scope: "workspace", workspaceId: preExistingId },
                ),
                (err: unknown) => isProblem(err, 403, "project-root-forbidden"),
            );
            await assert.rejects(
                () => daemon.invokeModuleAction(
                    "workspace.members.discover",
                    { query: "note.txt" },
                    { scope: "workspace", workspaceId: preExistingId },
                ),
                (err: unknown) => isProblem(err, 403, "project-root-forbidden"),
            );

            const plan = await GitMembership.planCreation(db, preExistingId, "new.txt");
            assert.equal(plan.ok, false);
            assert.equal(plan.code, "file-create-disabled");
            assert.equal(await GitMembership.resolveOverlay(db, preExistingId, undefined, undefined), null);
            assert.equal(await GitMembership.isAmbientCandidate(db, preExistingId, "note.txt", undefined), false);
            assert.deepEqual(await GitMembership.ambientCandidates(db, preExistingId, "", undefined), []);
        });
    });

    test("{§operator-config-workspace-settings} confined base enforces physical root containment, prevents cross-workspace bleeding, blocks symlink and parent-git escapes, and suppresses disk existence oracles", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-confinement-base-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const base = join(scratch, "private-tenant-base");
        const tenantA = join(base, "tenant-a");
        const tenantB = join(base, "tenant-b");
        const outside = join(scratch, "outside");
        const prefixSibling = join(scratch, "private-tenant-base-other");

        await mkdir(join(tenantA, "docs"), { recursive: true });
        await mkdir(tenantB, { recursive: true });
        await mkdir(outside, { recursive: true });
        await mkdir(prefixSibling, { recursive: true });

        // Place a Git repo at `base` ABOVE both tenants to prove parent Git never bleeds tenant-b into tenant-a.
        const git = (args: string[]) => execFileP("git", args, { cwd: base, env: hermeticGitEnv() });
        await git(["init", "-q"]);
        await writeFile(join(tenantA, "docs", "readme.txt"), "tenant-a doc\n");
        await writeFile(join(tenantB, "secret.txt"), "tenant-b secret\n");
        await writeFile(join(outside, "host-secret.txt"), "host secret\n");
        await git(["add", "tenant-a/docs/readme.txt", "tenant-b/secret.txt"]);
        await git([
            "-c", "user.name=t", "-c", "user.email=t@t",
            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
            "commit", "-q", "--no-verify", "-m", "chore: seed parent repo",
        ]);

        // Create symlink escapes inside base and inside tenant-a.
        const rootEscapeLink = join(base, "link-to-outside");
        const danglingRootLink = join(base, "dangling-outside");
        const memberEscapeDir = join(tenantA, "escape-to-b");
        const memberEscapeFile = join(tenantA, "docs", "leaked.txt");
        const memberDanglingDir = join(tenantA, "dangling-dir");
        await symlink(outside, rootEscapeLink);
        await symlink(join(outside, "missing-leaf"), danglingRootLink);
        await symlink(tenantB, memberEscapeDir);
        await symlink(join(tenantB, "secret.txt"), memberEscapeFile);
        await symlink(join(outside, "nonexistent-sub"), memberDanglingDir);

        const db = await openMigrated();
        // Seed a pre-existing out-of-base workspace to verify attachWorkspace blocks it.
        const preExistingOutsideId = await insertWorkspace(db, "pre-existing-outside");
        await rootWorkspace(db, preExistingOutsideId, outside);

        await withEnv({
            [PROJECT_ROOT_BASE_KEY]: base,
            PLURNK_SERVICE_FILE_CREATE_SCOPE: "namespace",
            PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace",
            PLURNK_SERVICE_GIT_ALLOWED: "1",
            PLURNK_SERVICE_GIT_AUTO: "1",
        }, async () => {
            const daemon = new Daemon({ db, provider: null });
            await daemon.start();
            t.after(() => daemon.stop());

            assert.deepEqual(daemon.daemonPolicy(), {
                projectRoot: "confined",
                families: ["env", "mcp", "members", "personas", "schedule", "skills"],
                familyScopes: {
                    env: ["service", "workspace", "session"],
                    mcp: ["service", "workspace"],
                    members: ["workspace"],
                    personas: ["service", "workspace"],
                    schedule: ["workspace"],
                    skills: ["service", "workspace"],
                },
                config: defaultConfigPolicy(),
                mcp: { workspaceTransports: ["stdio", "streamable-http"], publicOnly: false },
                skills: { workspaceSources: ["mcp", "git", "local"], publicOnly: false },
            });

            // Allowed roots inside base (including non-existent future folder).
            const wsA = await daemon.createWorkspace({ name: "tenant-a", projectRoot: tenantA });
            assert.equal(wsA.projectRoot, tenantA);
            const wsFuture = await daemon.createWorkspace({ name: "tenant-future", projectRoot: join(base, "future", "home") });
            assert.equal(wsFuture.projectRoot, join(base, "future", "home"));

            // Refused roots outside base, sibling prefix, symlink escape, dangling symlink escape — without leaking base path.
            for (const badRoot of [outside, prefixSibling, rootEscapeLink, danglingRootLink]) {
                await assert.rejects(
                    () => daemon.createWorkspace({ name: `bad-${Math.random()}`, projectRoot: badRoot }),
                    (err: unknown) => {
                        if (!isProblem(err, 403, "project-root-confined")) return false;
                        assert.equal(err.result.problem?.detail.includes("private-tenant-base"), false, "detail must not leak base path");
                        if (badRoot === outside) {
                            assert.equal(JSON.stringify(err.result).includes("private-tenant-base"), false, "Problem must not leak base path");
                        }
                        return true;
                    },
                );
            }

            // Pre-existing out-of-base workspace cannot be attached by id, name, or projectRoot.
            await assert.rejects(
                () => daemon.attachWorkspace({ workspaceId: preExistingOutsideId }),
                (err: unknown) => isProblem(err, 403, "project-root-confined"),
            );
            await assert.rejects(
                () => daemon.attachWorkspace({ name: "pre-existing-outside" }),
                (err: unknown) => isProblem(err, 403, "project-root-confined"),
            );
            await assert.rejects(
                () => daemon.attachWorkspace({ projectRoot: outside }),
                (err: unknown) => isProblem(err, 403, "project-root-confined"),
            );

            // Parent Git repo above tenant-a must not be adopted and must not bleed tenant-b into tenant-a.
            assert.equal(await GitMembership.projectRepository(db, wsA.workspaceId), null);
            const initialOverlay = await GitMembership.resolveOverlay(db, wsA.workspaceId, undefined, undefined);
            assert.ok(initialOverlay !== null);
            assert.equal(initialOverlay.members.some((m) => m.includes("tenant-b") || m.startsWith("../")), false);

            // Client members.add admits in-root glob, but refuses outside-root, sibling-tenant, and symlink-escape globs.
            await daemon.invokeModuleAction(
                "workspace.members.add",
                { files: ["docs/**"] },
                { scope: "workspace", workspaceId: wsA.workspaceId },
            );
            for (const escapeGlob of [
                "../tenant-b/**",
                `${tenantB}/**`,
                `${outside}/**`,
                "escape-to-b/**",
                "dangling-dir/**",
                "docs/leaked.txt",
            ]) {
                await assert.rejects(
                    () => daemon.invokeModuleAction(
                        "workspace.members.add",
                        { files: [escapeGlob] },
                        { scope: "workspace", workspaceId: wsA.workspaceId },
                    ),
                    (err: unknown) => isProblem(err, 403, "members-confined"),
                    `expected members-confined for client members.add(${escapeGlob})`,
                );
                await assert.rejects(
                    () => daemon.invokeModuleAction(
                        "workspace.members.discover",
                        { query: escapeGlob },
                        { scope: "workspace", workspaceId: wsA.workspaceId },
                    ),
                    (err: unknown) => isProblem(err, 403, "members-confined"),
                    `expected members-confined for members.discover(${escapeGlob})`,
                );
            }

            // Symlinked file inside an admitted in-root glob (`docs/**`) is skipped by overlay scan (never becomes a member).
            const afterOverlay = await GitMembership.resolveOverlay(db, wsA.workspaceId, undefined, undefined);
            assert.ok(afterOverlay !== null);
            assert.deepEqual(afterOverlay.members, ["docs/readme.txt"]);

            // File creation scope is clamped to `root`: in-root allowed, outside-root & symlink-parent refused.
            const inRootPlan = await GitMembership.planCreation(db, wsA.workspaceId, "docs/new.txt");
            assert.equal(inRootPlan.ok, true);
            for (const badCreate of ["../tenant-b/pwn.txt", "escape-to-b/pwn.txt", "dangling-dir/pwn.txt"]) {
                const blocked = await GitMembership.planCreation(db, wsA.workspaceId, badCreate);
                assert.equal(blocked.ok, false, `expected creation refusal for ${badCreate}`);
                assert.equal(blocked.status, 403);
            }

            // Ambient auto-add candidates cannot reach outside tenant-a or follow escaping symlinks.
            assert.equal(await GitMembership.isAmbientCandidate(db, wsA.workspaceId, "docs/readme.txt", undefined), true);
            assert.equal(await GitMembership.isAmbientCandidate(db, wsA.workspaceId, "../tenant-b/secret.txt", undefined), false);
            assert.equal(await GitMembership.isAmbientCandidate(db, wsA.workspaceId, "docs/leaked.txt", undefined), false);
            const candidates = await GitMembership.ambientCandidates(db, wsA.workspaceId, "", undefined);
            assert.equal(candidates.includes("docs/leaked.txt"), false);
            assert.equal(candidates.some((p) => p.startsWith("../")), false);

            // File.readEntry miss refusal suppresses disk existence oracles for out-of-root and escaping-symlink files.
            const sessionId = await insertSession(db, wsA.workspaceId, null, "s1", "model");
            const fileScheme = new File();
            const fileCtx = {
                db,
                workspaceId: wsA.workspaceId,
                sessionId,
                mimetypes: DEFAULT_MIMETYPES,
            } as Parameters<File["readEntry"]>[1];
            const outsideRead = await fileScheme.readEntry(join(tenantB, "secret.txt"), fileCtx);
            assert.equal(outsideRead.status, 404);
            assert.equal(outsideRead.problem?.type.endsWith("/entry-not-found"), true);
            const symlinkRead = await fileScheme.readEntry("docs/leaked.txt", fileCtx);
            assert.equal(symlinkRead.status, 404);
            assert.equal(symlinkRead.problem?.type.endsWith("/entry-not-found"), true);

            // Headless workspace under confined mode refuses members.add (no root to jail inside).
            const headless = await daemon.createWorkspace({ name: "headless-confined" });
            assert.equal(headless.projectRoot, null);
            await assert.rejects(
                () => daemon.invokeModuleAction(
                    "workspace.members.add",
                    { files: ["**"] },
                    { scope: "workspace", workspaceId: headless.workspaceId },
                ),
                (err: unknown) => isProblem(err, 403, "members-confined"),
            );
        });
    });

    test("{§operator-config-workspace-settings} invalid PLURNK_SERVICE_PROJECT_ROOT_BASE fails validateConfiguration, records a notice, and fails closed", async (t) => {
        await withEnv({ [PROJECT_ROOT_BASE_KEY]: "not/absolute" }, async () => {
            assert.throws(
                () => Daemon.validateConfiguration(),
                (error: unknown) => error instanceof ConfigurationError && error.key === PROJECT_ROOT_BASE_KEY,
            );
            const db = await openMigrated();
            const daemon = new Daemon({ db, provider: null });
            await daemon.start();
            t.after(() => daemon.stop());

            assert.deepEqual(daemon.daemonPolicy(), {
                projectRoot: "none",
                families: ["env", "mcp", "members", "personas", "schedule", "skills"],
                familyScopes: {
                    env: ["service", "workspace", "session"],
                    mcp: ["service", "workspace"],
                    members: ["workspace"],
                    personas: ["service", "workspace"],
                    schedule: ["workspace"],
                    skills: ["service", "workspace"],
                },
                config: defaultConfigPolicy(),
                mcp: { workspaceTransports: ["stdio", "streamable-http"], publicOnly: false },
                skills: { workspaceSources: ["mcp", "git", "local"], publicOnly: false },
            });
            const notices = daemon.configurationNotices();
            assert.ok(
                notices.some((n) => n.kind === "configuration_unavailable" && (n.message?.includes(PROJECT_ROOT_BASE_KEY) ?? false)),
                `expected configuration_unavailable notice naming ${PROJECT_ROOT_BASE_KEY}, got ${JSON.stringify(notices)}`,
            );
            await assert.rejects(
                () => daemon.createWorkspace({ name: "blocked", projectRoot: "/tmp" }),
                (err: unknown) => isProblem(err, 503, "configuration-invalid"),
            );
        });
    });

    test("{§operator-config-workspace-settings} {§mcp-configuration} {§skills-module} {§persona-discovery} daemonPolicy exposes MCP/skills policy and registered families without cross-package env reads", async (t) => {
        await withEnv({ [PROJECT_ROOT_BASE_KEY]: "none" }, async () => {
            const db = await openMigrated();
            const daemon = new Daemon({ db, provider: null });
            daemon.registerModule(McpModule.init({
                env: {
                    ...MCP_CONTROLS,
                    PLURNK_MCP_WORKSPACE_TRANSPORTS: "streamable-http",
                    PLURNK_MCP_PUBLIC_ONLY: "1",
                },
            }), "@plurnk/plurnk-mcp");
            daemon.registerModule(SkillsModule.init({
                env: {
                    PLURNK_SKILLS_ENABLED: "1",
                    PLURNK_SKILLS_FETCH_TIMEOUT_MS: "120000",
                    PLURNK_SKILLS_WORKSPACE_SOURCES: "mcp",
                    PLURNK_SKILLS_PUBLIC_ONLY: "1",
                },
            }), "@plurnk/plurnk-skills");
            daemon.registerModule(PersonasModule.init({
                env: {
                    PLURNK_PERSONAS_ENABLED: "1",
                },
            }), "@plurnk/plurnk-personas");
            daemon.registerModule({ setup() {} }, "@plurnk/plurnk-schedule");
            await daemon.start();
            t.after(() => daemon.stop());

            assert.deepEqual(daemon.daemonPolicy(), {
                projectRoot: "none",
                families: ["env", "mcp", "members", "personas", "skills"],
                familyScopes: {
                    env: ["service", "workspace", "session"],
                    mcp: ["service", "workspace"],
                    members: ["workspace"],
                    personas: ["service", "workspace"],
                    skills: ["service", "workspace"],
                },
                config: defaultConfigPolicy(),
                mcp: {
                    workspaceTransports: ["streamable-http"],
                    publicOnly: true,
                },
                skills: {
                    workspaceSources: ["mcp"],
                    publicOnly: true,
                },
            });
        });
    });
});
