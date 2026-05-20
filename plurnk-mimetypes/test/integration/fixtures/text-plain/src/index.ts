import BaseHandler from "../../../../../src/BaseHandler.ts";

// Minimal handler: BaseHandler defaults are sufficient for text/plain. No
// extract overrides, no validate overrides. Demonstrates that the framework's
// "empty class extends BaseHandler" case produces a working handler.
export default class TextPlain extends BaseHandler {}
