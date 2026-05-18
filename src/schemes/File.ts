import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { ReadStatement } from "@plurnk/plurnk-grammar";
import type { SchemeManifest } from "../core/scheme-types.ts";

type ReadContext = { statement: ReadStatement };
type ReadResult = { status: number; content: string | null; mimetype: string | null };

export default class File {
    static manifest: SchemeManifest = {
        name: "file",
        channels: {},  // dynamic mimetype per file extension
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };

    #workspaceRoot: string | null = null;

    #resolveWorkspaceRoot(): string | null {
        if (this.#workspaceRoot !== null) return this.#workspaceRoot;
        const root = process.env.PLURNK_WORKSPACE_ROOT;
        if (root === undefined || root === "") return null;
        this.#workspaceRoot = resolve(root);
        return this.#workspaceRoot;
    }

    async read({ statement }: ReadContext): Promise<ReadResult> {
        if (statement.path === null) return { status: 400, content: null, mimetype: null };
        if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null };
        if (statement.body !== null) return { status: 501, content: null, mimetype: null };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null };

        const root = this.#resolveWorkspaceRoot();
        if (root === null) return { status: 400, content: null, mimetype: null };

        const pathname = statement.path.kind === "url" ? statement.path.pathname : statement.path.raw;
        const requested = isAbsolute(pathname) ? pathname : resolve(root, pathname);

        let canonical: string;
        try {
            canonical = await realpath(requested);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: 404, content: null, mimetype: null };
            throw err;
        }

        const rel = relative(root, canonical);
        if (rel.startsWith("..") || isAbsolute(rel)) return { status: 403, content: null, mimetype: null };

        const content = await readFile(canonical, "utf8");
        return { status: 200, content, mimetype: "text/plain" };
    }
}
