import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { packageArtifactViolations } from "./package-artifacts.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({
    options: {
        write: { type: "boolean", default: false },
        pack: { type: "boolean", default: false },
        only: { type: "string" },
    },
});

if (values.write && values.pack) throw new Error("--write and --pack are separate operations");

const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const workspaceDirs = rootManifest.workspaces;
if (!Array.isArray(workspaceDirs)) throw new Error("root package.json must declare workspaces");
if (values.only !== undefined && !workspaceDirs.includes(values.only)) {
    throw new Error(`unknown workspace directory: ${values.only}`);
}

const dirs = values.only === undefined ? workspaceDirs : [values.only];
const repositoryUrl = "git+https://github.com/plurnk/plurnk-service.git";
const bugsUrl = "https://repo.possumtech.com/plurnk/plurnk-service/issues";
const expectedFor = (dir) => ({
    homepage: `https://github.com/plurnk/plurnk-service/tree/main/${dir}#readme`,
    bugs: { url: bugsUrl },
    repository: {
        type: "git",
        url: repositoryUrl,
        directory: dir,
    },
});

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const mismatches = (dir, manifest) => {
    const expected = expectedFor(dir);
    return Object.entries(expected)
        .filter(([field, value]) => !same(manifest[field], value))
        .map(([field, value]) => `${dir}/package.json: ${field} must be ${JSON.stringify(value)}; got ${JSON.stringify(manifest[field] ?? null)}`);
};

const manifests = new Map();
const violations = [];
for (const dir of dirs) {
    const file = path.join(root, dir, "package.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifests.set(dir, manifest);
    try {
        await access(path.join(root, dir, "README.md"));
    } catch (cause) {
        throw new Error(`${dir}: package homepage has no README.md target`, { cause });
    }

    if (values.write) {
        Object.assign(manifest, expectedFor(dir));
        await writeFile(file, `${JSON.stringify(manifest, null, 4)}\n`);
    } else {
        violations.push(...mismatches(dir, manifest));
    }
}

if (violations.length > 0) {
    throw new Error(`package provenance violations:\n  ${violations.join("\n  ")}\nRun npm run metadata:write to normalize them.`);
}

if (values.write) {
    console.log(`normalized package provenance for ${dirs.length} workspace(s)`);
    process.exit(0);
}

if (!values.pack) {
    console.log(`package provenance OK: ${dirs.length} source manifest(s)`);
    process.exit(0);
}

const destination = await mkdtemp(path.join(tmpdir(), "plurnk-package-provenance-"));
try {
    for (const dir of dirs) {
        const manifest = manifests.get(dir);
        const packed = await run(
            "npm",
            ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, "-w", manifest.name],
            { cwd: root, maxBuffer: 64 * 1024 * 1024 },
        );
        let record;
        try {
            [record] = JSON.parse(packed.stdout);
        } catch (cause) {
            throw new Error(`${manifest.name}: npm pack did not return one JSON record`, { cause });
        }
        if (record?.filename === undefined) throw new Error(`${manifest.name}: npm pack returned no filename`);
        const archive = path.join(destination, record.filename);
        const candidate = JSON.parse((await run("tar", ["-xOf", archive, "package/package.json"], {
            maxBuffer: 4 * 1024 * 1024,
        })).stdout);
        const packedViolations = mismatches(dir, candidate);
        if (packedViolations.length > 0) {
            throw new Error(`${manifest.name}: packed manifest violates provenance:\n  ${packedViolations.join("\n  ")}`);
        }
        if (!Array.isArray(record.files)) {
            throw new Error(`${manifest.name}: npm pack returned no file projection`);
        }
        const artifactViolations = packageArtifactViolations(dir, record.files.map(({ path }) => path));
        if (artifactViolations.length > 0) {
            throw new Error(`${manifest.name}: packed artifacts violate their projection:\n  ${artifactViolations.join("\n  ")}`);
        }
        console.log(`  packed ${manifest.name}`);
    }
} finally {
    await rm(destination, { recursive: true, force: true });
}

console.log(`package provenance OK: ${dirs.length} packed candidate(s)`);
