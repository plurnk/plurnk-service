import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import KotlinParserVisitor from "./generated/KotlinParserVisitor.js";

class Extractor extends withExtractor(KotlinParserVisitor) {
	#inClassBody = false;

	#extractParams(ctx) {
		const fvp = ctx.functionValueParameters?.();
		if (!fvp) return [];
		const params = [];
		const fvps = fvp.functionValueParameter?.() ?? [];
		for (const p of fvps) {
			const param = p.parameter?.();
			if (param) {
				const id = param.simpleIdentifier?.();
				if (id) params.push(id.getText());
			}
		}
		return params;
	}

	visitFunctionBody(ctx) {
		return this._gateBody(ctx);
	}

	visitClassBody(ctx) {
		const wasInClassBody = this.#inClassBody;
		this.#inClassBody = true;
		this.visitChildren(ctx);
		this.#inClassBody = wasInClassBody;
		return null;
	}

	visitClassDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.simpleIdentifier?.();
		if (id) {
			const modifiers = ctx.modifierList?.()?.getText() ?? "";
			const kind =
				modifiers.includes("interface") || ctx.INTERFACE?.()
					? "interface"
					: "class";
			this._add(kind, id.getText(), ctx);
		}
		return this.visitChildren(ctx);
	}

	visitObjectDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.simpleIdentifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitCompanionObject(ctx) {
		const id = ctx.simpleIdentifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitFunctionDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx);
			const kind = this.#inClassBody ? "method" : "function";
			this._add(kind, id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitPropertyDeclaration(ctx) {
		if (this._inBody) return null;
		const varDecl = ctx.variableDeclaration?.();
		if (varDecl) {
			const id = varDecl.simpleIdentifier?.();
			if (id) {
				const kind = this.#inClassBody ? "field" : "variable";
				this._add(kind, id.getText(), ctx);
			}
		}
		const multiVar = ctx.multiVariableDeclaration?.();
		if (multiVar) {
			const decls = multiVar.variableDeclaration?.() ?? [];
			for (const decl of decls) {
				const id = decl.simpleIdentifier?.();
				if (id) {
					const kind = this.#inClassBody ? "field" : "variable";
					this._add(kind, id.getText(), ctx);
				}
			}
		}
		return null;
	}

	visitTypeAlias(ctx) {
		if (this._inBody) return null;
		const id = ctx.simpleIdentifier?.();
		if (id) this._add("type", id.getText(), ctx);
		return null;
	}

	visitSecondaryConstructor(ctx) {
		const params = [];
		const fvp = ctx.functionValueParameters?.();
		if (fvp) {
			const fvps = fvp.functionValueParameter?.() ?? [];
			for (const p of fvps) {
				const param = p.parameter?.();
				if (param) {
					const id = param.simpleIdentifier?.();
					if (id) params.push(id.getText());
				}
			}
		}
		this._add("method", "constructor", ctx, params);
		return null;
	}

	visitImportHeader() {
		return null;
	}

	visitPackageHeader() {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "kotlinFile",
	extensions: [".kt", ".kts"],
});
