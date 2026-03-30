import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import Python3ParserVisitor from "./generated/Python3ParserVisitor.js";

class Extractor extends withExtractor(Python3ParserVisitor) {
	#inClassBody = false;

	_endLine(ctx) {
		const stop = ctx.stop;
		if (!stop) return ctx.start.line;
		if (stop.type === 2 && stop.line > ctx.start.line) return stop.line - 1;
		return stop.line;
	}

	#extractParams(parameters) {
		if (!parameters) return [];
		const typedargslist = parameters.typedargslist?.();
		if (!typedargslist) return [];
		const params = [];
		const tfpdefs = typedargslist.tfpdef?.() ?? [];
		const children = typedargslist.children ?? [];
		for (const tfp of tfpdefs) {
			const paramName = tfp.name?.()?.getText();
			if (!paramName) continue;
			const idx = children.indexOf(tfp);
			let prefix = "";
			if (idx > 0) {
				const prev = children[idx - 1];
				const text = prev.getText?.();
				if (text === "**") prefix = "**";
				else if (text === "*") prefix = "*";
			}
			params.push(prefix + paramName);
		}
		return params;
	}

	visitBlock(ctx) {
		if (this.#inClassBody) return this.visitChildren(ctx);
		return this._gateBody(ctx);
	}

	visitFuncdef(ctx) {
		const nameNode = ctx.name?.();
		if (!nameNode) return this.visitChildren(ctx);
		const name = nameNode.getText();
		const params = this.#extractParams(ctx.parameters?.());
		const kind = this.#inClassBody ? "method" : "function";
		if (this._inBody && !this.#inClassBody) return null;
		this._add(kind, name, ctx, params);
		const wasInClassBody = this.#inClassBody;
		this.#inClassBody = false;
		this.visitChildren(ctx);
		this.#inClassBody = wasInClassBody;
		return null;
	}

	visitAsync_funcdef(ctx) {
		return this.visitChildren(ctx);
	}

	visitClassdef(ctx) {
		if (this._inBody && !this.#inClassBody) return null;
		const nameNode = ctx.name?.();
		if (nameNode) this._add("class", nameNode.getText(), ctx);
		const wasInClassBody = this.#inClassBody;
		const wasInBody = this._inBody;
		this.#inClassBody = true;
		this._inBody = false;
		this.visitChildren(ctx);
		this.#inClassBody = wasInClassBody;
		this._inBody = wasInBody;
		return null;
	}

	visitDecorated(ctx) {
		return this.visitChildren(ctx);
	}

	visitExpr_stmt(ctx) {
		if (!this.#inClassBody || this._inBody) return null;
		const hasAssign = ctx.ASSIGN?.(0) || ctx.annassign?.();
		if (!hasAssign) return null;
		const target = ctx.testlist_star_expr?.(0);
		if (!target) return null;
		const text = target.getText();
		if (/^[a-zA-Z_]\w*$/.test(text)) {
			this._add("field", text, ctx);
		}
		return null;
	}

	visitImport_stmt() {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "file_input",
	extensions: [".py"],
});
