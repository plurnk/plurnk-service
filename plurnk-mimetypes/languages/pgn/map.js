import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import PGNVisitor from "./generated/PGNVisitor.js";

class Extractor extends withExtractor(PGNVisitor) {
	visitPgn_game(ctx) {
		const tagSection = ctx.tag_section?.();
		const pairs = tagSection?.tag_pair?.() ?? [];
		let eventName = "Unknown Game";
		const fields = [];
		for (const pair of pairs) {
			const tagName = pair.tag_name?.()?.getText();
			const tagValue = pair.tag_value?.()?.getText()?.replace(/^"|"$/g, "");
			if (!tagName) continue;
			if (tagName === "Event" && tagValue) eventName = tagValue;
			fields.push({ name: tagName, value: tagValue });
		}
		this._add("class", eventName, ctx);
		for (const { name } of fields) {
			this._add("field", name, ctx);
		}
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "parse",
	extensions: [".pgn"],
});
