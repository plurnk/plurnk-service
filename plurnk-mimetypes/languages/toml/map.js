import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import TomlParserVisitor from "./generated/TomlParserVisitor.js";

class Extractor extends withExtractor(TomlParserVisitor) {
	visitStandard_table(ctx) {
		const key = ctx.key?.()?.getText();
		if (key) this._add("module", key, ctx);
		return null;
	}

	visitArray_table(ctx) {
		const key = ctx.key?.()?.getText();
		if (key) this._add("module", key, ctx);
		return null;
	}

	visitKey_value(ctx) {
		const key = ctx.key?.()?.getText();
		if (key) this._add("field", key, ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "document",
	extensions: [".toml"],
});
