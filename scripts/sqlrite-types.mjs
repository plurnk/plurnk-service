import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: node scripts/sqlrite-types.mjs [--write] [--out <file>] <dir>...
Regenerates SqlRite statement typings from SQL directories with --write; without it, fails when on-disk typings differ.
Reads: <dir>/**/*.sql via @possumtech/sqlrite codegen.
Writes: --out (default SqlRite.d.ts) with --write.
`);

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const generator = resolve(dirname(require.resolve("@possumtech/sqlrite")), "scripts", "codegen.js");

export const syncSqlRiteTypes = async ({
    cwd,
    directories,
    out = "SqlRite.d.ts",
    write = false,
}) => {
    if (!Array.isArray(directories) || directories.length === 0) {
        throw new Error("name at least one SQL directory");
    }
    const temporary = await mkdtemp(resolve(tmpdir(), "plurnk-sqlrite-types-"));
    try {
        await exec(
            process.execPath,
            [generator, ...directories.map((directory) => resolve(cwd, directory))],
            { cwd: temporary },
        );
        const generated = await readFile(resolve(temporary, "SqlRite.d.ts"), "utf8");
        const output = resolve(cwd, out);
        if (write) {
            await mkdir(dirname(output), { recursive: true });
            await writeFile(output, generated);
            return;
        }
        let committed;
        try {
            committed = await readFile(output, "utf8");
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                throw new Error(`${out} is missing; run npm run types:sqlrite:write`);
            }
            throw error;
        }
        if (committed !== generated) {
            throw new Error(`${out} is stale; run npm run types:sqlrite:write`);
        }
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
};

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        options: {
            write: { type: "boolean", default: false },
            out: { type: "string", default: "SqlRite.d.ts" },
        },
        allowPositionals: true,
    });
    await syncSqlRiteTypes({
        cwd: process.cwd(),
        directories: positionals,
        out: values.out,
        write: values.write,
    });
}
