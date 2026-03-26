import GoParserVisitor from "./generated/GoParserVisitor.js";

class SymbolExtractor extends GoParserVisitor {
	#symbols = [];
	#inBlock = false;

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

	#extractParams(signature) {
		if (!signature) return [];
		const parameters = signature.parameters?.();
		if (!parameters) return [];
		const decls = parameters.parameterDecl?.() ?? [];
		const params = [];
		for (const decl of decls) {
			const idList = decl.identifierList?.();
			const isVariadic = !!decl.ELLIPSIS?.();
			if (idList) {
				const ids = idList.IDENTIFIER?.() ?? [];
				for (let i = 0; i < ids.length; i++) {
					const name = ids[i].getText();
					if (isVariadic && i === ids.length - 1) {
						params.push(`...${name}`);
					} else {
						params.push(name);
					}
				}
			}
		}
		return params;
	}

	#resolveTypeDefKind(ctx) {
		const typeCtx = ctx.type_?.();
		const typeLit = typeCtx?.typeLit?.();
		if (typeLit?.structType?.()) return "class";
		if (typeLit?.interfaceType?.()) return "interface";
		return "type";
	}

	// Scope boundary: block inside functionDecl/methodDecl
	visitBlock(ctx) {
		const wasInBlock = this.#inBlock;
		this.#inBlock = true;
		this.visitChildren(ctx);
		this.#inBlock = wasInBlock;
		return null;
	}

	visitPackageClause(ctx) {
		const name = ctx.packageName?.()?.identifier?.()?.getText();
		if (name) this.#add("module", name, ctx);
		return null;
	}

	visitImportDecl() {
		return null;
	}

	visitFunctionDecl(ctx) {
		if (this.#inBlock) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) {
			const params = this.#extractParams(ctx.signature?.());
			this.#add("function", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitMethodDecl(ctx) {
		if (this.#inBlock) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) {
			const params = this.#extractParams(ctx.signature?.());
			this.#add("method", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitTypeDef(ctx) {
		if (this.#inBlock) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) {
			const kind = this.#resolveTypeDefKind(ctx);
			this.#add(kind, name, ctx);
		}
		return null;
	}

	visitAliasDecl(ctx) {
		if (this.#inBlock) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) this.#add("type", name, ctx);
		return null;
	}

	visitConstSpec(ctx) {
		if (this.#inBlock) return null;
		const idList = ctx.identifierList?.();
		if (!idList) return null;
		const ids = idList.IDENTIFIER?.() ?? [];
		for (const id of ids) {
			this.#add("constant", id.getText(), ctx);
		}
		return null;
	}

	visitVarSpec(ctx) {
		if (this.#inBlock) return null;
		const idList = ctx.identifierList?.();
		if (!idList) return null;
		const ids = idList.IDENTIFIER?.() ?? [];
		for (const id of ids) {
			this.#add("variable", id.getText(), ctx);
		}
		return null;
	}
}

export default class GolangMap {
	static status = "done";
	static entryRule = "sourceFile";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
