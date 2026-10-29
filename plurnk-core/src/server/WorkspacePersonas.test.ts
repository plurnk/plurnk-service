import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import type { Db } from "../core/Db.ts";
import HostPaths from "../core/HostPaths.ts";
import WorkspacePersonas from "./WorkspacePersonas.ts";
import WorkspacePlugins from "./WorkspacePlugins.ts";

describe("WorkspacePersonas", () => {
    const withRoots = (t: TestContext, value: string): void => {
        const previous = process.env.PLURNK_SERVICE_ROOTS;
        process.env.PLURNK_SERVICE_ROOTS = value;
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_ROOTS;
            else process.env.PLURNK_SERVICE_ROOTS = previous;
        });
    };

    const createFixture = async (t: TestContext): Promise<{
        readonly root: string;
        readonly project: string;
        readonly hostPaths: HostPaths;
        readonly personas: WorkspacePersonas;
    }> => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-personas-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const home = join(root, "home");
        const project = join(root, "project");
        await mkdir(home, { recursive: true });
        await mkdir(project, { recursive: true });
        const hostPaths = new HostPaths({ home, env: {} });
        const db = {
            envelope_get_workspace: {
                get: async () => ({ project_root: project }),
            },
        } as unknown as Db;
        const plugins = new WorkspacePlugins({ db, hostPaths });
        const personas = new WorkspacePersonas({ db, hostPaths, plugins });
        return { root, project, hostPaths, personas };
    };

    test("{§persona-discovery} discovers directory and single-file personas across the 5-tier cascade and plugins in precedence order", async (t) => {
        withRoots(t, "project,plurnk,global");
        const { project, hostPaths, personas } = await createFixture(t);

        const projectPlurnkDir = join(project, ".plurnk", "personas", "reviewer");
        const projectAgentsDir = join(project, ".agents", "personas");
        const xdgPlurnkDir = join(hostPaths.configDir, "personas");
        const xdgAgentsDir = join(hostPaths.xdgAgentsDir, "personas");
        const homeAgentsDir = join(hostPaths.globalAgentsDir, "personas");
        const pluginDir = join(hostPaths.projectPluginsDir(project), "team-plugin");

        await mkdir(projectPlurnkDir, { recursive: true });
        await mkdir(projectAgentsDir, { recursive: true });
        await mkdir(xdgPlurnkDir, { recursive: true });
        await mkdir(xdgAgentsDir, { recursive: true });
        await mkdir(homeAgentsDir, { recursive: true });
        await mkdir(join(pluginDir, "personas"), { recursive: true });

        // Highest precedence: <project>/.plurnk/personas/reviewer/PERSONA.md
        await writeFile(
            join(projectPlurnkDir, "PERSONA.md"),
            [
                "---",
                "name: reviewer",
                "description: Project plurnk reviewer",
                "model: fast",
                "effort: high",
                "---",
                "Review from .plurnk/personas.",
            ].join("\n"),
        );
        await writeFile(join(projectPlurnkDir, "checklist.md"), "# Checklist\n- Security\n");

        // Shadowed in <project>/.agents/personas/reviewer.md, plus unique architect.md
        await writeFile(
            join(projectAgentsDir, "reviewer.md"),
            [
                "---",
                "name: reviewer",
                "description: Shadowed reviewer",
                "---",
                "Shadowed body.",
            ].join("\n"),
        );
        await writeFile(
            join(projectAgentsDir, "architect.md"),
            [
                "---",
                "name: architect",
                "description: System architect",
                "effort: medium",
                "---",
                "Design clean boundaries.",
            ].join("\n"),
        );

        // Plugin in project scope: <project>/.agents/plugins/team-plugin/personas/auditor.md
        await writeFile(
            join(pluginDir, "plugin.json"),
            JSON.stringify({
                $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                name: "team-plugin",
            }),
        );
        await writeFile(
            join(pluginDir, "personas", "auditor.md"),
            [
                "---",
                "name: auditor",
                "description: Plugin security auditor",
                "---",
                "Audit plugin surfaces.",
            ].join("\n"),
        );

        // Lower tiers: xdg plurnk, xdg agents, home .agents
        await writeFile(
            join(xdgPlurnkDir, "operator.md"),
            [
                "---",
                "name: operator",
                "description: XDG plurnk operator",
                "---",
                "Operate the service.",
            ].join("\n"),
        );
        await writeFile(
            join(xdgAgentsDir, "researcher.md"),
            [
                "---",
                "name: researcher",
                "description: XDG agents researcher",
                "---",
                "Research specifications.",
            ].join("\n"),
        );
        await writeFile(
            join(homeAgentsDir, "writer.md"),
            [
                "---",
                "name: writer",
                "description: Home agents writer",
                "---",
                "Write concise documentation.",
            ].join("\n"),
        );

        const list = await personas.read(1);
        assert.deepEqual(
            list.map((p) => ({
                name: p.name,
                description: p.description,
                body: p.body,
                model: p.model,
                effort: p.effort,
            })),
            [
                {
                    name: "architect",
                    description: "System architect",
                    body: "Design clean boundaries.",
                    model: undefined,
                    effort: "medium",
                },
                {
                    name: "auditor",
                    description: "Plugin security auditor",
                    body: "Audit plugin surfaces.",
                    model: undefined,
                    effort: undefined,
                },
                {
                    name: "operator",
                    description: "XDG plurnk operator",
                    body: "Operate the service.",
                    model: undefined,
                    effort: undefined,
                },
                {
                    name: "researcher",
                    description: "XDG agents researcher",
                    body: "Research specifications.",
                    model: undefined,
                    effort: undefined,
                },
                {
                    name: "reviewer",
                    description: "Project plurnk reviewer",
                    body: "Review from .plurnk/personas.",
                    model: "fast",
                    effort: "high",
                },
                {
                    name: "writer",
                    description: "Home agents writer",
                    body: "Write concise documentation.",
                    model: undefined,
                    effort: undefined,
                },
            ],
        );
        assert.deepEqual(personas.notices(1), []);

        const trees = personas.trees(1);
        const reviewerTree = trees.get("reviewer");
        assert.ok(reviewerTree !== undefined);
        assert.deepEqual(await reviewerTree.list(), ["PERSONA.md", "checklist.md"]);

        const architectTree = trees.get("architect");
        assert.ok(architectTree !== undefined);
        assert.deepEqual(await architectTree.list(), ["PERSONA.md"]);
    });

    test("{§persona-discovery} malformed persona files record warnings and resource trees enforce containment", async (t) => {
        withRoots(t, "project");
        const { root, project, hostPaths, personas } = await createFixture(t);

        const personasDir = join(project, ".agents", "personas");
        await mkdir(personasDir, { recursive: true });

        // Empty body -> warning
        await writeFile(
            join(personasDir, "empty-body.md"),
            ["---", "name: empty-body", "description: Empty body persona", "---", "   "].join("\n"),
        );

        // Invalid effort -> warning
        await writeFile(
            join(personasDir, "bad-effort.md"),
            [
                "---",
                "name: bad-effort",
                "description: Invalid effort persona",
                "effort: turbo",
                "---",
                "Instructions.",
            ].join("\n"),
        );

        // Plugin persona symlink escaping plugin root -> warning
        const outsideFile = join(root, "outside-persona.md");
        await writeFile(
            outsideFile,
            ["---", "name: escaped", "description: Escaped", "---", "Outside."].join("\n"),
        );
        const pluginDir = join(hostPaths.projectPluginsDir(project), "escape-plugin");
        await mkdir(join(pluginDir, "personas"), { recursive: true });
        await writeFile(
            join(pluginDir, "plugin.json"),
            JSON.stringify({
                $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
                name: "escape-plugin",
            }),
        );
        await symlink(outsideFile, join(pluginDir, "personas", "escaped.md"));

        // Healthy single-file persona
        await writeFile(
            join(personasDir, "healthy.md"),
            ["---", "name: healthy", "description: Healthy persona", "---", "Stay healthy."].join("\n"),
        );

        const list = await personas.read(1);
        assert.deepEqual(list.map((p) => p.name), ["healthy"]);
        assert.equal(personas.notices(1).length, 3);

        const healthyTree = personas.trees(1).get("healthy");
        assert.ok(healthyTree !== undefined);
        assert.equal(await healthyTree.resource("missing.md").size(), null);
        await assert.rejects(
            () => healthyTree.resource("../secret.md").size(),
            (err: unknown) => {
                const refusal = WorkspacePersonas.refusal(err, {
                    authority: "healthy",
                    pathname: "/../secret.md",
                });
                assert.equal(refusal?.status, 403);
                assert.equal(refusal?.problem?.type, "https://problems.plurnk.xyz/scheme/persona/resource-outside-root");
                return true;
            },
        );
    });
});
