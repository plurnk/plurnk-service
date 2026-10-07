import path from "node:path";
import { assertNpmPublisher, assertReleaseRepository } from "./release-authority.mjs";
import { output, readCandidate } from "./release-candidate.mjs";
import { verifyConsumer } from "./release-consumer.mjs";
import { publishCandidates } from "./release-registry.mjs";
import { assertReleaseHosting, finalizeCandidate, packageReleaseNotes } from "./release-finalize.mjs";

const [destination, ...extra] = process.argv.slice(2);
if (destination === undefined || extra.length !== 0) throw new Error("usage: release-publish.mjs <qualified-artifact-directory>");
const directory = path.resolve(destination);
const candidate = await readCandidate(directory);
const { packages } = candidate;
for (const [root, repo] of new Map(packages.map((record) => [record.root, record.repo]))) {
    await assertReleaseRepository(root, repo);
    await assertReleaseHosting(root, repo);
    for (const { commit } of packages.filter((record) => record.root === root)) {
        await output("git", ["verify-commit", commit], root);
        await output("git", ["merge-base", "--is-ancestor", commit, "HEAD"], root);
    }
}
await assertNpmPublisher(process.cwd());
for (const record of packages) await packageReleaseNotes(record);
await publishCandidates(packages, { publish: async (record) => {
    console.log(`publish ${record.name}@${record.version}`);
    await output("npm", ["publish", path.join(directory, record.archive), "--access", "public", "--ignore-scripts"], record.root);
} });
await verifyConsumer(packages, { directory, registry: true, evidence: path.join(directory, "registry-lock.json") });
await finalizeCandidate(candidate, directory);
console.log(`release-publish GREEN: ${packages.length} packages published, consumer-verified, and recorded; artifacts retained at ${directory}`);
