import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DigestOptions } from "./digest-rows.ts";

// {§digest-programmatic-surface}: both forensic writers preserve their input
// directory entry and the database it resolves to before reading it or writing output.
export const digestPaths = (opts: DigestOptions): { dbPath: string; digestDir: string } => {
    const dbPath = resolve(opts.dbPath);
    if (!existsSync(dbPath)) throw new Error(`digest: no DB at ${dbPath}`);
    const digestDir = opts.digestDir ?? join(process.cwd(), "test", "digest");
    if (digestDir.length === 0) throw new Error("digest: output directory must not be empty");
    const outputPath = resolve(digestDir);
    const inputs = [dbPath, join(realpathSync(dirname(dbPath)), basename(dbPath)), realpathSync(dbPath)];
    const outputs = existsSync(digestDir) ? [outputPath, realpathSync(digestDir)] : [outputPath];
    if (outputs.some((output) => inputs.some((input) => {
        const path = relative(output, input);
        return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
    }))) {
        throw new Error(`digest: output directory ${outputPath} overlaps input database ${dbPath}`);
    }
    return { dbPath, digestDir };
};
