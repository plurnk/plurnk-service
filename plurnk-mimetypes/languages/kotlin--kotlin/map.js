import KotlinParserVisitor from "./generated/KotlinParserVisitor.js";

class SymbolExtractor extends KotlinParserVisitor {
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

	#extractParams(ctx) {
		const fvp = ctx.functionValueParameters?.();
		if (!fvp) return [];
		const params = [];
		const fvps = fvp.functionValueParameter?.() ?? [];
		for (const p of fvps) {
			const param = p.parameter?.();
			if (param) {
				const id = param.simpleIdentifier?.();
				if (id) params.push(id.getText());
			}
		}
		return params;
	}

	// Scope boundary: functionBody
	visitFunctionBody(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitClassBody(ctx) {
		const wasInClassBody = this.#inClassBody;
		this.#inClassBody = true;
		this.visitChildren(ctx);
		this.#inClassBody = wasInClassBody;
		return null;
	}

	visitClassDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.simpleIdentifier?.();
		if (id) {
			const modifiers = ctx.modifierList?.()?.getText() ?? "";
			const kind =
				modifiers.includes("interface") || ctx.INTERFACE?.()
					? "interface"
					: "class";
			this.#add(kind, id.getText(), ctx);
		}
		return this.visitChildren(ctx);
	}

	visitObjectDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.simpleIdentifier?.();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitCompanionObject(ctx) {
		const id = ctx.simpleIdentifier?.();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitFunctionDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx);
			const kind = this.#inClassBody ? "method" : "function";
			this.#add(kind, id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitPropertyDeclaration(ctx) {
		if (this.#inBody) return null;
		const varDecl = ctx.variableDeclaration?.();
		if (varDecl) {
			const id = varDecl.simpleIdentifier?.();
			if (id) {
				const kind = this.#inClassBody ? "field" : "variable";
				this.#add(kind, id.getText(), ctx);
			}
		}
		const multiVar = ctx.multiVariableDeclaration?.();
		if (multiVar) {
			const decls = multiVar.variableDeclaration?.() ?? [];
			for (const decl of decls) {
				const id = decl.simpleIdentifier?.();
				if (id) {
					const kind = this.#inClassBody ? "field" : "variable";
					this.#add(kind, id.getText(), ctx);
				}
			}
		}
		return null;
	}

	visitTypeAlias(ctx) {
		if (this.#inBody) return null;
		const id = ctx.simpleIdentifier?.();
		if (id) this.#add("type", id.getText(), ctx);
		return null;
	}

	visitSecondaryConstructor(ctx) {
		const params = [];
		const fvp = ctx.functionValueParameters?.();
		if (fvp) {
			const fvps = fvp.functionValueParameter?.() ?? [];
			for (const p of fvps) {
				const param = p.parameter?.();
				if (param) {
					const id = param.simpleIdentifier?.();
					if (id) params.push(id.getText());
				}
			}
		}
		this.#add("method", "constructor", ctx, params);
		return null;
	}

	visitImportHeader() {
		return null;
	}

	visitPackageHeader() {
		return null;
	}
}

export default class KotlinMap {
	static status = "done";
	static entryRule = "kotlinFile";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
