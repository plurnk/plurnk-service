// Storyline fixture — a seeded tempdir that demos can use as a real
// workspace. Pattern adapted from rummy's test/helpers/StoryHarness.js
// (seed a small fake project with several files, git init it, exercise
// real workflows against it). The model navigates real content; we
// assert outcomes (file contents, command output) not op shapes.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DemoFixture {
    workspace: string;
    cleanup: () => Promise<void>;
}

// Seed: small node-style project with a few files the model can read,
// edit, query, and run. Mirrors the rummy fixture shape (config.json
// with db host + pool size, notes.md with a codename, app.js with a
// TODO to replace) so prompts that work for one project work for
// the other.
export const seedDemoFixture = async (label: string): Promise<DemoFixture> => {
    const workspace = await mkdtemp(join(tmpdir(), `plurnk-demo-${label}-`));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "data"), { recursive: true });

    await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
            name: "plurnk-demo-fixture",
            version: "0.1.0",
            description: "Seeded fixture for plurnk-service storyline demos",
            scripts: { greet: "echo hello-from-demo" },
        }, null, 2) + "\n",
    );

    await writeFile(
        join(workspace, "src/app.js"),
        [
            "const express = require('express');",
            "const app = express();",
            "app.listen(8080);",
            "// TODO: add error handling",
            "",
        ].join("\n"),
    );

    await writeFile(
        join(workspace, "src/config.json"),
        JSON.stringify({ db: "postgres", pool: 5, host: "db.internal" }, null, 2) + "\n",
    );

    await writeFile(
        join(workspace, "notes.md"),
        "The project codename is: phoenix\n",
    );

    await writeFile(
        join(workspace, "data/users.json"),
        JSON.stringify(
            [{ name: "Alice", role: "admin" }, { name: "Bob", role: "viewer" }],
            null, 2,
        ) + "\n",
    );

    // HTML fixture for xpath demos. Small page with multiple users so
    // attribute/text/predicate selectors all have a target.
    await writeFile(
        join(workspace, "data/users.html"),
        [
            "<html>",
            "  <body>",
            "    <h1>Team Roster</h1>",
            '    <user role="admin" email="alice@x.com">Alice</user>',
            '    <user role="viewer" email="bob@x.com">Bob</user>',
            '    <user role="admin" email="carol@x.com">Carol</user>',
            "  </body>",
            "</html>",
            "",
        ].join("\n"),
    );

    // git init — some operations rely on the working dir being a git
    // repo for the workspace boundary to make sense. Matches rummy.
    execSync(
        'git init -q && git config user.email "demo@plurnk.test" && git config user.name "demo" && git add . && git commit -q --no-verify -m "fixture"',
        { cwd: workspace },
    );

    return {
        workspace,
        cleanup: async () => { await rm(workspace, { recursive: true, force: true }); },
    };
};
