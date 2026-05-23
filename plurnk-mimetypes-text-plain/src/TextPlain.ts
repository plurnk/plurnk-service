import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { Preview } from "@plurnk/plurnk-mimetypes";

// text/plain: the entire content is the preview material, head-oriented.
// No extractable structure, so symbols/extractRaw stay at BaseHandler's
// empty defaults — only `preview` is overridden to return a TextPreview.
export default class TextPlain extends BaseHandler {
    override preview(content: string | Uint8Array): Preview {
        const text = typeof content === "string" ? content : "";
        return { kind: "text", text, orientation: "head" };
    }
}
