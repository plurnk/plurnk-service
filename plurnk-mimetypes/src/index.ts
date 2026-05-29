// Top-level orchestrator
export { default as Mimetypes } from "./Mimetypes.ts";
export type {
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

// Budget-fitting (Preview dispatcher + symbol/content primitives for handler
// authors building their own orchestration on top of the framework).
export { fitContent, fitPreview, fitSymbols } from "./fit.ts";

// Body-matcher query (parseBodyMatcher + per-dialect primitives + the bare-
// leaves outline builder + error classes). Used by handler authors building
// custom dialect overrides.
export { parseBodyMatcher } from "./parseBodyMatcher.ts";
export type { ParsedBodyMatcher } from "./parseBodyMatcher.ts";
export { buildJsonOutline } from "./buildJsonOutline.ts";
export type { JsonOutline } from "./buildJsonOutline.ts";
export { queryGlob, queryJsonpathObject, queryRegex } from "./query.ts";
export {
    InvalidExpressionError,
    QueryParseFailureError,
    UnsupportedDialectError,
} from "./QueryError.ts";

// Grammar compilation utilities (for handler authors building their own pipeline)
export { injectBaseImports, rewriteImports, runCompile } from "./compile.ts";
export type { CompileOptions } from "./compile.ts";

// Sensible defaults exposed for tests, standalone use, and consumers building
// their own orchestration on top of the primitives above.
export { defaultTokenize } from "./defaults.ts";

// Public types
export type {
    DetectInput,
    Discovery,
    DiscoverOptions,
    ExtractionVisitor,
    HandlerInfo,
    HandlerMetadata,
    MimeSymbol,
    Preview,
    QueryDialect,
    QueryMatch,
    Registry,
    SymbolKind,
    SymbolPreview,
    TokenizeFn,
} from "./types.ts";
