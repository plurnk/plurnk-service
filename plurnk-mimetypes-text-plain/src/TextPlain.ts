import { BaseHandler } from "@plurnk/plurnk-mimetypes";

// text/plain has no structural extraction path. Inherits BaseHandler unchanged
// — the default preview returns an empty SymbolPreview, which fits to "". The
// radar shows nothing for text/plain channels by design: a body slice would
// teach LLM consumers to read the preview as content and skip the fetch.
export default class TextPlain extends BaseHandler {}
