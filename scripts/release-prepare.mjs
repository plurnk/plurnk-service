// Prepare one coherent release commit. Build and publish gates intentionally
// run later, from release:publish, after this stamp has been committed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const version = process.argv[2];
if (!version) throw new Error("usage: release-prepare.mjs <version>");

const step = async (command, args) => {
    const result = await run(command, args, { maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
};

await step("npm", ["run", "generate", "-w", "plurnk-models"]);
await step("node", ["scripts/deps-preflight.mjs"]);
await step("node", ["scripts/release-version.mjs", version]);
await step("node", ["plurnk-meta/scripts/external-package-census.mjs", "--write"]);

console.log(`release ${version} prepared — commit the complete stamp before release:publish`);
