// Top-level orchestrator
export { default as Mimetypes } from "./Mimetypes.ts";
export type {
    Channel,
    HandlerLoader,
    MimetypesOptions,
    ProcessInput,
    ProcessOptions,
    ProcessResult,
} from "./Mimetypes.ts";

// Base classes for handler authors
export { default as BaseHandler } from "./BaseHandler.ts";
export { default } from "./BaseHandler.ts";
export { default as AntlrExtractor } from "./AntlrExtractor.ts";
export { default as TreeSitterExtractor } from "./TreeSitterExtractor.ts";
export type {
    DeepTreeNode,
    QueryConstructor,
    TreeSitterTree,
    TreeSitterNode,
    TreeSitterParser,
} from "./TreeSitterExtractor.ts";
export { walkDeepNode } from "./TreeSitterExtractor.ts";
export { withExtractor } from "./withExtractor.ts";
export type { HandlerContent } from "./BaseHandler.ts";

// Detection + discovery
export { detect, emptyRegistry } from "./detect.ts";
export { discover } from "./discover.ts";

// Outline formatting (tree-building + rendering primitives)
export {
    buildTree,
    format,
    maxDepth,
    pruneToMaxDepth,
    renderTree,
} from "./format.ts";
export type { TreeNode } from "./format.ts";

// Body-matcher query (parseBodyMatcher + per-dialect primitives + the bare-
// leaves outline builder + error classes). Used by handler authors building
// custom dialect overrides.
export { parseBodyMatcher } from "./parseBodyMatcher.ts";
export type { ParsedBodyMatcher } from "./parseBodyMatcher.ts";
export { buildJsonOutline } from "./buildJsonOutline.ts";
export type { JsonOutline } from "./buildJsonOutline.ts";
export { queryGlob, queryJsonpathObject, queryRegex, queryXpathString } from "./query.ts";
export { projectJsonToXml } from "./projectJsonToXml.ts";
export {
    InvalidExpressionError,
    QueryParseFailureError,
    UnsupportedDialectError,
} from "./QueryError.ts";
export { GrammarNotInstalledError } from "./treesitter/handler.ts";

// References-channel engine primitives (issue #19 / #23 boundary). Exported
// so Tier 2 handler packages (terraform, dockerfile, …) implement
// references() with the same capture conventions and container resolution
// the in-registry languages use — queries stay data, the engine stays one.
export { collectReferences } from "./treesitter/refsEngine.ts";
export type { RefsCaptureNode, RefsQuery, RefsQueryCapture } from "./treesitter/refsEngine.ts";
export type {
    ContentOffset,
    LogCoordinate,
    TelemetryEvent,
    TelemetrySeverity,
} from "./TelemetryEvent.ts";

// Per-mimetype classification authority (SPEC §20, #43) — the pure taxonomy
// heuristic; Mimetypes.classify() is the registry-aware form.
export { classifyMimetype } from "./classify.ts";
export type { MimeClassification } from "./classify.ts";

// Tokenizer seam (SPEC §19, #44) — exact LLM token counting via the opt-in
// @plurnk/plurnk-mimetypes-tokenizers artifact package.
export type { TokenizerResolution } from "./Tokenizers.ts";

// Grammar compilation utilities (for handler authors building their own pipeline)
export { injectBaseImports, rewriteImports, runCompile } from "./compile.ts";
export type { CompileOptions } from "./compile.ts";

// Public types
export type {
    DetectInput,
    Discovery,
    DiscoverOptions,
    ExtractionVisitor,
    HandlerInfo,
    HandlerMetadata,
    MimeRef,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
    RefKind,
    Registry,
    SymbolKind,
} from "./types.ts";
