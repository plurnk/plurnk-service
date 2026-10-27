// Mimetype classifiers used at op-handler boundaries.
//
// Binary/text taxonomy delegates to @plurnk/plurnk-mimetypes. This adapter is
// the registry-free surface; a consumer with a configured Mimetypes service
// uses Mimetypes.classify() so installed handler declarations remain authoritative.
//
// {§network-address} What stays local is scheme semantics, not filetype fact:
//   isJson           - JSON receipt summarization (RFC 6839).
//   normalizeAutoText — the text-primitive policy (auto-derived text is markdown).

import { classifyMimetype, type Mimetypes } from "@plurnk/plurnk-mimetypes";

// Text primitive for the agent contract: text/markdown is the default
// text mimetype anywhere plurnk-service auto-derives a text result.
// text/plain is reserved for explicit scheme-manifest declarations
// (exec subprocess streams) and client-set entries. Rationale: markdown
// is a strict superset of plain text — any plain text is valid markdown
// — so the agent gets markdown-aware processing capability for free,
// and never needs to decide "is this markdown enough to mark as
// markdown?"
export const TEXT_PRIMITIVE_MIMETYPE = "text/markdown";

export default class MimetypeClassifier {
    // Pure taxonomy for registry-free boundaries (SPEC {§network-address}).
    static isBinary(mimetype: string): boolean {
        return classifyMimetype(mimetype).binary;
    }

    // JSON-family check used by receipt summarization.
    // Matches application/json plus +json suffix variants per RFC 6839.
    // {§network-address} Scheme semantics, deliberately NOT delegated.
    static isJson(mimetype: string): boolean {
        return mimetype === "application/json" || mimetype.endsWith("+json");
    }

    // Exact normalized HTML family used by web acquisition {§http-lifecycle}.
    static isHtml(mimetype: string): boolean {
        return mimetype === "text/html" || mimetype === "application/xhtml+xml";
    }

    // {§network-address}
    static isTransferCompatible(
        source: string,
        destination: string,
        sourceClassification: { readonly binary: boolean } = classifyMimetype(source),
    ): boolean {
        return source === destination
            || (!sourceClassification.binary
                && (destination === "text/plain" || destination === TEXT_PRIMITIVE_MIMETYPE));
    }

    // Normalize an auto-derived text mimetype to the text primitive.
    // Use at any consumer-side auto-derivation point (file scheme
    // extension fallback, log rx wrap, etc.): text/plain / null / undefined
    // / empty → text/markdown.
    static normalizeAutoText(mimetype: string | null | undefined): string {
        if (mimetype === null || mimetype === undefined || mimetype === "" || mimetype === "text/plain") {
            return TEXT_PRIMITIVE_MIMETYPE;
        }
        return mimetype;
    }
}

// {§network-address}: recognized suffixes precede the caller's supplied type.
export class PathMimetype {
    // Extract the suffix (everything after the last dot in the last segment)
    // from a pathname. Empty if no dot in the last segment.
    static extractExtension(pathname: string): string {
        const lastSlash = pathname.lastIndexOf("/");
        const lastSegment = lastSlash === -1 ? pathname : pathname.slice(lastSlash + 1);
        const lastDot = lastSegment.lastIndexOf(".");
        if (lastDot <= 0) return "";  // leading-dot files (".env") aren't an extension
        return lastSegment.slice(lastDot);  // includes the leading "."
    }

    // Resolve a pathname → effective mimetype.
    // 1. If the pathname has an extension, query Mimetypes.detect({ ext })
    //    and use what comes back (normalized via the text-primitive rule —
    //    text/plain → text/markdown).
    // 2. Otherwise (no extension or no Mimetypes service), fall back to
    //    `schemeDefault` (typically the scheme manifest's channel default).
    static async resolve(
        pathname: string,
        schemeDefault: string,
        mimetypes: Mimetypes | undefined,
    ): Promise<string> {
        const ext = PathMimetype.extractExtension(pathname);
        if (ext.length > 0 && mimetypes !== undefined) {
            const detected = await mimetypes.detect({ ext });
            if (detected !== null) return MimetypeClassifier.normalizeAutoText(detected);
        }
        return schemeDefault;
    }
}
