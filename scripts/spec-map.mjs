// {§spec-chapter-map} — every chapter of a specification opens with the map of what it promises: one row per
// tag it declares, with the sentence that declares it, so a reader (or a model reading with line ranges)
// learns where to read from the chapter's head instead of grepping the file.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run spec:map | node scripts/spec-map.mjs   (a step of npm run root:lint)
Keeps each specification chapter's map true: under every H2 chapter that declares three or more tags, a table of its tags and their declaring sentences between <!-- map --> markers ({§spec-chapter-map}). Without --write it compares and refuses drift.
Reads: every SPEC.md.
Writes: the maps into the SPEC.md files with --write; drift to stdout otherwise, exit 1 on any.
`);

const ROOT = path.resolve(import.meta.dirname, "..");
const MIN_TAGS = 3;
const WIDTH = 110;
const OPEN = "<!-- map -->";
const CLOSE = "<!-- /map -->";
const TAG = /(?<![{\w§-])§([a-z][a-z0-9-]*[a-z0-9])(?![\w}-])/u;

const specs = async () => {
    const found = [];
    const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git" || entry.name === ".tmp") continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name === "SPEC.md") found.push(full);
        }
    };
    await walk(ROOT);
    return found.toSorted();
};

// The sentence a declaration leads with: a heading's title, a bold lead, a table row's label and first
// sentence, or the paragraph's first sentence, bounded.
const promiseOf = (line) => {
    const after = line.replace(/^(?:#+ |[-*] |\d+\. |\| )?§[a-z0-9-]+\s*/u, "");
    if (/^#+ /u.test(line)) return clip(after.trim());
    if (line.startsWith("| ")) {
        const cells = after.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
        const [label, body = ""] = cells;
        return clip(body.length > 0 ? `${label} — ${firstSentence(body)}` : label ?? "");
    }
    const bold = /^\*\*([^*]+)\*\*/u.exec(after);
    if (bold !== null) return clip(bold[1].trim());
    return clip(firstSentence(after));
};
const firstSentence = (text) => {
    const match = /^(.*?[.!?])(?:\s|$)/u.exec(text);
    return (match === null ? text : match[1]).trim();
};
const clip = (text) => {
    const flat = text.replace(/\s+/gu, " ").replace(/\|/gu, "\\|");
    if (flat.length <= WIDTH) return flat;
    const cut = flat.slice(0, WIDTH).replace(/\s+\S*$/u, "");
    return `${cut}…`;
};

// Chapters: each H2 and the lines to the next H2; declarations: tags at a block's first position, outside fences.
const chaptersOf = (lines) => {
    const chapters = [];
    // A fence closes only on a line of at least as many of its own characters (nested examples inside
    // four-backtick fences stay inside).
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (fence === null) {
            // A backtick fence's info string carries no backtick: a line that opens an inline span of
            // four backticks (```` ```READ ```` …) is prose, not a fence.
            const opened = /^(`{3,})[^`]*$/u.exec(line) ?? /^(~{3,})/u.exec(line);
            if (opened !== null) { fence = opened[1]; continue; }
        } else {
            if (line.startsWith(fence) && /^[`~]+\s*$/u.test(line) && line[0] === fence[0]) fence = null;
            continue;
        }
        if (line.startsWith("## ")) { chapters.push({ start: i, tags: [] }); continue; }
        const chapter = chapters.at(-1);
        if (chapter === undefined) continue;
        if (/^(?:#+ |[-*] |\d+\. |\| )?§[a-z]/u.test(line) && !/^#{1,2} /u.test(line)) {
            const tag = TAG.exec(line)?.[1];
            if (tag === undefined) continue;
            // A paragraph or list item wraps: its first sentence may end on a later line of the same block.
            let block = line;
            if (!/^(?:#+ |\| )/u.test(line)) {
                for (let j = i + 1; j < lines.length && lines[j].trim() !== "" && !/^(?:#+ |[-*] |\d+\. |\| |`{3,}|~{3,})/u.test(lines[j]); j++) {
                    block += ` ${lines[j].trim()}`;
                }
            }
            chapter.tags.push({ tag, promise: promiseOf(block) });
        }
    }
    return chapters;
};

const render = (tags) => [
    OPEN,
    "| Tag | Promise |",
    "| --- | --- |",
    ...tags.map(({ tag, promise }) => `| {§${tag}} | ${promise} |`),
    CLOSE,
];

// Apply the maps to one file's text: replace an existing map or insert one after the heading.
export const mapped = (text) => {
    const lines = text.split("\n");
    const chapters = chaptersOf(lines);
    const out = [];
    let i = 0;
    for (const chapter of chapters) {
        while (i <= chapter.start) out.push(lines[i++]);
        // An existing map follows the heading after at most one blank line.
        let j = i;
        if (lines[j] === "") j++;
        if (lines[j] === OPEN) {
            const end = lines.indexOf(CLOSE, j);
            if (end === -1) throw new Error(`unterminated ${OPEN} after line ${chapter.start + 1}`);
            i = end + 1;
            if (lines[i] === "") i++;
        }
        if (chapter.tags.length >= MIN_TAGS) out.push("", ...render(chapter.tags), "");
        else if (lines[i] === "" || i >= lines.length) { /* the chapter keeps its own spacing */ }
        else out.push("");
    }
    while (i < lines.length) out.push(lines[i++]);
    return out.join("\n").replace(/\n{3,}/gu, "\n\n");
};

if (import.meta.main) {
    const write = process.argv.includes("--write");
    let drift = 0;
    let maps = 0;
    for (const file of await specs()) {
        const text = await readFile(file, "utf8");
        const next = mapped(text);
        maps += (next.match(/^<!-- map -->$/gmu) ?? []).length;
        if (next === text) continue;
        drift++;
        if (write) await writeFile(file, next);
        else console.log(`${path.relative(ROOT, file)}: chapter maps are stale (npm run spec:map)`);
    }
    if (write) console.log(`spec maps written: ${drift} file(s) changed, ${maps} chapter map(s)`);
    else if (drift > 0) process.exit(1);
    else console.log(`spec maps OK: ${maps} chapter map(s) current`);
}
