import CPP14ParserVisitor from "./generated/CPP14ParserVisitor.js";

class SymbolExtractor extends CPP14ParserVisitor {
	#symbols = [];
	#inBody = false;

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

	#extractDeclaratorName(declarator) {
		if (!declarator) return null;
		const ptrDecl = declarator.pointerDeclarator?.();
		if (ptrDecl) {
			const noPtrDecl = ptrDecl.noPointerDeclarator?.();
			if (noPtrDecl) return this.#extractNoPointerDeclaratorName(noPtrDecl);
		}
		const noPtrDecl = declarator.noPointerDeclarator?.();
		if (noPtrDecl) return this.#extractNoPointerDeclaratorName(noPtrDecl);
		return null;
	}

	#extractNoPointerDeclaratorName(noPtrDecl) {
		if (!noPtrDecl) return null;
		const declId = noPtrDecl.declaratorId?.();
		if (declId) {
			const idExpr = declId.idExpression?.();
			if (idExpr) {
				const unqual = idExpr.unqualifiedId?.();
				if (unqual) {
					const id = unqual.Identifier?.();
					if (id) return id.getText();
					const tplId = unqual.templateId?.();
					if (tplId) {
						const stpl = tplId.simpleTemplateId?.();
						if (stpl) {
							const tname = stpl.templateName?.();
							if (tname) return tname.Identifier?.()?.getText() ?? null;
						}
					}
				}
				const qual = idExpr.qualifiedId?.();
				if (qual) {
					const unqual2 = qual.unqualifiedId?.();
					if (unqual2) {
						const id2 = unqual2.Identifier?.();
						if (id2) return id2.getText();
					}
				}
			}
		}
		const nested = noPtrDecl.noPointerDeclarator?.();
		if (nested) return this.#extractNoPointerDeclaratorName(nested);
		const ptrDecl = noPtrDecl.pointerDeclarator?.();
		if (ptrDecl) {
			const inner = ptrDecl.noPointerDeclarator?.();
			if (inner) return this.#extractNoPointerDeclaratorName(inner);
		}
		return null;
	}

	#extractParams(declarator) {
		if (!declarator) return [];
		const noPtrDecl = this.#findParamsDeclarator(declarator);
		if (!noPtrDecl) return [];
		const paq = noPtrDecl.parametersAndQualifiers?.();
		if (!paq) return [];
		const clause = paq.parameterDeclarationClause?.();
		if (!clause) return [];
		const paramList = clause.parameterDeclarationList?.();
		if (!paramList) return [];
		const params = [];
		const decls = paramList.parameterDeclaration?.() ?? [];
		for (const decl of decls) {
			const d = decl.declarator?.();
			if (d) {
				const name = this.#extractDeclaratorName(d);
				if (name) params.push(name);
			}
		}
		return params;
	}

	#findParamsDeclarator(declarator) {
		const ptrDecl = declarator.pointerDeclarator?.();
		if (ptrDecl) {
			const noPtrDecl = ptrDecl.noPointerDeclarator?.();
			if (noPtrDecl?.parametersAndQualifiers?.()) return noPtrDecl;
			if (noPtrDecl?.noPointerDeclarator?.()?.parametersAndQualifiers?.())
				return noPtrDecl.noPointerDeclarator();
		}
		const noPtrDecl = declarator.noPointerDeclarator?.();
		if (noPtrDecl?.parametersAndQualifiers?.()) return noPtrDecl;
		return null;
	}

	// Scope boundary: compoundStatement inside functionBody
	visitCompoundStatement(ctx) {
		if (this.#inBody) return this.visitChildren(ctx);
		return this.visitChildren(ctx);
	}

	visitFunctionBody(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitFunctionDefinition(ctx) {
		if (this.#inBody) return null;
		const declarator = ctx.declarator?.();
		const name = this.#extractDeclaratorName(declarator);
		if (name) {
			const params = this.#extractParams(declarator);
			this.#add("function", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitClassSpecifier(ctx) {
		if (this.#inBody) return null;
		const head = ctx.classHead?.();
		if (head) {
			const headName = head.classHeadName?.();
			if (headName) {
				const className = headName.className?.();
				if (className) {
					const id = className.Identifier?.();
					if (id) this.#add("class", id.getText(), ctx);
				}
			}
		}
		return this.visitChildren(ctx);
	}

	visitEnumSpecifier(ctx) {
		if (this.#inBody) return null;
		const head = ctx.enumHead?.();
		if (head) {
			const id = head.Identifier?.();
			if (id) this.#add("enum", id.getText(), ctx);
		}
		return this.visitChildren(ctx);
	}

	visitNamespaceDefinition(ctx) {
		if (this.#inBody) return null;
		const id = ctx.Identifier?.();
		const origName = ctx.originalNamespaceName?.();
		const name = id?.getText() ?? origName?.Identifier?.()?.getText();
		if (name) this.#add("module", name, ctx);
		return this.visitChildren(ctx);
	}

	visitAliasDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.Identifier?.();
		if (id) this.#add("type", id.getText(), ctx);
		return null;
	}
}

export default class CppMap {
	static status = "done";
	static entryRule = "translationUnit";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
