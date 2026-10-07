import { selectPackages } from "./release-candidate.mjs";

for (const { manifest } of await selectPackages(process.argv.slice(2))) {
    console.log(`${manifest.name}@${manifest.version}`);
}
