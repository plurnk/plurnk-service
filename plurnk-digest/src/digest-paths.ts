import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DigestOptions } from "./digest-rows.ts";

// {§share-packet-names}: the input database must exist and the output folder must be named. A
// writer never deletes: the digest refuses a folder that already holds files ({§share}).
export const digestPaths = (opts: DigestOptions): { dbPath: string; digestDir: string } => {
    const dbPath = resolve(opts.dbPath);
    if (!existsSync(dbPath)) throw new Error(`no DB at ${dbPath}`);
    const digestDir = opts.digestDir ?? join(process.cwd(), "test", "digest");
    if (digestDir.length === 0) throw new Error("output directory must not be empty");
    return { dbPath, digestDir: resolve(digestDir) };
};
