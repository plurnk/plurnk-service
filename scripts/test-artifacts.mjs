import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

export const testArtifactDirectory = (root) => resolve(root, "test/intg/.tmp");

export async function resetTestArtifacts(root) {
    const artifacts = testArtifactDirectory(root);
    await rm(artifacts, { recursive: true, force: true });
    await mkdir(artifacts, { recursive: true });
    return artifacts;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
    const mode = process.argv[2];
    if (mode !== "begin" && mode !== "clean") {
        throw new Error("Usage: node scripts/test-artifacts.mjs <begin|clean>");
    }
    const artifacts = await resetTestArtifacts(process.cwd());
    process.stderr.write(mode === "begin"
        ? `[test-artifacts] prior run cleared; retaining this run in ${artifacts}\n`
        : `[test-artifacts] cleared ${artifacts}\n`);
}
