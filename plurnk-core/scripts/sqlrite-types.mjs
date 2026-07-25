import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const generator = resolve(dirname(require.resolve("@possumtech/sqlrite")), "scripts", "codegen.js");
const temporary = await mkdtemp(resolve(tmpdir(), "plurnk-sqlrite-types-"));

const generate = async (directories, name) => {
    await exec(process.execPath, [
        generator,
        ...directories.map((directory) => resolve(root, directory)),
    ], { cwd: temporary });
    const generated = await readFile(resolve(temporary, "SqlRite.d.ts"), "utf8");
    const output = resolve(root, name);
    if (process.argv.includes("--write")) {
        await writeFile(output, generated);
    } else {
        const committed = await readFile(output, "utf8");
        if (committed !== generated) {
            throw new Error(`${name} is stale; run npm run types:sqlrite`);
        }
    }
};

try {
    await generate(["migrations", "src"], "SqlRite.d.ts");
    await generate(["migrations", "src", "test/intg"], "SqlRite.test.d.ts");
} finally {
    await rm(temporary, { recursive: true, force: true });
}
