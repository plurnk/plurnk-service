import Python3ParserVisitor from "./generated/Python3ParserVisitor.js";

class SymbolExtractor extends Python3ParserVisitor {
	#symbols = [];
	#inBody = false;
	#inClassBody = false;

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

	#extractParams(parameters) {
		if (!parameters) return [];
		const typedargslist = parameters.typedargslist?.();
		if (!typedargslist) return [];
		const params = [];
		const tfpdefs = typedargslist.tfpdef?.() ?? [];
		const children = typedargslist.children ?? [];
		for (const tfp of tfpdefs) {
			const paramName = tfp.name?.()?.getText();
			if (!paramName) continue;
			// Walk backwards from tfpdef to find * or ** prefix
			const idx = children.indexOf(tfp);
			let prefix = "";
			if (idx > 0) {
				const prev = children[idx - 1];
				const text = prev.getText?.();
				if (text === "**") prefix = "**";
				else if (text === "*") prefix = "*";
			}
			params.push(prefix + paramName);
		}
		return params;
	}

	// Scope boundary: block inside funcdef is the scope wall.
	// But we must still visit class bodies to find methods/fields.
	visitBlock(ctx) {
		if (this.#inClassBody) return this.visitChildren(ctx);
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitFuncdef(ctx) {
		const nameNode = ctx.name?.();
		if (!nameNode) return this.visitChildren(ctx);
		const name = nameNode.getText();
		const params = this.#extractParams(ctx.parameters?.());
		const kind = this.#inClassBody ? "method" : "function";
		if (this.#inBody && !this.#inClassBody) return null;
		this.#add(kind, name, ctx, params);
		// Visit the block to find nested classes (but not local vars)
		const wasInClassBody = this.#inClassBody;
		this.#inClassBody = false;
		this.visitChildren(ctx);
		this.#inClassBody = wasInClassBody;
		return null;
	}

	visitAsync_funcdef(ctx) {
		return this.visitChildren(ctx);
	}

	visitClassdef(ctx) {
		if (this.#inBody && !this.#inClassBody) return null;
		const nameNode = ctx.name?.();
		if (nameNode) this.#add("class", nameNode.getText(), ctx);
		const wasInClassBody = this.#inClassBody;
		const wasInBody = this.#inBody;
		this.#inClassBody = true;
		this.#inBody = false;
		this.visitChildren(ctx);
		this.#inClassBody = wasInClassBody;
		this.#inBody = wasInBody;
		return null;
	}

	visitDecorated(ctx) {
		return this.visitChildren(ctx);
	}

	// Class-level assignments are fields (e.g., `x = 10` or `x: int = 10`)
	visitExpr_stmt(ctx) {
		if (!this.#inClassBody || this.#inBody) return null;
		const hasAssign = ctx.ASSIGN?.(0) || ctx.annassign?.();
		if (!hasAssign) return null;
		const target = ctx.testlist_star_expr?.(0);
		if (!target) return null;
		const text = target.getText();
		// Only capture simple name assignments, not dotted or complex expressions
		if (/^[a-zA-Z_]\w*$/.test(text)) {
			this.#add("field", text, ctx);
		}
		return null;
	}

	visitImport_stmt() {
		return null;
	}
}

export default class Python3Map {
	static status = "done";
	static entryRule = "file_input";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
