import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import ElixirParserVisitor from "./generated/ElixirParserVisitor.js";

class Extractor extends withExtractor(ElixirParserVisitor) {
	#extractParams(expressionsList) {
		if (!expressionsList) return [];
		const exprs = expressionsList.expression?.() ?? [];
		return exprs.map((e) => e.getText());
	}

	visitModule_def(ctx) {
		if (this._inBody) return null;
		const alias = ctx.ALIAS?.();
		if (alias) this._add("module", alias.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitFunction_def(ctx) {
		if (this._inBody) return null;
		const variable = ctx.variable?.();
		if (variable) {
			const paramLists = ctx.expressions_?.() ?? [];
			const params =
				paramLists.length > 0 ? this.#extractParams(paramLists[0]) : [];
			this._add("function", variable.getText(), ctx, params);
		}
		const was = this._inBody;
		this._inBody = true;
		this.visitChildren(ctx);
		this._inBody = was;
		return null;
	}

	visitMacro_def(ctx) {
		if (this._inBody) return null;
		const variable = ctx.variable?.();
		if (variable) {
			const params = this.#extractParams(ctx.expressions_?.());
			this._add("function", variable.getText(), ctx, params);
		}
		const was = this._inBody;
		this._inBody = true;
		this.visitChildren(ctx);
		this._inBody = was;
		return null;
	}

	visitAnonymous_function() {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "parse",
	extensions: [".ex", ".exs"],
});
