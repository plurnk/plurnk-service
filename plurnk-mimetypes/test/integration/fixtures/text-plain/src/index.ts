import BaseHandler from "../../../../../src/BaseHandler.ts";

// Canonical text/plain shape: no structural extraction path. BaseHandler
// defaults throughout — empty symbols, null deepJson — so plain text
// contributes metadata (totalLines/extent) and nothing structural.
export default class TextPlain extends BaseHandler {}
