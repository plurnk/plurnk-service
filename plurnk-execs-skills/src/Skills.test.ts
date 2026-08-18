import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Skills from "./Skills.ts";

const harness = async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-exec-"));
    const executor = new Skills({ runtime: "skills", glyph: "🧩" });
    const writes: string[] = [];
    const states: string[] = [];
    const args = {
        runtime: "skills",
        body: "",
        cwd: root,
        target: null as string | null,
        signal: new AbortController().signal,
        write: (_channel: string, chunk: string) => writes.push(chunk),
        setState: (_channel: string, state: string) => states.push(state),
        emit: () => undefined,
        interact: async () => { throw new Error("skills never interacts"); },
    };
    return {
        root,
        executor,
        writes,
        states,
        run: (target: string | null, body = "") => executor.run({ ...args, target, body }),
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
};

test("{§skills-materialization} the skills runtime lists, adds, and removes workspace skills", async () => {
    const h = await harness();
    try {
        assert.equal(h.executor.effect("list"), "read");
        assert.equal(h.executor.effect("add"), "host");
        assert.equal(h.executor.effect("remove"), "host");

        const empty = await h.run("list");
        assert.equal(empty.status, 200);
        assert.deepEqual(JSON.parse(h.writes.at(-1)!), []);

        const added = await h.run("add", [
            "---",
            "name: grep",
            "description: Find text in files",
            "---",
            "Use ripgrep. Always quote patterns.",
        ].join("\n"));
        assert.equal(added.status, 201);
        assert.deepEqual(JSON.parse(h.writes.at(-1)!), { name: "grep", description: "Find text in files" });
        assert.match(await readFile(join(h.root, "skills", "grep", "SKILL.md"), "utf8"), /Use ripgrep/);

        const listed = await h.run("list");
        assert.equal(listed.status, 200);
        assert.deepEqual(JSON.parse(h.writes.at(-1)!), [{ name: "grep", description: "Find text in files" }]);

        const removed = await h.run("remove", "grep");
        assert.equal(removed.status, 200);
        assert.deepEqual(JSON.parse(h.writes.at(-1)!), { name: "grep", removed: true });

        const again = await h.run("list");
        assert.deepEqual(JSON.parse(h.writes.at(-1)!), []);
    } finally {
        await h.cleanup();
    }
});

test("{§skills-materialization} the skills runtime rejects invalid names and missing skills", async () => {
    const h = await harness();
    try {
        const invalid = await h.run("add", "---\nname: ../escape\ndescription: x\n---\nbody");
        assert.equal(invalid.status, 400);

        const unnamed = await h.run("add", "plain body without frontmatter");
        assert.equal(unnamed.status, 400);

        const missing = await h.run("remove", "absent");
        assert.equal(missing.status, 404);

        const emptyBody = await h.run("add", "");
        assert.equal(emptyBody.status, 400);
    } finally {
        await h.cleanup();
    }
});

test("{§skills-materialization} the skills runtime requires a project root", async () => {
    const h = await harness();
    try {
        const rootless = await h.executor.run({
            runtime: "skills",
            body: "",
            cwd: null,
            target: "list",
            signal: new AbortController().signal,
            write: () => undefined,
            setState: () => undefined,
            emit: () => undefined,
            interact: async () => { throw new Error("unused"); },
        });
        assert.equal(rootless.status, 400);
        assert.match(String((rootless as { problem?: { detail?: string } }).problem?.detail ?? ""), /project root/);
    } finally {
        await h.cleanup();
    }
});
