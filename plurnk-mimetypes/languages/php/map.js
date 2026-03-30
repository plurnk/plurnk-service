import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import PhpParserVisitor from "./generated/PhpParserVisitor.js";

class Extractor extends withExtractor(PhpParserVisitor) {
	#inClass = false;

	#extractParams(formalParameterList) {
		if (!formalParameterList) return [];
		const params = [];
		const fps = formalParameterList.formalParameter?.() ?? [];
		for (const fp of fps) {
			const varInit = fp.variableInitializer?.();
			if (varInit) {
				const varName = varInit.VarName?.();
				if (varName) params.push(varName.getText());
			}
		}
		return params;
	}

	visitBlockStatement(ctx) {
		if (this._inBody) return this.visitChildren(ctx);
		return this._gateBody(ctx);
	}

	visitFunctionDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameterList?.());
			this._add("function", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitClassDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) {
			const isInterface = ctx.Interface?.();
			this._add(isInterface ? "interface" : "class", id.getText(), ctx);
		}
		const wasInClass = this.#inClass;
		const wasInBody = this._inBody;
		this.#inClass = true;
		this._inBody = false;
		this.visitChildren(ctx);
		this.#inClass = wasInClass;
		this._inBody = wasInBody;
		return null;
	}

	visitEnumDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("enum", id.getText(), ctx);
		const wasInClass = this.#inClass;
		const wasInBody = this._inBody;
		this.#inClass = true;
		this._inBody = false;
		this.visitChildren(ctx);
		this.#inClass = wasInClass;
		this._inBody = wasInBody;
		return null;
	}

	visitNamespaceDeclaration(ctx) {
		if (this._inBody) return null;
		const nameList = ctx.namespaceNameList?.();
		if (nameList) this._add("module", nameList.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitClassStatement(ctx) {
		const fnToken = ctx.Function_?.();
		if (fnToken) {
			const id = ctx.identifier?.();
			if (id) {
				const params = this.#extractParams(ctx.formalParameterList?.());
				this._add("method", id.getText(), ctx, params);
			}
			return null;
		}
		const propMods = ctx.propertyModifiers?.();
		if (propMods) {
			const varInits = ctx.variableInitializer?.() ?? [];
			for (const vi of varInits) {
				const varName = vi.VarName?.();
				if (varName) this._add("field", varName.getText(), ctx);
			}
			return null;
		}
		return this.visitChildren(ctx);
	}

	visitGlobalConstantDeclaration(ctx) {
		if (this._inBody) return null;
		const inits = ctx.identifierInitializer?.() ?? [];
		for (const init of inits) {
			const id = init.identifier?.();
			if (id) this._add("constant", id.getText(), ctx);
		}
		return null;
	}

	visitImportStatement() {
		return null;
	}

	visitUseDeclaration() {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "htmlDocument",
	extensions: [".php"],
});
