import PhpParserVisitor from "./generated/PhpParserVisitor.js";

class SymbolExtractor extends PhpParserVisitor {
	#symbols = [];
	#inBody = false;
	#inClass = false;

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
		const fps = formalParameterList.formalParameter?.() ?? [];
		for (const fp of fps) {
			const varInit = fp.variableInitializer?.();
			if (varInit) {
				const varName = varInit.VarName?.();
				if (varName) params.push(varName.getText());
			}
		}
		return params;
	}

	// Scope boundary: blockStatement inside functions
	visitBlockStatement(ctx) {
		if (this.#inBody) return this.visitChildren(ctx);
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitFunctionDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameterList?.());
			this.#add("function", id.getText(), ctx, params);
		}
		// Don't visit children — blockStatement inside will set inBody
		return this.visitChildren(ctx);
	}

	visitClassDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) {
			const isInterface = ctx.Interface?.();
			this.#add(isInterface ? "interface" : "class", id.getText(), ctx);
		}
		const wasInClass = this.#inClass;
		const wasInBody = this.#inBody;
		this.#inClass = true;
		this.#inBody = false;
		this.visitChildren(ctx);
		this.#inClass = wasInClass;
		this.#inBody = wasInBody;
		return null;
	}

	visitEnumDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("enum", id.getText(), ctx);
		const wasInClass = this.#inClass;
		const wasInBody = this.#inBody;
		this.#inClass = true;
		this.#inBody = false;
		this.visitChildren(ctx);
		this.#inClass = wasInClass;
		this.#inBody = wasInBody;
		return null;
	}

	visitNamespaceDeclaration(ctx) {
		if (this.#inBody) return null;
		const nameList = ctx.namespaceNameList?.();
		if (nameList) this.#add("module", nameList.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitClassStatement(ctx) {
		const fnToken = ctx.Function_?.();
		if (fnToken) {
			const id = ctx.identifier?.();
			if (id) {
				const params = this.#extractParams(ctx.formalParameterList?.());
				this.#add("method", id.getText(), ctx, params);
			}
			return null;
		}
		const propMods = ctx.propertyModifiers?.();
		if (propMods) {
			const varInits = ctx.variableInitializer?.() ?? [];
			for (const vi of varInits) {
				const varName = vi.VarName?.();
				if (varName) this.#add("field", varName.getText(), ctx);
			}
			return null;
		}
		return this.visitChildren(ctx);
	}

	visitGlobalConstantDeclaration(ctx) {
		if (this.#inBody) return null;
		const inits = ctx.identifierInitializer?.() ?? [];
		for (const init of inits) {
			const id = init.identifier?.();
			if (id) this.#add("constant", id.getText(), ctx);
		}
		return null;
	}

	visitImportStatement() {
		return null;
	}

	visitUseDeclaration() {
		return null;
	}
}

export default class PhpMap {
	static status = "done";
	static entryRule = "htmlDocument";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
