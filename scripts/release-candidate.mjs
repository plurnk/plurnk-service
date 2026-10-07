import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { candidateGraph, publicationOrder } from "./release-package-graph.mjs";
import { projectTarball } from "./package-projection.mjs";
import { repositoryName } from "./release-authority.mjs";

const exec = promisify(execFile);
export const output = async (command, args, cwd) => (await exec(command, args, { cwd, maxBuffer: 128 * 1024 * 1024 })).stdout.trim();
export const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
export const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
export const archiveIntegrity = async (file) => `sha512-${createHash("sha512").update(await readFile(file)).digest("base64")}`;

export const assertClean = async (root) => {
    const dirty = await output("git", ["status", "--porcelain"], root);
    if (dirty !== "") throw new Error(`release requires clean committed sources in ${root}:\n${dirty}`);
};

// Selection is explicit. Neither the external census nor neighboring products participate.
export const selectPackages = async (directories) => {
    if (directories.length === 0) throw new Error("select at least one package directory");
    const records = [];
    for (const directory of directories) {
        const cwd = path.resolve(directory);
        const manifest = await readJson(path.join(cwd, "package.json"));
        if (manifest.private) throw new Error(`${manifest.name}: private packages are not npm release candidates`);
        const root = await output("git", ["rev-parse", "--show-toplevel"], cwd);
        const origin = await output("git", ["remote", "get-url", "origin"], root);
        const repo = repositoryName(origin);
        records.push({ cwd, root, repo, packageFile: path.relative(root, path.join(cwd, "package.json")), manifest });
    }
    const graph = candidateGraph(records.map(({ manifest }) => manifest));
    return publicationOrder(graph).map(({ name }) => records.find(({ manifest }) => manifest.name === name));
};

export const packCandidate = async (record, directory) => {
    const packed = JSON.parse(await output("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], record.cwd));
    if (packed.length !== 1 || typeof packed[0]?.filename !== "string") throw new Error(`${record.manifest.name}: npm pack returned no unique archive`);
    const archive = packed[0].filename;
    const file = path.join(directory, archive);
    const { manifest } = await projectTarball(file, { gitHead: record.commit });
    if (manifest.name !== record.manifest.name || manifest.version !== record.manifest.version) throw new Error("packed candidate identity changed");
    return {
        root: record.root, repo: record.repo, packageFile: record.packageFile,
        commit: record.commit, name: manifest.name, version: manifest.version,
        archive, integrity: await archiveIntegrity(file), manifest,
    };
};

export const readCandidate = async (directory) => {
    const candidate = await readJson(path.join(directory, "release.json"));
    if (!Array.isArray(candidate.packages) || candidate.packages.length === 0 || !candidate.qualified) throw new Error("release candidate has not completed qualification");
    candidateGraph(candidate.packages.map(({ manifest }) => manifest));
    for (const record of candidate.packages) {
        if (record.archive !== path.basename(record.archive) || record.manifest?.name !== record.name || record.manifest.version !== record.version) throw new Error("invalid qualified package identity");
        if (await archiveIntegrity(path.join(directory, record.archive)) !== record.integrity) throw new Error(`${record.name}: qualified archive changed`);
        const packed = JSON.parse(await output("tar", ["-xOf", path.join(directory, record.archive), "package/package.json"]));
        if (JSON.stringify(packed) !== JSON.stringify(record.manifest)) throw new Error(`${record.name}: qualified manifest changed`);
    }
    return candidate;
};
