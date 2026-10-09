import { readFile } from "node:fs/promises";

// {§mimetype-query-assets}: mapping modules own composition and ESM owns caching.
export const loadRefsQuery = async (...languages: string[]): Promise<string> =>
    (await Promise.all(languages.map((language) =>
        readFile(new URL(`../../queries/${language}.scm`, import.meta.url), "utf8")))).join("");
