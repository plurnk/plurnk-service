import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import GoParserVisitor from "./generated/GoParserVisitor.js";

class Extractor extends withExtractor(GoParserVisitor) {
	#extractParams(signature) {
		if (!signature) return [];
		const parameters = signature.parameters?.();
		if (!parameters) return [];
		const decls = parameters.parameterDecl?.() ?? [];
		const params = [];
		for (const decl of decls) {
			const idList = decl.identifierList?.();
			const isVariadic = !!decl.ELLIPSIS?.();
			if (idList) {
				const ids = idList.IDENTIFIER?.() ?? [];
				for (let i = 0; i < ids.length; i++) {
					const name = ids[i].getText();
					if (isVariadic && i === ids.length - 1) {
						params.push(`...${name}`);
					} else {
						params.push(name);
					}
				}
			}
		}
		return params;
	}

	#resolveTypeDefKind(ctx) {
		const typeCtx = ctx.type_?.();
		const typeLit = typeCtx?.typeLit?.();
		if (typeLit?.structType?.()) return "class";
		if (typeLit?.interfaceType?.()) return "interface";
		return "type";
	}

	visitBlock(ctx) {
		return this._gateBody(ctx);
	}

	visitPackageClause(ctx) {
		const name = ctx.packageName?.()?.identifier?.()?.getText();
		if (name) this._add("module", name, ctx);
		return null;
	}

	visitImportDecl() {
		return null;
	}

	visitFunctionDecl(ctx) {
		if (this._inBody) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) {
			const params = this.#extractParams(ctx.signature?.());
			this._add("function", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitMethodDecl(ctx) {
		if (this._inBody) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) {
			const params = this.#extractParams(ctx.signature?.());
			this._add("method", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitTypeDef(ctx) {
		if (this._inBody) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) {
			const kind = this.#resolveTypeDefKind(ctx);
			this._add(kind, name, ctx);
		}
		return null;
	}

	visitAliasDecl(ctx) {
		if (this._inBody) return null;
		const name = ctx.IDENTIFIER?.()?.getText();
		if (name) this._add("type", name, ctx);
		return null;
	}

	visitConstSpec(ctx) {
		if (this._inBody) return null;
		const idList = ctx.identifierList?.();
		if (!idList) return null;
		const ids = idList.IDENTIFIER?.() ?? [];
		for (const id of ids) {
			this._add("constant", id.getText(), ctx);
		}
		return null;
	}

	visitVarSpec(ctx) {
		if (this._inBody) return null;
		const idList = ctx.identifierList?.();
		if (!idList) return null;
		const ids = idList.IDENTIFIER?.() ?? [];
		for (const id of ids) {
			this._add("variable", id.getText(), ctx);
		}
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "sourceFile",
	extensions: [".go"],
});
