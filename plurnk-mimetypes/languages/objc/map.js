import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import ObjectiveCParserVisitor from "./generated/ObjectiveCParserVisitor.js";

class Extractor extends withExtractor(ObjectiveCParserVisitor) {
	visitCompoundStatement(ctx) {
		return this._gateBody(ctx);
	}

	visitClassInterface(ctx) {
		const name = ctx.className?.identifier?.()?.getText();
		if (name) this._add("class", name, ctx);
		return this.visitChildren(ctx);
	}

	visitClassImplementation(ctx) {
		const name = ctx.className?.identifier?.()?.getText();
		if (name) this._add("class", name, ctx);
		return this.visitChildren(ctx);
	}

	visitProtocolDeclaration(ctx) {
		const name = ctx.protocolName?.()?.identifier?.()?.getText();
		if (name) this._add("interface", name, ctx);
		return this.visitChildren(ctx);
	}

	visitClassMethodDeclaration(ctx) {
		if (this._inBody) return null;
		const sel = this.#selectorName(
			ctx.methodDeclaration?.()?.methodSelector?.(),
		);
		if (sel) this._add("method", `+${sel}`, ctx);
		return null;
	}

	visitInstanceMethodDeclaration(ctx) {
		if (this._inBody) return null;
		const sel = this.#selectorName(
			ctx.methodDeclaration?.()?.methodSelector?.(),
		);
		if (sel) this._add("method", `-${sel}`, ctx);
		return null;
	}

	visitClassMethodDefinition(ctx) {
		if (this._inBody) return null;
		const sel = this.#selectorName(
			ctx.methodDefinition?.()?.methodSelector?.(),
		);
		if (sel) this._add("method", `+${sel}`, ctx);
		return this.visitChildren(ctx);
	}

	visitInstanceMethodDefinition(ctx) {
		if (this._inBody) return null;
		const sel = this.#selectorName(
			ctx.methodDefinition?.()?.methodSelector?.(),
		);
		if (sel) this._add("method", `-${sel}`, ctx);
		return this.visitChildren(ctx);
	}

	visitPropertyDeclaration(ctx) {
		if (this._inBody) return null;
		const fieldDecl = ctx.fieldDeclaration?.();
		const declarators =
			fieldDecl?.fieldDeclaratorList?.()?.fieldDeclarator?.() ?? [];
		for (const decl of declarators) {
			const id = decl.declarator?.()?.identifier?.();
			if (id) this._add("field", id.getText(), ctx);
		}
		return null;
	}

	visitFunctionDefinition(ctx) {
		if (this._inBody) return null;
		const sig = ctx.functionSignature?.();
		const id = sig?.identifier?.();
		if (id) this._add("function", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	#selectorName(methodSelector) {
		if (!methodSelector) return null;
		const sel = methodSelector.selector?.();
		if (sel) return sel.getText();
		const keywords = methodSelector.keywordDeclarator?.() ?? [];
		return keywords
			.map((kw) => `${kw.selector?.()?.getText() ?? ""}:`)
			.join("");
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "translationUnit",
	extensions: [".m", ".h"],
});
