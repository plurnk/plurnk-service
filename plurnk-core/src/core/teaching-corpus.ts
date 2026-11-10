import { errnoCode } from "@plurnk/plurnk-contracts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TeachingCorpusSource } from "@plurnk/plurnk-meta";
import Paths from "../Paths.ts";

export type ReadTeaching = (source: TeachingCorpusSource) => Promise<string>;

const failure = (source: TeachingCorpusSource, cause: unknown): Error =>
    new Error(`required teaching source '${source}' could not be read`, { cause });

// {§teaching-corpus} {§packet-inject} — read live from disk on every call so edits apply
// without restarting the daemon, falling back to the last read text on transient ENOENT
// during a concurrent build or reinstall. Initial absence and non-ENOENT errors reject.
export const liveTextReader = (
    filePath: string,
    onFailure: (cause: unknown) => unknown = (cause) => cause,
): (() => Promise<string>) => {
    let cached: string | undefined;
    return async () => {
        try {
            cached = await readFile(filePath, "utf8");
            return cached;
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT" && cached !== undefined) return cached;
            throw onFailure(cause);
        }
    };
};

export const teachingCorpusReader = (root: string): ReadTeaching => {
    const readers = new Map<TeachingCorpusSource, () => Promise<string>>();
    return async (source) => {
        let read = readers.get(source);
        if (read === undefined) {
            read = liveTextReader(resolve(root, source), (cause) => failure(source, cause));
            readers.set(source, read);
        }
        return read();
    };
};

export const readTeachingSource = teachingCorpusReader(Paths.teachingRoot);
export const readInstructionsSystem = liveTextReader(Paths.instructionsSystem);
