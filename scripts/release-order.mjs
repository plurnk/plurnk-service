import { selectPackages } from "./lib/release-candidate.mjs";
import { usage } from "./lib/usage.mjs";

usage(`
usage: npm run release:order -- <package-directory>...
Prints the selected packages in publication order, one name@version per line.
Reads: the selected package.json files.
Writes: the order to stdout.
`);

for (const { manifest } of await selectPackages(process.argv.slice(2))) {
    console.log(`${manifest.name}@${manifest.version}`);
}
