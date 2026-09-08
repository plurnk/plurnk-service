import fs from "node:fs/promises";
import path from "node:path";

// A package's `docs/<tag>.md` — the authored teaching carried beneath a generated tool
// document's header ({§executor-discovery}). Runtimes and Functionality families share this
// one rule: the file stays a valid standalone document whose exact authoring title `# <tag>`
// is removed, because the generated document owns the one model-facing H1.
export default class DocFile {
    // The tag's supplemental detail file, or null when the package ships none.
    static async read(dir: string, tag: string): Promise<string | null> {
        try {
            return DocFile.body(await fs.readFile(path.join(dir, "docs", `${tag}.md`), "utf-8"), tag);
        } catch {
            return null;
        }
    }

    static body(source: string, tag: string): string {
        const title = `# ${tag}`;
        if (source === title || source === `${title}\n`) return "";
        if (source.startsWith(`${title}\r\n`)) return source.slice(title.length + 2).replace(/^\r?\n/u, "");
        if (source.startsWith(`${title}\n`)) return source.slice(title.length + 1).replace(/^\r?\n/u, "");
        return source;
    }
}
