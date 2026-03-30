import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import JavaParserVisitor from "./generated/JavaParserVisitor.js";

class Extractor extends withExtractor(JavaParserVisitor) {
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

	visitMethodBody(ctx) {
		return this._gateBody(ctx);
	}

	visitConstructorDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameters?.());
			this._add("method", id.getText(), ctx, params);
		}
		const was = this._inBody;
		this._inBody = true;
		const body = ctx.block?.();
		if (body) this.visit(body);
		this._inBody = was;
		return null;
	}

	visitCompactConstructorDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) this._add("method", id.getText(), ctx);
		const was = this._inBody;
		this._inBody = true;
		const body = ctx.block?.();
		if (body) this.visit(body);
		this._inBody = was;
		return null;
	}

	visitPackageDeclaration(ctx) {
		const name = ctx.qualifiedName?.()?.getText();
		if (name) this._add("module", name, ctx);
		return null;
	}

	visitImportDeclaration() {
		return null;
	}

	visitClassDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitInterfaceDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("interface", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitEnumDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("enum", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitRecordDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("class", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitAnnotationTypeDeclaration(ctx) {
		if (this._inBody) return null;
		const id = ctx.identifier?.();
		if (id) this._add("interface", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitMethodDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameters?.());
			this._add("method", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitInterfaceCommonBodyDeclaration(ctx) {
		const id = ctx.identifier?.();
		if (id) {
			const params = this.#extractParams(ctx.formalParameters?.());
			this._add("method", id.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitFieldDeclaration(ctx) {
		const declarators =
			ctx.variableDeclarators?.()?.variableDeclarator?.() ?? [];
		for (const decl of declarators) {
			const id = decl.variableDeclaratorId?.()?.identifier?.();
			if (id) this._add("field", id.getText(), ctx);
		}
		return null;
	}

	visitConstDeclaration(ctx) {
		const declarators = ctx.constantDeclarator?.() ?? [];
		for (const decl of declarators) {
			const id = decl.identifier?.();
			if (id) this._add("field", id.getText(), ctx);
		}
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "compilationUnit",
	extensions: [".java"],
});
