import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import matlabVisitor from "./generated/matlabVisitor.js";

class Extractor extends withExtractor(matlabVisitor) {
	visitTranslation_unit(ctx) {
		const funcDecl = ctx.function_declare?.();
		if (funcDecl) {
			const lhs = funcDecl.function_declare_lhs?.();
			if (lhs) {
				const name = lhs.IDENTIFIER?.().getText();
				const params = this.#extractParams(lhs);
				if (name) this._add("function", name, ctx, params);
			}
		}
		return this.visitChildren(ctx);
	}

	#extractParams(lhs) {
		if (!lhs) return [];
		const identList = lhs.func_ident_list?.();
		if (!identList) return [];
		const ids = identList.IDENTIFIER?.() ?? [];
		return ids.map((id) => id.getText());
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "file_",
	extensions: [".m"],
});
