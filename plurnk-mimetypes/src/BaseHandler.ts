import { buildJsonOutline } from "./buildJsonOutline.ts";
import { format } from "./format.ts";
import { projectDeepXml } from "./projectDeepXml.ts";
import { queryGlob, queryJsonpathObject, queryRegex, queryXpathString } from "./query.ts";
import { InvalidExpressionError, UnsupportedDialectError } from "./QueryError.ts";
import type {
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "./types.ts";

// Handler content union; file decoding follows the package declaration while
// inline callers supply either member directly ({§mimetype-handler-content}).
export type HandlerContent = string | Uint8Array;

// Default handler projections ({§mimetype-handler-contract}).
export default class BaseHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];

    constructor(metadata: HandlerMetadata) {
        this.mimetype = metadata.mimetype;
        this.glyph = metadata.glyph;
        this.extensions = Object.freeze([...metadata.extensions]);
    }

    // The union permits synchronous extractors and lazy asynchronous parsers;
    // framework consumers await both forms.
    extractRaw(_content: HandlerContent): MimeSymbol[] | Promise<MimeSymbol[]> {
        return [];
    }

    // Faithful JSONPath target, or null when the algebra has none
    // ({§mimetype-channel-architecture}).
    deepJson(_content: HandlerContent): unknown | Promise<unknown> {
        return null;
    }

    // Default XPath target: project deep JSON, then the symbol outline
    // ({§mimetype-handler-contract}).
    async deepXml(content: HandlerContent): Promise<string> {
        return projectDeepXml(
            await this.deepJson(content),
            () => this.extractRaw(content),
        );
    }

    // Derived readable text is absent when the raw body is already readable
    // ({§mimetype-content}).
    content(_content: HandlerContent): string | undefined | Promise<string | undefined> {
        return undefined;
    }

    // Sync and async validators share the same awaited boundary.
    validate(_content: HandlerContent): void | Promise<void> {
        // Default: anything is valid.
    }

    // Positive parser-recovery sites are advisory metadata; the default
    // handler has no parser evidence ({§mimetype-parse-issues}).
    parseIssues(_content: HandlerContent): number | Promise<number> {
        return 0;
    }

    // Canonical effective settings that can change projection output
    // ({§mimetype-projection-identity}).
    projectionConfiguration(): string | Promise<string> {
        return "";
    }

    // Release resources retained by this handler ({§mimetype-lifecycle}).
    dispose(): void | Promise<void> {
        // Default handlers retain nothing.
    }

    // Unbudgeted human/diagnostic rendering ({§mimetype-outline}).
    async symbolsRaw(content: HandlerContent): Promise<string> {
        return format(await this.extractRaw(content));
    }

    // Classified symbol uses, never definitions ({§mimetype-references}).
    references(_content: HandlerContent): MimeRef[] | Promise<MimeRef[]> {
        return [];
    }

    // Default text/structural dialect dispatch ({§mimetype-query}).
    async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        switch (dialect) {
            case "regex": {
                const text = await this.toText(content);
                return queryRegex(text, pattern, flags);
            }
            case "glob": {
                const text = await this.toText(content);
                return queryGlob(text, pattern);
            }
            case "jsonpath": {
                // A symbol outline is the default structural fallback.
                const tree = await this.deepJson(content);
                const readableText = await this.#structuralText(content);
                if (tree !== null && tree !== undefined) {
                    return queryJsonpathObject(tree, pattern, undefined, readableText);
                }
                const outline = buildJsonOutline(await this.extractRaw(content));
                return queryJsonpathObject(outline, pattern, undefined, readableText);
            }
            case "xpath": {
                // deepXml() owns the symmetric default XPath projection.
                const xml = await this.deepXml(content);
                if (xml.length === 0) {
                    throw new UnsupportedDialectError({
                        mimetype: this.mimetype,
                        dialect: "xpath",
                        reason: "no deep tree available for xpath projection",
                    });
                }
                return queryXpathString(
                    xml,
                    pattern,
                    this.mimetype,
                    await this.#structuralText(content),
                );
            }
        }
    }

    async #structuralText(content: HandlerContent): Promise<string | undefined> {
        if (typeof content !== "string") return undefined;
        return await this.content(content) === undefined ? content : undefined;
    }

    // String passthrough for regex/glob; binary handlers must project explicitly.
    protected toText(content: HandlerContent): string | Promise<string> {
        if (typeof content === "string") return content;
        throw new UnsupportedDialectError({
            mimetype: this.mimetype,
            dialect: "regex",
            reason: "binary content has no text projection for this mimetype",
        });
    }
}
