// Copy-paste audit (#891): jscpd over every workspace's runtime source, cross-package pairs only.
// On demand: `npm run audit:clones`; never a gate.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const root = resolve(import.meta.dirname, "../..");
const packageOf = (file) => file.split("/")[0];

const output = await mkdtemp(join(tmpdir(), "plurnk-clones-"));
try {
    await promisify(execFile)(join(root, "node_modules/.bin/jscpd"), [
        "--min-tokens", "50",
        "--format", "typescript,javascript",
        "--pattern", "plurnk-*/src/**/*.{ts,mts,js,mjs}",
        "--ignore", "**/node_modules/**,**/dist/**,**/test/**,**/*.test.ts,**/generated/**",
        "--reporters", "json",
        "--output", output,
        "--silent",
        root,
    ], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    const { duplicates } = JSON.parse(await readFile(join(output, "jscpd-report.json"), "utf8"));
    const crossPackage = duplicates
        .filter(({ firstFile, secondFile }) => packageOf(firstFile.name) !== packageOf(secondFile.name))
        .toSorted((a, b) => b.lines - a.lines);
    const span = ({ name, startLoc, endLoc }) => `${name}:${startLoc.line}-${endLoc.line}`;
    for (const { firstFile, secondFile, lines } of crossPackage) console.log(`${String(lines).padStart(4)} lines  ${span(firstFile)}  ~  ${span(secondFile)}`);
    console.log(`audit:clones — ${crossPackage.length} cross-package clone pair(s) of ${duplicates.length} total (min 50 tokens)`);
} finally {
    await rm(output, { recursive: true, force: true });
}
