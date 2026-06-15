import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discover } from "./discover.ts";

// Materialize a throwaway package dir with the given package.json contents and
// return its path. Each call gets a unique temp dir; callers collect the dirs
// and pass them to discover({ packageDirs }).
const makePkg = async (pkg: unknown): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    return dir;
};

test("discover: registers each runtime tag of an exec package", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: {
            kind: "exec",
            runtimes: [
                { name: "search", glyph: "🔎", example: "EXEC[search]:france population:EXEC" },
                { name: "news", glyph: "📰" },
            ],
        },
    });
    const { registry } = await discover({ packageDirs: [dir] });

    assert.equal(registry.size, 2);
    // `example` flows through verbatim when declared, and defaults to "" when not.
    assert.deepEqual(registry.get("search"), {
        runtime: "search", glyph: "🔎", example: "EXEC[search]:france population:EXEC",
        packageName: "@plurnk/plurnk-execs-search",
    });
    assert.deepEqual(registry.get("news"), {
        runtime: "news", glyph: "📰", example: "", packageName: "@plurnk/plurnk-execs-search",
    });
});

test("discover: ignores non-exec packages and missing glyphs default to empty", async () => {
    const execDir = await makePkg({
        name: "@plurnk/plurnk-execs-sh",
        plurnk: { kind: "exec", runtimes: [{ name: "sh" }] },
    });
    const mimeDir = await makePkg({
        name: "@plurnk/plurnk-mimetypes-text-html",
        plurnk: { kind: "mimetype", handlers: [{ name: "text/html" }] },
    });
    const plainDir = await makePkg({ name: "left-pad" });

    const { registry } = await discover({ packageDirs: [execDir, mimeDir, plainDir] });

    assert.equal(registry.size, 1);
    assert.deepEqual(registry.get("sh"), {
        runtime: "sh", glyph: "", example: "", packageName: "@plurnk/plurnk-execs-sh",
    });
});

test("discover: tag collision across packages is fail-hard", async () => {
    const a = await makePkg({
        name: "@plurnk/plurnk-execs-search",
        plurnk: { kind: "exec", runtimes: [{ name: "search" }] },
    });
    const b = await makePkg({
        name: "@plurnk/plurnk-execs-othersearch",
        plurnk: { kind: "exec", runtimes: [{ name: "search" }] },
    });

    await assert.rejects(
        discover({ packageDirs: [a, b] }),
        /runtime collision: 'search' claimed by both @plurnk\/plurnk-execs-search and @plurnk\/plurnk-execs-othersearch/,
    );
});

test("discover: skips entries with no/empty name and malformed package.json", async () => {
    const dir = await makePkg({
        name: "@plurnk/plurnk-execs-mixed",
        plurnk: { kind: "exec", runtimes: [{ glyph: "❓" }, { name: "" }, { name: "ok" }] },
    });
    const brokenDir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));
    await fs.writeFile(path.join(brokenDir, "package.json"), "{ not json", "utf-8");
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "execs-discover-"));

    const { registry } = await discover({ packageDirs: [dir, brokenDir, emptyDir] });

    assert.equal(registry.size, 1);
    assert.ok(registry.has("ok"));
});

test("discover: empty scan of a nonexistent node_modules yields an empty registry", async () => {
    const { registry } = await discover({ cwd: path.join(os.tmpdir(), "execs-no-such-root-xyz") });
    assert.equal(registry.size, 0);
});

test("discover: the node_modules scan is scope-agnostic — third-party scopes are found", async () => {
    // Build a real <cwd>/node_modules with packages under @plurnk, a third-party
    // scope, an unscoped name, and a non-exec package that must be ignored.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "execs-scan-"));
    const write = async (rel: string, pkg: unknown): Promise<void> => {
        const dir = path.join(root, "node_modules", rel);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
    };
    await write("@plurnk/plurnk-execs-sh", { name: "@plurnk/plurnk-execs-sh", plurnk: { kind: "exec", runtimes: [{ name: "sh" }] } });
    await write("@acme/acme-execs-cobol", { name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await write("execs-fortran", { name: "execs-fortran", plurnk: { kind: "exec", runtimes: [{ name: "fortran" }] } });
    await write("left-pad", { name: "left-pad" });

    const { registry } = await discover({ cwd: root });

    assert.deepEqual([...registry.keys()].sort(), ["cobol", "fortran", "sh"]);
    assert.equal(registry.get("cobol")?.packageName, "@acme/acme-execs-cobol");
});

// --- PLURNK_PLUGINS_TRUSTED_ONLY host trust gate (plurnk-service#229) ---

// Run fn with the gate env set to `value` (undefined = unset), restoring after
// so tests don't leak the gate into one another.
const withGate = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    if (value === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = value;
    try { await fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = prev;
    }
};

test("trust gate ON: untrusted third-party is skipped (not registered); @plurnk stays trusted", async () => {
    const plurnk = await makePkg({ name: "@plurnk/plurnk-execs-sh", plurnk: { kind: "exec", runtimes: [{ name: "sh" }] } });
    const acme = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await withGate("1", async () => {
        const { registry, skipped } = await discover({ packageDirs: [plurnk, acme] });
        assert.deepEqual([...registry.keys()], ["sh"], "@plurnk registers; the untrusted third-party does not");
        assert.deepEqual(skipped, ["@acme/acme-execs-cobol"], "the untrusted package is reported as skipped");
    });
});

test("trust gate ON with an allowlist: a named third-party package is trusted", async () => {
    const cobol = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    const fortran = await makePkg({ name: "execs-fortran", plurnk: { kind: "exec", runtimes: [{ name: "fortran" }] } });
    await withGate("@acme/acme-execs-cobol", async () => {
        const { registry, skipped } = await discover({ packageDirs: [cobol, fortran] });
        assert.deepEqual([...registry.keys()], ["cobol"], "the allowlisted package registers");
        assert.deepEqual(skipped, ["execs-fortran"], "the non-allowlisted third-party is skipped");
    });
});

test('trust gate OFF ("0"): every installed package loads, nothing skipped', async () => {
    const acme = await makePkg({ name: "@acme/acme-execs-cobol", plurnk: { kind: "exec", runtimes: [{ name: "cobol" }] } });
    await withGate("0", async () => {
        const { registry, skipped } = await discover({ packageDirs: [acme] });
        assert.deepEqual([...registry.keys()], ["cobol"], "gate off → third-party loads (no regression)");
        assert.deepEqual(skipped, [], "nothing skipped when the gate is off");
    });
});
