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

// Budget-fitting (token-aware truncation for symbols and raw content)
export { fit, fitContent } from "./fit.ts";

// Grammar compilation utilities (for handler authors building their own pipeline)
export { rewriteImports, runCompile } from "./compile.ts";
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
    HandlerOptions,
    MimeSymbol,
    Registry,
    SymbolKind,
    TokenizeFn,
} from "./types.ts";
