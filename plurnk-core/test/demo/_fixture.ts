// Storyline fixture — a seeded tempdir that demos can use as a real
// workspace: seed a small fake project with several files, git init it, exercise
// real workflows against it). The model navigates real content; we
// assert outcomes (file contents, command output) not op shapes.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import Owner from "../../src/core/Owner.ts";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../../src/core/Db.ts";

export interface DemoFixture {
    workspace: string;
    cleanup: () => Promise<void>;
    addToCatalog: (db: Db, workspaceId: number) => Promise<void>;
}

// The files seedDemoFixture writes — the set the client registers as workspace
// members (the catalog) so File.read, which is membership-gated, can serve them.
const FILES = ["package.json", "src/app.js", "src/config.json", "notes.md", "data/users.json", "data/users.html"];

// Seed: small node-style project with a few files the model can read,
// edit, query, and run: config.json with a database host and pool size,
// notes.md with a codename, and app.js with a TODO to replace.
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
            // Three users so the topo-pipeline "is the count more than 2?" resolves to a clear YES.
            // Alice stays the sole admin (Bob/Carol viewers) so the admin story still names just her.
            [{ name: "Alice", role: "admin" }, { name: "Bob", role: "viewer" }, { name: "Carol", role: "viewer" }],
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
    // repository for the workspace boundary to make sense.
    execSync(
        'git init -q && git config user.email "demo@plurnk.invalid" && git config user.name "demo" && git add . && git commit -q --no-verify -m "fixture"',
        { cwd: workspace },
    );

    return {
        workspace,
        cleanup: async () => { await rm(workspace, { recursive: true, force: true }); },
        // The fixture owns catalog membership: register each seeded file as a
        // workspace entry under the reserved file identity so the model
        // may READ it. Channel-less — disk stays the truth; the entry is the
        // membership marker the read gate checks and FIND globs by path.
        addToCatalog: async (db, workspaceId) => {
            for (const rel of FILES) {
                await db.crud_insert_workspace_entry.get({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: rel });
            }
        },
    };
};

// Developer entrypoint: create the same modest, standalone git project used by
// live demos and print its path. This keeps client/service theory drills from
// accidentally digesting the platform monorepo. The caller owns cleanup.
if (import.meta.main) {
    const label = process.argv[2] ?? "manual";
    const fixture = await seedDemoFixture(label);
    process.stdout.write(`${fixture.workspace}\n`);
}
