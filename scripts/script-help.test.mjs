// {§script-help} — every script a package.json names answers --help, in the shared shape, before doing anything.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const SCRIPT = /(?:^|\s)((?:\.\.\/)?(?:scripts|bin|test|src)\/[\w./-]+\.(?:mjs|ts|js|sh))(?![\w.])/g;
// The daemon's own --help is a product surface; it answers in its own shape.
const OWN_USAGE = new Set(["plurnk-core/src/service.ts"]);

const namedScripts = async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const found = new Map();
    const scan = (dir, scripts) => {
        for (const [name, command] of Object.entries(scripts ?? {})) {
            for (const [, file] of command.matchAll(SCRIPT)) {
                const relative = path.normalize(path.join(dir, file));
                const entry = found.get(relative) ?? { dir, names: [] };
                entry.names.push(`${dir === "" ? "." : dir}:${name}`);
                found.set(relative, entry);
            }
        }
    };
    scan("", manifest.scripts);
    for (const workspace of manifest.workspaces) {
        scan(workspace, JSON.parse(await readFile(path.join(root, workspace, "package.json"), "utf8")).scripts);
    }
    return found;
};

const help = (file, cwd) => new Promise((resolve) => {
    const [command, args] = file.endsWith(".sh")
        ? ["bash", [path.join(root, file), "--help"]]
        : [process.execPath, ["--conditions=plurnk-dev", path.join(root, file), "--help"]];
    const child = spawn(command, args, { cwd: path.join(root, cwd), env: { ...process.env, NODE_NO_WARNINGS: "1" }, timeout: 60_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
});

test("{§script-help} every named entry point answers --help with usage, reads and writes", async (t) => {
    const scripts = await namedScripts();
    assert.ok(scripts.size >= 40, `expected the monorepo's entry points, found ${scripts.size}`);
    await Promise.all([...scripts].map(([file, { dir, names }]) => t.test(`${file} (${names.join(", ")})`, async () => {
        const result = await help(file, dir);
        assert.equal(result.code, 0, `${file} --help exited ${result.code ?? result.signal}: ${result.stderr.slice(0, 400)}`);
        const lines = result.stdout.trimEnd().split("\n");
        assert.match(lines[0], /^usage: /u, `${file}: the first line names how to run it`);
        if (OWN_USAGE.has(file)) return;
        const own = names.map((name) => name.slice(name.indexOf(":") + 1));
        assert.ok(
            own.some((name) => lines[0].includes(name === "test" ? "npm test" : `npm run ${name}`)) || lines[0].includes(path.basename(file)),
            `${file}: the usage line names the script (${own.join(", ")}) or its file, not another script's`,
        );
        assert.ok(lines.length >= 4, `${file}: what it does, Reads: and Writes: follow the usage line`);
        assert.ok(lines.some((line) => line.startsWith("Reads: ")), `${file}: a Reads: line`);
        assert.ok(lines.some((line) => line.startsWith("Writes: ")), `${file}: a Writes: line`);
    })));
});
