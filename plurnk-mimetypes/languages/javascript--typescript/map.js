import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import TypeScriptParserVisitor from "./generated/TypeScriptParserVisitor.js";

class Extractor extends withExtractor(TypeScriptParserVisitor) {
	#inExport = false;

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

	visitFunctionBody(ctx) {
		return this._gateBody(ctx);
	}

	visitFunctionDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) {
			const params = this.#extractCallSignatureParams(ctx.callSignature?.());
			this._add("function", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitGeneratorFunctionDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) {
			const params = this.#extractFormalParams(ctx.formalParameterList?.());
			this._add("function", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitClassDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInterfaceDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("interface", id.getText(), ctx);
		return null;
	}

	visitTypeAliasDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("type", id.getText(), ctx);
		return null;
	}

	visitEnumDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("enum", id.getText(), ctx);
		return null;
	}

	visitNamespaceDeclaration(ctx) {
		if (this._inBody) return null;
		const name = ctx.namespaceName();
		if (name) this._add("module", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitConstructorDeclaration(ctx) {
		const params = this.#extractFormalParams(ctx.formalParameterList?.());
		this._add("method", "constructor", ctx, params);
		return this.visitChildren(ctx);
	}

	visitMethodDeclarationExpression(ctx) {
		const name = ctx.propertyName?.()?.getText();
		if (name) {
			const params = this.#extractCallSignatureParams(ctx.callSignature?.());
			this._add("method", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitGetterSetterDeclarationExpression(ctx) {
		const getter = ctx.getAccessor?.();
		const setter = ctx.setAccessor?.();
		const name =
			getter?.getter?.()?.classElementName?.()?.getText() ??
			setter?.setter?.()?.classElementName?.()?.getText();
		if (name) {
			const params = setter
				? this.#extractFormalParams(setter.formalParameterList?.())
				: [];
			this._add("method", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

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
		this._add("field", name, ctx);
		return null;
	}

	visitImportStatement() {
		return null;
	}

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

	visitClassExpression(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitVariableStatement(ctx) {
		if (this._inBody) return null;
		if (!this.#inExport) return null;
		const declList = ctx.variableDeclarationList?.();
		if (!declList) return null;
		const decls = declList.variableDeclaration?.() ?? [];
		for (const decl of decls) {
			const id = decl.identifierOrKeyWord?.();
			if (id) this._add("variable", id.getText(), decl);
		}
		return this.visitChildren(ctx);
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "program",
	extensions: [".ts", ".tsx"],
});
