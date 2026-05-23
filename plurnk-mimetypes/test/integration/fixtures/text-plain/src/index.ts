import BaseHandler from "../../../../../src/BaseHandler.ts";
import type { Preview } from "../../../../../src/types.ts";

// Canonical text/plain shape: the entire content is the preview material,
// head-oriented. Mirrors @plurnk/plurnk-mimetypes-text-plain's v0.4.0 contract
// so the integration test exercises the framework's text-fitting path.
export default class TextPlain extends BaseHandler {
    override preview(content: string | Uint8Array): Preview {
        const text = typeof content === "string" ? content : "";
        return { kind: "text", text, orientation: "head" };
    }
}
