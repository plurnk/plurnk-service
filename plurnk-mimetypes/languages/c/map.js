import CParserVisitor from "./generated/CParserVisitor.js";

class SymbolExtractor extends CParserVisitor {
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
		const direct = declarator.directDeclarator?.();
		if (!direct) return null;
		const id = direct.Identifier?.();
		if (id) return id.getText();
		const nested = direct.declarator?.();
		if (nested) return this.#extractDeclaratorName(nested);
		return null;
	}

	#extractParams(declarator) {
		if (!declarator) return [];
		const direct = declarator.directDeclarator?.();
		if (!direct) return [];
		const paramTypeList = direct.parameterTypeList?.();
		if (!paramTypeList) return [];
		const paramList = paramTypeList.parameterList?.();
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

	// Scope boundary: compoundStatement inside functionDefinition
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

	visitStructOrUnionSpecifier(ctx) {
		if (this.#inBody) return null;
		const id = ctx.Identifier?.();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitEnumSpecifier(ctx) {
		if (this.#inBody) return null;
		const id = ctx.Identifier?.();
		if (id) this.#add("enum", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitDeclaration(ctx) {
		if (this.#inBody) return null;
		return this.visitChildren(ctx);
	}
}

export default class CMap {
	static status = "done";
	static entryRule = "compilationUnit";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
