// Mimetype classifiers used at op-handler boundaries.
//
// Binary/text taxonomy delegates to @plurnk/plurnk-mimetypes. This adapter is
// the registry-free surface; a consumer with a configured Mimetypes service
// uses Mimetypes.classify() so installed handler declarations remain authoritative.
//
// {§mimetype-classifier} What stays local is scheme semantics, not filetype fact:
//   isJson           - JSON receipt summarization (RFC 6839).
//   normalizeAutoText — the text-primitive policy (auto-derived text is markdown).

import { classifyMimetype } from "@plurnk/plurnk-mimetypes";

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
    // Pure taxonomy for registry-free boundaries (SPEC {§mimetype-classifier}).
    static isBinary(mimetype: string): boolean {
        return classifyMimetype(mimetype).binary;
    }

    // JSON-family check used by receipt summarization.
    // Matches application/json plus +json suffix variants per RFC 6839.
    // {§mimetype-classifier} Scheme semantics, deliberately NOT delegated.
    static isJson(mimetype: string): boolean {
        return mimetype === "application/json" || mimetype.endsWith("+json");
    }

    // Exact normalized HTML family used by web acquisition {§html-materialization}.
    static isHtml(mimetype: string): boolean {
        return mimetype === "text/html" || mimetype === "application/xhtml+xml";
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
