import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import JavaScriptParserVisitor from "./generated/JavaScriptParserVisitor.js";

class Extractor extends withExtractor(JavaScriptParserVisitor) {
	#inExport = false;

	visitFunctionBody(ctx) {
		return this._gateBody(ctx);
	}

	visitFunctionDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id)
			this._add(
				"function",
				id.getText(),
				ctx,
				this.#extractParams(ctx.formalParameterList?.()),
			);
		return this.visitChildren(ctx);
	}

	visitClassDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitClassExpression(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitMethodDefinition(ctx) {
		const name = ctx.classElementName?.();
		const getter = ctx.getter?.();
		const setter = ctx.setter?.();
		const label =
			name?.getText() ??
			getter?.classElementName?.()?.getText() ??
			setter?.classElementName?.()?.getText();
		if (label)
			this._add(
				"method",
				label,
				ctx,
				this.#extractParams(ctx.formalParameterList?.()),
			);
		return this.visitChildren(ctx);
	}

	visitFieldDefinition(ctx) {
		const name = ctx.classElementName?.();
		if (!name) return null;
		const text = name.getText();
		if (
			text === "async" ||
			text === "static" ||
			text === "get" ||
			text === "set"
		)
			return null;
		this._add("field", text, ctx);
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

	visitVariableDeclaration(ctx) {
		if (this._inBody) return null;
		if (!this.#inExport) return null;
		const assignable = ctx.assignable?.();
		const id = assignable?.identifier?.();
		if (id) this._add("variable", id.getText(), ctx);
		return this.visitChildren(ctx);
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
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "program",
	extensions: [".js", ".mjs"],
});
