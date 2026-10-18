import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import Namespace from "./namespace.ts";
import PathGlob from "./PathGlob.ts";
import Results, { type SchemeResultBase } from "./results.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

// {§file-url} Authored spellings are interpreted here; bound keys are always literal.
export default class FileAddress {
    static isPattern(target: ParsedPath | null | undefined): boolean {
        return target !== null && target !== undefined && PathSyntax.hasGlob(target.kind === "url" ? target.pathname : PathSyntax.decodeParens(target.raw));
    }

    static pathname(target: ParsedPath): string | SchemeResultBase {
        if (target.kind === "local") return PathSyntax.decodeParens(target.raw);
        if (target.scheme !== "file") throw new TypeError("FileAddress requires a file target.");
        try {
            const pathname = fileURLToPath(target.raw);
            if (pathname.includes("\0")) throw new TypeError("File URL path must not include NUL characters.");
            return pathname;
        } catch (cause) {
            if (!(cause instanceof TypeError || cause instanceof URIError)) throw cause;
            return Results.failure("scheme:file", "invalid-file-url", 400, cause.message, {}, { retryable: false });
        }
    }

    static selector(target: ParsedPath, projectRoot: string | null = null): string | SchemeResultBase {
        const pathname = FileAddress.pathname(target);
        if (typeof pathname !== "string" || target.kind === "local" || !FileAddress.isPattern(target)) return pathname;
        const url = new URL(target.raw);
        const parts = target.pathname.split("/");
        const rootParts = projectRoot === null ? [] : resolve(projectRoot).split("/");
        let common = 0;
        while (common < rootParts.length && common < parts.length && decodeURIComponent(parts[common]!) === rootParts[common]) common++;
        // URI-encoded glob characters are filename data, even next to authored glob syntax.
        // The common filesystem base is removed by relativization, not matched as a glob.
        url.pathname = parts.map((part, index) => index < common ? part
            : part.replace(/%(?:2a|3f|5b|5c|5d|7b|7d|28|29)/giu,
                (encoded) => encodeURIComponent(PathGlob.escape(decodeURIComponent(encoded))))).join("/");
        return fileURLToPath(url);
    }

    static async projectRoot({ db, workspaceId }: Pick<PlurnkSchemeContext, "db" | "workspaceId">): Promise<string | null> {
        const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        return row?.project_root ?? null;
    }

    // {§fs-canonical-name} A resource name must never render as a channel, alias or selector.
    // {§file-path-normalization} Inside the root a key renders literally; beyond it, as the absolute path it names.
    // Either spelling resolves back to the same key.
    static render(key: string, projectRoot: string | null): string {
        const beyond = projectRoot !== null && (key === ".." || key.startsWith("../"));
        const bare = beyond ? FileAddress.#absolute(key, projectRoot) : Namespace.literalSpelling(key);
        const ambiguous = /[#<\p{Cc}]|%2[89]/iu.test(bare) || bare.trim() !== bare
            || /^[a-z][a-z0-9+.-]*:\/\//iu.test(bare)
            || PathSyntax.hasGlob(bare);
        if (!ambiguous) return PathSyntax.escapeTarget(PathSyntax.encodeParens(bare));
        if (projectRoot === null) throw new TypeError("Rendering this file address requires its project root.");
        const url = pathToFileURL(resolve(projectRoot, key));
        if (key.endsWith("/") && !url.pathname.endsWith("/")) url.pathname += "/";
        // URL permits literal '*'; our target slot uses it as a collection selector.
        const address = url.href.replaceAll("*", "%2A");
        return PathSyntax.escapeTarget(PathSyntax.encodeParens(address));
    }

    static #absolute(key: string, projectRoot: string): string {
        const absolute = resolve(projectRoot, key);
        return key.endsWith("/") && !absolute.endsWith("/") ? `${absolute}/` : absolute;
    }

    static renderSelector(key: string, target: ParsedPath): string {
        if (target.kind === "local") return PathSyntax.escapeTarget(PathSyntax.encodeParens(Namespace.literalSpelling(key)));
        // Decoding and re-encoding a selector loses which metacharacters were literal.
        return PathSyntax.escapeTarget(`file://${target.hostname ?? ""}${target.pathname}`);
    }
}
