import RustParserVisitor from "./generated/RustParserVisitor.js";

class SymbolExtractor extends RustParserVisitor {
	#symbols = [];
	#inBody = false;
	#inImpl = false;

	get symbols() {
		return this.#symbols;
	}

	#add(kind, name, ctx, params) {
		const symbol = {
			name,
			kind,
			line: ctx.start.line,
			endLine: ctx.stop?.line ?? ctx.start.line,
		};
		if (params) symbol.params = params;
		this.#symbols.push(symbol);
	}

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

	// Scope boundary: blockExpression inside function_ is the wall.
	visitBlockExpression(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitFunction_(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) {
			const params = this.#extractParams(ctx.functionParameters?.());
			const kind = this.#inImpl ? "method" : "function";
			this.#add(kind, id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitStructStruct(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitTupleStruct(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("class", id.getText(), ctx);
		return null;
	}

	visitStructField(ctx) {
		const id = ctx.identifier();
		if (id) this.#add("field", id.getText(), ctx);
		return null;
	}

	visitEnumeration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("enum", id.getText(), ctx);
		return null;
	}

	visitTrait_(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("interface", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInherentImpl(ctx) {
		if (this.#inBody) return null;
		const wasInImpl = this.#inImpl;
		this.#inImpl = true;
		this.visitChildren(ctx);
		this.#inImpl = wasInImpl;
		return null;
	}

	visitTraitImpl(ctx) {
		if (this.#inBody) return null;
		const wasInImpl = this.#inImpl;
		this.#inImpl = true;
		this.visitChildren(ctx);
		this.#inImpl = wasInImpl;
		return null;
	}

	visitTypeAlias(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("type", id.getText(), ctx);
		return null;
	}

	visitModule(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("module", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitConstantItem(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("constant", id.getText(), ctx);
		return null;
	}

	visitStaticItem(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("variable", id.getText(), ctx);
		return null;
	}

	visitUnion_(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitUseDeclaration() {
		return null;
	}

	visitExternCrate() {
		return null;
	}
}

export default class RustMap {
	static status = "done";
	static entryRule = "crate";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
