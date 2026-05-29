import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { Preview } from "@plurnk/plurnk-mimetypes";

// One handler class serves two mimetypes — `text/plain` (head-oriented prose,
// `.txt` files) and `text/stream` (tail-oriented live data, log://, exec://,
// streaming agent output). The framework constructs one instance per
// registered name; this.mimetype picks the orientation at preview time.
//
// Neither mimetype has structural extraction (no headings, no schema). Both
// always return a TextPreview; the framework's fitContent slices it and
// appends/prepends `[[TRUNCATED]]` per orientation when the slice doesn't
// cover the whole content.
export default class TextPlain extends BaseHandler {
    override preview(content: string | Uint8Array): Preview {
        const text = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);
        const orientation = this.mimetype === "text/stream" ? "tail" : "head";
        return { kind: "text", text, orientation };
    }
}
