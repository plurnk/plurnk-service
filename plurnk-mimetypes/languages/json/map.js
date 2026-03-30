import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import JSONVisitor from "./generated/JSONVisitor.js";

class Extractor extends withExtractor(JSONVisitor) {
	#depth = -1;

	visitPair(ctx) {
		if (this.#depth > 0) return null;
		const key = ctx.STRING?.()?.getText()?.slice(1, -1);
		if (key) this._add("field", key, ctx);
		return null;
	}

	visitObj(ctx) {
		this.#depth++;
		this.visitChildren(ctx);
		this.#depth--;
		return null;
	}

	visitArr(_ctx) {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "json",
	extensions: [".json", ".jsonc", ".json5"],
});
