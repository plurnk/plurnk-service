import BaseHandler from "../../../../../src/BaseHandler.ts";

// Canonical text/plain shape: no structural extraction path. Returns the
// BaseHandler default (empty SymbolPreview), which the framework fits to an
// empty preview string — text/plain channels are dark in the radar by design.
export default class TextPlain extends BaseHandler {}
