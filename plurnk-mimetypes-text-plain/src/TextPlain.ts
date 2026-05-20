import { BaseHandler } from "@plurnk/plurnk-mimetypes";

// text/plain handler. BaseHandler's defaults (empty extract, no-op validate,
// derived symbols/preview) are exactly right — text/plain has no structural
// declarations to extract. The framework's raw-content fallback path in
// Mimetypes.process supplies preview content when extract is empty.
export default class TextPlain extends BaseHandler {}
