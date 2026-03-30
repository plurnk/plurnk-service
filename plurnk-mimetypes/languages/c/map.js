import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import CParserVisitor from "./generated/CParserVisitor.js";

class Extractor extends withExtractor(CParserVisitor) {
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

	visitFunctionBody(ctx) {
		return this._gateBody(ctx);
	}

	visitFunctionDefinition(ctx) {
		if (this._inBody) return null;
		const declarator = ctx.declarator?.();
		const name = this.#extractDeclaratorName(declarator);
		if (name) {
			const params = this.#extractParams(declarator);
			this._add("function", name, ctx, params);
		}
		// Don't descend — params are already extracted, and the body
		// would only contain local declarations we want to exclude.
		// Descending would also misparse struct types in params as definitions.
		return null;
	}

	visitStructOrUnionSpecifier(ctx) {
		if (this._inBody) return null;
		const id = ctx.Identifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitEnumSpecifier(ctx) {
		if (this._inBody) return null;
		const id = ctx.Identifier?.();
		if (id) this._add("enum", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitDeclaration(ctx) {
		if (this._inBody) return null;
		return this.visitChildren(ctx);
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "compilationUnit",
	extensions: [".c", ".h"],
});
