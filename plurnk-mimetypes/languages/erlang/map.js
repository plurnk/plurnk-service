import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import ErlangVisitor from "./generated/ErlangVisitor.js";

class Extractor extends withExtractor(ErlangVisitor) {
	#seenFunctions = new Set();

	visitAttribute(ctx) {
		const atom = ctx.tokAtom?.()?.getText();
		if (atom === "module") {
			const val = ctx.attrVal?.();
			const name = this.#firstAtom(val);
			if (name) this._add("module", name, ctx);
		}
		if (atom === "record") {
			const val = ctx.attrVal?.();
			const name = this.#firstAtom(val);
			if (name) this._add("class", name, ctx);
		}
		if (atom === "type" || atom === "opaque") {
			const val = ctx.typedAttrVal?.() ?? ctx.attrVal?.();
			const name = this.#firstAtom(val);
			if (name) this._add("type", name, ctx);
		}
		return null;
	}

	visitTypeSpec(ctx) {
		const specFun = ctx.specFun?.();
		const name = specFun?.tokAtom?.(0)?.getText();
		if (name) this._add("type", `-spec ${name}`, ctx);
		return null;
	}

	visitFunction_(ctx) {
		const clauses = ctx.functionClause?.() ?? [];
		const first = clauses[0];
		if (!first) return null;
		const name = first.tokAtom?.()?.getText();
		const arity =
			first.clauseArgs?.()?.patArgumentList?.()?.exprs?.()?.expr?.()?.length ??
			0;
		const key = `${name}/${arity}`;
		if (name && !this.#seenFunctions.has(key)) {
			this.#seenFunctions.add(key);
			this._add("function", key, ctx);
		}
		return null;
	}

	#firstAtom(node) {
		if (!node) return null;
		const text = node.getText();
		const match = text.match(/^[(\s]*([a-z_]\w*|'[^']*')/);
		return match ? match[1].replace(/'/g, "") : null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "forms",
	extensions: [".erl", ".hrl"],
});
