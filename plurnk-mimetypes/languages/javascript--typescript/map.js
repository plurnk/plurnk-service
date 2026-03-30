import TypeScriptParserVisitor from "./generated/TypeScriptParserVisitor.js";

class SymbolExtractor extends TypeScriptParserVisitor {
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

	#extractFormalParams(formalParameterList) {
		if (!formalParameterList) return [];
		const params = [];
		const args = formalParameterList.formalParameterArg?.() ?? [];
		for (const arg of args) {
			const assignable = arg.assignable?.();
			const id = assignable?.identifier?.()?.getText() ?? assignable?.getText();
			if (id) params.push(id);
		}
		const rest = formalParameterList.lastFormalParameterArg?.();
		if (rest) params.push(`...${rest.identifier()?.getText()}`);
		return params;
	}

	#extractParams(parameterList) {
		if (!parameterList) return [];
		const params = [];
		const paramNodes = parameterList.parameter?.() ?? [];
		for (const param of paramNodes) {
			const required = param.requiredParameter?.();
			const optional = param.optionalParameter?.();
			const node = required ?? optional;
			if (!node) continue;
			const iop = node.identifierOrPattern?.();
			const name =
				iop?.identifierName?.()?.getText() ??
				iop?.bindingPattern?.()?.getText();
			if (name) params.push(name);
		}
		const rest = parameterList.restParameter?.();
		if (rest) params.push(`...${rest.singleExpression()?.getText()}`);
		return params;
	}

	#extractCallSignatureParams(callSignature) {
		if (!callSignature) return [];
		return this.#extractParams(callSignature.parameterList?.());
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
			const params = this.#extractCallSignatureParams(ctx.callSignature?.());
			this.#add("function", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitGeneratorFunctionDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) {
			const params = this.#extractFormalParams(ctx.formalParameterList?.());
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

	visitInterfaceDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("interface", id.getText(), ctx);
		return null;
	}

	visitTypeAliasDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("type", id.getText(), ctx);
		return null;
	}

	visitEnumDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier();
		if (id) this.#add("enum", id.getText(), ctx);
		return null;
	}

	visitNamespaceDeclaration(ctx) {
		if (this.#inBody) return null;
		const name = ctx.namespaceName();
		if (name) this.#add("module", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitConstructorDeclaration(ctx) {
		const params = this.#extractFormalParams(ctx.formalParameterList?.());
		this.#add("method", "constructor", ctx, params);
		return this.visitChildren(ctx);
	}

	// propertyMemberBase propertyName callSignature (('{' functionBody '}') | SemiColon)
	visitMethodDeclarationExpression(ctx) {
		const name = ctx.propertyName?.()?.getText();
		if (name) {
			const params = this.#extractCallSignatureParams(ctx.callSignature?.());
			this.#add("method", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	// propertyMemberBase (getAccessor | setAccessor)
	visitGetterSetterDeclarationExpression(ctx) {
		const getter = ctx.getAccessor?.();
		const setter = ctx.setAccessor?.();
		// classElementName is inside the getter/setter rule, not on getAccessor/setAccessor directly
		const name =
			getter?.getter?.()?.classElementName?.()?.getText() ??
			setter?.setter?.()?.classElementName?.()?.getText();
		if (name) {
			const params = setter
				? this.#extractFormalParams(setter.formalParameterList?.())
				: [];
			this.#add("method", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	// propertyMemberBase propertyName '?'? typeAnnotation? initializer? SemiColon
	visitPropertyDeclarationExpression(ctx) {
		const name = ctx.propertyName?.()?.getText();
		if (!name) return null;
		if (
			name === "async" ||
			name === "static" ||
			name === "get" ||
			name === "set"
		)
			return null;
		this.#add("field", name, ctx);
		return null;
	}

	visitImportStatement() {
		return null;
	}

	// TS has two export paths:
	// 1. exportStatement → ExportDeclaration (export { x } / export declaration)
	// 2. sourceElement → Export? statement (export const x = ...)
	// Handle both.
	visitSourceElement(ctx) {
		if (ctx.Export?.()) {
			this.#inExport = true;
			this.visitChildren(ctx);
			this.#inExport = false;
			return null;
		}
		return this.visitChildren(ctx);
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

	// Class expressions: const Foo = class { ... }
	visitClassExpression(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.();
		if (id) this.#add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitVariableStatement(ctx) {
		if (this.#inBody) return null;
		if (!this.#inExport) return null;
		const declList = ctx.variableDeclarationList?.();
		if (!declList) return null;
		const decls = declList.variableDeclaration?.() ?? [];
		for (const decl of decls) {
			const id = decl.identifierOrKeyWord?.();
			if (id) this.#add("variable", id.getText(), decl);
		}
		// Descend into initializers for class/function expressions
		return this.visitChildren(ctx);
	}
}

export default class TypeScriptMap {
	static status = "done";

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
