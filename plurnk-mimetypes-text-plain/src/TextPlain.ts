import { BaseHandler } from "@plurnk/plurnk-mimetypes";

// One handler class serves two mimetypes — `text/plain` (prose, `.txt` files)
// and `text/stream` (live data: log://, exec://, streaming agent output). The
// framework constructs one instance per registered name.
//
// Neither mimetype has structural channels (no headings, no schema), so the
// class body is empty: BaseHandler's defaults — no-op validate, empty
// extractRaw/references, null deepJson — are exactly right.
export default class TextPlain extends BaseHandler {}
