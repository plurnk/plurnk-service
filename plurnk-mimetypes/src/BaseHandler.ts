import { buildJsonOutline } from "./buildJsonOutline.ts";
import { format } from "./format.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { outlineLineFor, queryGlob, queryJsonpathObject, queryRegex, queryXpathString } from "./query.ts";
import { InvalidExpressionError, UnsupportedDialectError } from "./QueryError.ts";
import type {
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "./types.ts";

// Content shape that handler methods accept. Text mimetypes receive `string`;
// binary mimetypes (PDF, images, archives) receive `Uint8Array`. Handlers
// signal which via `plurnk.binary: true` in their package.json. The framework
// reads files (or routes inline content) to the appropriate shape per handler.
export type HandlerContent = string | Uint8Array;

// Base class for mimetype handlers. Subclasses override the structural
// channels their algebra supports: extractRaw (symbols/defs), deepJson,
// deepXml, and references, plus validate when the mimetype has a real syntax
// check. The canonical consumer interface is `Mimetypes.process`,
// which materializes the requested channels per call (issue #17).
export default class BaseHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];

    constructor(metadata: HandlerMetadata) {
        this.mimetype = metadata.mimetype;
        this.glyph = metadata.glyph;
        this.extensions = Object.freeze([...metadata.extensions]);
    }

    // Raw structural extraction. Default returns []. Subclasses override for
    // mimetypes with structural content. Return type is a union so synchronous
    // handlers (AntlrExtractor, hand-rolled scanners) stay correct without
    // ceremony; tree-sitter-backed handlers return a Promise to honor WASM
    // grammar init. Consumers must `await` unconditionally.
    extractRaw(_content: HandlerContent): MimeSymbol[] | Promise<MimeSymbol[]> {
        return [];
    }

    // Full structural tree used as the jsonpath query target by the framework's
    // deep-channel pipeline (issue #10). The framework projects the returned
    // value to deep-xml via projectJsonToXml() — handlers never write XML
    // serialization logic. Returns null when the handler has no faithful tree
    // to expose (default).
    //
    // Per-algebra conventions:
    //   - tree-sitter handlers: full named-children walk of the AST, native
    //     node types. TreeSitterExtractor provides a default walker.
    //   - JSON / YAML / TOML / CSV: the parsed value directly.
    //   - HTML / XML / SVG: the parsed DOM serialized as nested objects.
    //   - Markdown: the markdown AST.
    //   - ANTLR / hand-rolled: handler authors as appropriate.
    deepJson(_content: HandlerContent): unknown | Promise<unknown> {
        return null;
    }

    // Deep-xml channel (issue #10). Default: project deepJson() through the
    // framework's projectJsonToXml() so every handler that emits a deep tree
    // automatically gets a queryable XML view (xpath target). Handlers can
    // override when their algebra has a natural XML representation that the
    // generic projection wouldn't capture as well — e.g., HTML/XML returning
    // the actual source markup instead of a projected tree.
    async deepXml(content: HandlerContent): Promise<string> {
        const tree = await this.deepJson(content);
        if (tree !== null && tree !== undefined) return projectJsonToXml(tree);
        // Symbols-only handlers (no deepJson) still answer jsonpath via the
        // bare-number outline fallback in query(); project that SAME outline so
        // xpath has identical reach and real source lines (#41 dialect
        // symmetry). Empty outline → no deep tree, so xpath stays unsupported.
        const outline = buildJsonOutline(await this.extractRaw(content));
        if (Object.keys(outline).length === 0) return "";
        return projectJsonToXml(outline, "root", outlineLineFor(outline));
    }

    // Model-facing readable text — the content channel. Default: undefined
    // (absent), which is correct for every handler whose raw body is already
    // what the model should read (code, markdown, json, plain text). Handlers
    // whose readable representation differs from the raw body override this:
    // text/html returns Readability+turndown markdown and PDF returns extracted
    // page text. When present it is also the embed-source.
    content(_content: HandlerContent): string | undefined | Promise<string | undefined> {
        return undefined;
    }

    // Throw on malformed content. Default no-op. Sync or async; the framework
    // awaits the result either way.
    validate(_content: HandlerContent): void | Promise<void> {
        // Default: anything is valid.
    }

    // Rendered outline — `format(await extractRaw(content))`. Diagnostic /
    // human surface; the structured MimeSymbol[] is the consumer channel.
    async symbolsRaw(content: HandlerContent): Promise<string> {
        return format(await this.extractRaw(content));
    }

    // Classified symbol uses for the references channel (issue #16 D4 / #19).
    // Default: none. Tree-sitter-backed handlers gain an implementation via
    // the framework's query-file engine as each language's .scm lands;
    // ANTLR/hand-rolled handlers implement visitor-side when their language's
    // turn comes. Never includes definitions (those are extractRaw's job) and
    // never emits refs from string-literal or comment positions — conformance
    // invariants in test/conformance enforce this per language.
    references(_content: HandlerContent): MimeRef[] | Promise<MimeRef[]> {
        return [];
    }

    // Body-matcher query. Plurnk-service calls this through Mimetypes.query
    // with a dialect + pattern parsed from the matcher expression's leading
    // prefix (see parseBodyMatcher).
    //
    // Defaults:
    //   - regex/glob: apply against decoded text content (toText). Subclasses
    //     with binary content override toText to provide a text projection
    //     (e.g. PDF returns extracted page text).
    //   - jsonpath: apply against deepJson, falling back to the symbol outline.
    //   - xpath: apply against deepXml, which projects the same structural
    //     channel. A handler with neither a deep tree nor symbols rejects it.
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
                // JSONPath dispatches against the deep-json channel when the
                // handler has one. Otherwise the handler's symbol outline is
                // its canonical structural projection.
                const tree = await this.deepJson(content);
                const readableText = await this.#structuralText(content);
                if (tree !== null && tree !== undefined) {
                    return queryJsonpathObject(tree, pattern, undefined, readableText);
                }
                const outline = buildJsonOutline(await this.extractRaw(content));
                return queryJsonpathObject(outline, pattern, undefined, readableText);
            }
            case "xpath": {
                // Per issue #10's symmetric design: xpath dispatches against
                // the deep-xml channel for every entry. The framework projects
                // deepJson() → deepXml() (or the handler overrides deepXml()
                // directly) so xpath works on JSON, code, markdown, and any
                // other content with a structural tree. Handlers that can map
                // the native source more precisely (text-html,
                // application-xml) override query() entirely to dispatch
                // xpath against the real DOM.
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

    // Provide a text projection for regex/glob queries. Default: pass through
    // for string content; throw for binary. Subclasses with binary content
    // (PDF, future image OCR) override to extract a readable representation.
    protected toText(content: HandlerContent): string | Promise<string> {
        if (typeof content === "string") return content;
        throw new UnsupportedDialectError({
            mimetype: this.mimetype,
            dialect: "regex",
            reason: "binary content has no text projection for this mimetype",
        });
    }
}
