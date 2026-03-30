import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import RustParserVisitor from "./generated/RustParserVisitor.js";

class Extractor extends withExtractor(RustParserVisitor) {
	#inImpl = false;

	#extractParams(functionParameters) {
		if (!functionParameters) return [];
		const params = [];
		const selfParam = functionParameters.selfParam?.();
		if (selfParam) {
			const shorthand = selfParam.shorthandSelf?.();
			if (shorthand) {
				const hasRef = shorthand.AND?.();
				const hasMut = shorthand.KW_MUT?.();
				let text = "self";
				if (hasRef && hasMut) text = "&mut self";
				else if (hasRef) text = "&self";
				params.push(text);
			}
			const typed = selfParam.typedSelf?.();
			if (typed) {
				const hasMut = typed.KW_MUT?.();
				params.push(hasMut ? "mut self" : "self");
			}
		}
		const functionParams = functionParameters.functionParam?.() ?? [];
		for (const fp of functionParams) {
			const pattern = fp.functionParamPattern?.();
			if (pattern) {
				const pat = pattern.pattern?.();
				if (pat) params.push(pat.getText());
				continue;
			}
			if (fp.DOTDOTDOT?.()) {
				params.push("...");
			}
		}
		return params;
	}

	visitBlockExpression(ctx) {
		return this._gateBody(ctx);
	}

	visitFunction_(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) {
			const params = this.#extractParams(ctx.functionParameters?.());
			const kind = this.#inImpl ? "method" : "function";
			this._add(kind, id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitStructStruct(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitTupleStruct(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("class", id.getText(), ctx);
		return null;
	}

	visitStructField(ctx) {
		const id = ctx.identifier();
		if (id) this._add("field", id.getText(), ctx);
		return null;
	}

	visitEnumeration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("enum", id.getText(), ctx);
		return null;
	}

	visitTrait_(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("interface", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInherentImpl(ctx) {
		if (this._inBody) return null;
		const type = ctx.type_?.();
		if (type) this._add("class", type.getText(), ctx);
		const wasInImpl = this.#inImpl;
		this.#inImpl = true;
		this.visitChildren(ctx);
		this.#inImpl = wasInImpl;
		return null;
	}

	visitTraitImpl(ctx) {
		if (this._inBody) return null;
		const type = ctx.type_?.();
		if (type) this._add("class", type.getText(), ctx);
		const wasInImpl = this.#inImpl;
		this.#inImpl = true;
		this.visitChildren(ctx);
		this.#inImpl = wasInImpl;
		return null;
	}

	visitTypeAlias(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("type", id.getText(), ctx);
		return null;
	}

	visitModule(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("module", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitConstantItem(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("constant", id.getText(), ctx);
		return null;
	}

	visitStaticItem(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("variable", id.getText(), ctx);
		return null;
	}

	visitUnion_(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitUseDeclaration() {
		return null;
	}

	visitExternCrate() {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "crate",
	extensions: [".rs"],
});
