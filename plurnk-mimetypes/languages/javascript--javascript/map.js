import JavaScriptParserVisitor from "./generated/JavaScriptParserVisitor.js";

class SymbolExtractor extends JavaScriptParserVisitor {
	#symbols = [];
	#inBody = false;
	#inExport = false;

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

	#extractParams(formalParameterList) {
		if (!formalParameterList) return [];
		const params = [];
		const args = formalParameterList.formalParameterArg?.() ?? [];
		for (const arg of args) {
			const assignable = arg.assignable?.();
			const id = assignable?.identifier?.()?.getText() ?? assignable?.getText();
			if (id) params.push(id);
		}
		const rest = formalParameterList.lastFormalParameterArg?.();
		if (rest) params.push(`...${rest.singleExpression()?.getText()}`);
		return params;
	}

	// Semantic boundary: functionBody is the scope wall.
	visitFunctionBody(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitFunctionDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) {
			const params = this.#extractParams(ctx.formalParameterList?.());
			this.#add("function", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitClassDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitMethodDefinition(ctx) {
		const name = ctx.classElementName?.();
		const getter = ctx.getter?.();
		const setter = ctx.setter?.();
		const label = name?.getText() ?? getter?.getText() ?? setter?.getText();
		if (label) {
			const params = this.#extractParams(ctx.formalParameterList?.());
			this.#add("method", label, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitFieldDefinition(ctx) {
		const name = ctx.classElementName?.();
		if (!name) return null;
		const text = name.getText();
		// async/static are modifiers, not field names — the parser can
		// misparse them as fieldDefinition in some class element patterns
		if (text === "async" || text === "static" || text === "get" || text === "set") return null;
		this.#add("field", text, ctx);
		return null;
	}

	visitImportStatement() {
		return null;
	}

	visitExportDeclaration(ctx) {
		this.#inExport = true;
		this.visitChildren(ctx);
		this.#inExport = false;
		return null;
	}

	visitExportDefaultDeclaration(ctx) {
		return this.visitChildren(ctx);
	}

	// Variables are only visible outside the file if exported
	visitVariableDeclaration(ctx) {
		if (this.#inBody) return null;
		if (!this.#inExport) return null;
		const assignable = ctx.assignable?.();
		const id = assignable?.identifier?.();
		if (id) this.#add("variable", id.getText(), ctx);
		return null;
	}
}

export default class JavaScriptMap {
	static status = "done";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
