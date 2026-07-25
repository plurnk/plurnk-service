import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const metaRoot = resolve(here, "..");
const monorepoRoot = resolve(metaRoot, "..");
const repositoryRoot = process.env.PLURNK_EXTERNAL_REPOS_ROOT
    ?? resolve(monorepoRoot, "..");
const registryPath = join(metaRoot, "external-packages.json");

const ownerOf = (name) =>
    name.startsWith("plurnk-mimetypes") ? "mimetypes"
    : name.startsWith("plurnk-providers") ? "providers"
    : name.startsWith("plurnk-schemes") ? "schemes"
    : name.startsWith("plurnk-execs") ? "execs"
    : name === "plurnk" || name === "plurnk.nvim" ? "client"
    : name === "plurnk-bench" ? "bench"
    : name === "plurnk-learn" ? "learn"
    : null;

const independentProducts = new Set(["plurnk", "plurnk.nvim", "plurnk-bench"]);

export const census = () => {
    const packages = [];
    for (const dir of readdirSync(repositoryRoot).sort()) {
        const manifestPath = join(repositoryRoot, dir, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.private === true) continue;
        const platformDependencies = Object.keys({
            ...manifest.dependencies,
            ...manifest.peerDependencies,
        }).filter((name) => name.startsWith("@plurnk/")).sort();
        if (platformDependencies.length === 0) continue;
        packages.push({
            dir,
            name: manifest.name,
            release: independentProducts.has(dir) ? "independent" : "managed",
            owner: ownerOf(dir),
            pushable: existsSync(join(repositoryRoot, dir, ".git")),
            platformDependencies,
        });
    }
    const independent = packages.filter((entry) => entry.release === "independent").length;
    return {
        root: repositoryRoot === resolve(monorepoRoot, "..")
            ? "«repo forest»"
            : repositoryRoot,
        count: packages.length,
        managed: packages.length - independent,
        independent,
        packages,
    };
};

const stable = (value) => `${JSON.stringify(value, null, 4)}\n`;

if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            write: { type: "boolean" },
            check: { type: "boolean" },
        },
    });
    const scanned = census();
    if (values.write) {
        writeFileSync(registryPath, stable(scanned));
        console.log(`external-package-census: wrote ${scanned.count} packages`);
    } else if (values.check) {
        const committed = existsSync(registryPath)
            ? readFileSync(registryPath, "utf8")
            : "";
        if (committed !== stable(scanned)) {
            console.error("external package registry differs from repository scan");
            process.exit(1);
        }
        console.log(`external-package-census: ${scanned.count} packages`);
    } else {
        process.stdout.write(stable(scanned));
    }
}
