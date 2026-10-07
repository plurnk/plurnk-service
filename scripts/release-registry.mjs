import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { candidateGraph, publicationOrder } from "./release-package-graph.mjs";
import { awaitRegistryVersion } from "./registry-visibility.mjs";

const exec = promisify(execFile);
const view = async (spec) => (await exec("npm", ["view", spec, "--json"], { maxBuffer: 16 * 1024 * 1024 })).stdout;

// {§release-candidate-graph}: only npm's explicit E404 means this exact version is absent.
export const registryPackage = async (name, version, lookup = view) => {
    let response;
    try {
        response = await lookup(`${name}@${version}`);
    } catch (cause) {
        let diagnostic;
        try { diagnostic = JSON.parse(cause.stdout ?? "null"); } catch { /* Preserve the original failure below. */ }
        if (diagnostic?.error?.code === "E404") return undefined;
        throw new Error(`registry lookup failed for ${name}@${version}`, { cause });
    }
    const manifest = JSON.parse(response);
    if (manifest?.name !== name || manifest.version !== version) throw new Error(`registry returned a different identity for ${name}@${version}`);
    return manifest;
};

export const assertPublishedArtifact = (candidate, published) => {
    if (published?.name !== candidate.name || published.version !== candidate.version
        || published.dist?.integrity !== candidate.integrity) {
        throw new Error(`${candidate.name}@${candidate.version}: registry artifact differs from the qualified archive`);
    }
    if (published.gitHead !== undefined && published.gitHead !== candidate.commit) {
        throw new Error(`${candidate.name}@${candidate.version}: registry source differs from the qualified commit`);
    }
};

export const publishCandidates = async (records, { publish, lookup = registryPackage, wait = awaitRegistryVersion }) => {
    const order = publicationOrder(candidateGraph(records.map(({ manifest }) => manifest)));
    for (const record of records) {
        const published = await lookup(record.name, record.version);
        if (published !== undefined) assertPublishedArtifact(record, published);
    }
    for (const { name } of order) {
        const record = records.find((item) => item.name === name);
        const existing = await lookup(name, record.version);
        if (existing !== undefined) {
            assertPublishedArtifact(record, existing);
            continue;
        }
        await publish(record);
        await wait({ name, version: record.version, lookup: async () => (await lookup(name, record.version))?.version });
        assertPublishedArtifact(record, await lookup(name, record.version));
    }
};
