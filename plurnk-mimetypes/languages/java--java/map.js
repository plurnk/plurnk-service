import JavaParserVisitor from "./generated/JavaParserVisitor.js";

class SymbolExtractor extends JavaParserVisitor {
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

	#extractParams(formalParametersCtx) {
		if (!formalParametersCtx) return [];
		const params = [];
		const firstParam = formalParametersCtx.formalParameter?.();
		if (firstParam) params.push(this.#paramName(firstParam));
		const lists = formalParametersCtx.formalParameterList?.() ?? [];
		for (const list of lists) {
			const fps = list.formalParameter?.() ?? [];
			for (const fp of fps) params.push(this.#paramName(fp));
		}
		return params;
	}

	#paramName(formalParam) {
		const id = formalParam.variableDeclaratorId?.()?.identifier?.()?.getText();
		const hasEllipsis = formalParam.ELLIPSIS?.() != null;
		if (hasEllipsis) return `...${id}`;
		return id;
	}

	// Scope boundary: methodBody blocks hide local declarations.
	visitMethodBody(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	// constructorDeclaration uses `constructorBody = block`, so the block is the boundary.
	visitConstructorDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameters?.());
			this.#add("method", id.getText(), ctx, params);
		}
		const wasInBody = this.#inBody;
		this.#inBody = true;
		const body = ctx.block?.();
		if (body) this.visit(body);
		this.#inBody = wasInBody;
		return null;
	}

	// compactConstructorDeclaration also uses `constructorBody = block`.
	visitCompactConstructorDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) this.#add("method", id.getText(), ctx);
		const wasInBody = this.#inBody;
		this.#inBody = true;
		const body = ctx.block?.();
		if (body) this.visit(body);
		this.#inBody = wasInBody;
		return null;
	}

	visitPackageDeclaration(ctx) {
		const name = ctx.qualifiedName?.()?.getText();
		if (name) this.#add("module", name, ctx);
		return null;
	}

	visitImportDeclaration() {
		return null;
	}

	visitClassDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInterfaceDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("interface", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitEnumDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("enum", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitRecordDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitAnnotationTypeDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("interface", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitMethodDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameters?.());
			this.#add("method", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitInterfaceCommonBodyDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameters?.());
			this.#add("method", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitFieldDeclaration(ctx) {
		const declarators =
			ctx.variableDeclarators?.()?.variableDeclarator?.() ?? [];
		for (const decl of declarators) {
			const id = decl.variableDeclaratorId?.()?.identifier?.();
			if (id) this.#add("field", id.getText(), ctx);
		}
		return null;
	}

	visitConstDeclaration(ctx) {
		const declarators = ctx.constantDeclarator?.() ?? [];
		for (const decl of declarators) {
			const id = decl.identifier?.();
			if (id) this.#add("field", id.getText(), ctx);
		}
		return null;
	}
}

export default class JavaMap {
	static status = "done";
	static entryRule = "compilationUnit";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
