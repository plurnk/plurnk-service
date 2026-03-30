import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import awkVisitor from "./generated/awkVisitor.js";

class Extractor extends withExtractor(awkVisitor) {
	visitItem(ctx) {
		const funcName = ctx.func_name?.();
		if (funcName) {
			const name = funcName.getText();
			const paramList = ctx.param_list_opt?.()?.param_list?.();
			const params = paramList?.name?.()?.map((n) => n.getText()) ?? [];
			this._add("function", name, ctx, params);
			return null;
		}
		const pattern = ctx.pattern?.();
		const specialPattern = pattern?.special_pattern?.();
		if (specialPattern) {
			const begin = specialPattern.BEGIN?.();
			const end = specialPattern.END?.();
			if (begin) this._add("function", "BEGIN", ctx);
			if (end) this._add("function", "END", ctx);
			return null;
		}
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "program",
	extensions: [".awk"],
});
