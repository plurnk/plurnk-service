import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TeachingCorpusSource } from "@plurnk/plurnk-meta";
import Paths from "../Paths.ts";

export type ReadTeaching = (source: TeachingCorpusSource) => Promise<string>;

const failure = (source: TeachingCorpusSource, cause: unknown): Error =>
    new Error(`required teaching source '${source}' could not be read`, { cause });

export const teachingCorpusReader = (root: string): ReadTeaching => async (source) => {
    try {
        return await readFile(resolve(root, source), "utf8");
    } catch (cause) {
        throw failure(source, cause);
    }
};

export const readTeachingSource = teachingCorpusReader(Paths.teachingRoot);

export const readTeachingSourceSync = (source: TeachingCorpusSource): string => {
    try {
        return readFileSync(Paths.teachingSource(source), "utf8");
    } catch (cause) {
        throw failure(source, cause);
    }
};
