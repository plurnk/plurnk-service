import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import MarkdownParserVisitor from "./generated/MarkdownParserVisitor.js";

const ATX_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?\n?$/;

class Extractor extends withExtractor(MarkdownParserVisitor) {
	visitAtxHeading(ctx) {
		const raw = ctx.ATX_LINE().getText();
		const match = ATX_PATTERN.exec(raw);
		if (!match) return null;
		const name = match[2].trim();
		if (!name) return null;
		this._add("heading", name, ctx, undefined, { level: match[1].length });
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "document",
	extensions: [".md", ".markdown"],
});
