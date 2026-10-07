import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertClean, output, packCandidate, readJson, selectPackages, writeJson } from "./release-candidate.mjs";
import { assertNpmPublisher, assertReleaseRepository } from "./release-authority.mjs";
import { assertReleaseHosting, packageReleaseNotes } from "./release-finalize.mjs";
import { verifyConsumer } from "./release-consumer.mjs";

const [destination, ...directories] = process.argv.slice(2);
if (destination === undefined || directories.length === 0) throw new Error("usage: release-check.mjs <new-artifact-directory> <package-directory>...");
const directory = path.resolve(destination);
const records = await selectPackages(directories);
const repositories = new Map(records.map(({ root, repo }) => [root, repo]));
const run = (command, args, cwd) => new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${command} ${args.join(" ")} exited ${code} in ${cwd}`)));
});

for (const [root, repo] of repositories) {
    await assertClean(root);
    const { head } = await assertReleaseRepository(root, repo);
    await assertReleaseHosting(root, repo);
    for (const record of records.filter((item) => item.root === root)) {
        record.commit = head;
        await packageReleaseNotes({ ...record, version: record.manifest.version });
    }
}
await assertNpmPublisher(process.cwd());
await mkdir(directory); // Never replace an earlier qualification or its retained archives.
for (const [root] of repositories) {
    await run("npm", ["run", "build", "--if-present"], root);
    await run("npm", ["test"], root);
    const manifest = await readJson(path.join(root, "package.json"));
    const selection = manifest.workspaces === undefined ? [] : records
        .filter((record) => record.root === root)
        .flatMap(({ cwd }) => ["--only", path.relative(root, cwd)]);
    await run("npm", ["run", "release:gate", "--if-present", "--", ...selection], root);
    await assertClean(root);
    const commit = await output("git", ["rev-parse", "HEAD"], root);
    if (records.some((record) => record.root === root && record.commit !== commit)) throw new Error(`${root}: release sources changed during qualification`);
}
const packages = [];
for (const record of records) packages.push(await packCandidate(record, directory));
await verifyConsumer(packages, { directory, evidence: path.join(directory, "candidate-lock.json") });
for (const [root] of repositories) {
    await assertClean(root);
    const commit = await output("git", ["rev-parse", "HEAD"], root);
    if (records.some((record) => record.root === root && record.commit !== commit)) throw new Error(`${root}: release sources changed during qualification`);
}
await writeJson(path.join(directory, "release.json"), { qualified: new Date().toISOString(), packages });
console.log(`release-check GREEN: ${packages.map(({ name, version }) => `${name}@${version}`).join(", ")}\nRetained qualified artifacts: ${directory}`);
