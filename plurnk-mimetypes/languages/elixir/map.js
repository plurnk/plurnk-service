import ElixirParserVisitor from "./generated/ElixirParserVisitor.js";

class SymbolExtractor extends ElixirParserVisitor {
	#symbols = [];
	#inBody = false;

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

	#extractParams(expressionsList) {
		if (!expressionsList) return [];
		const exprs = expressionsList.expression?.() ?? [];
		return exprs.map((e) => e.getText());
	}

	// Scope boundary: do_block inside function_def is the wall.
	visitDo_block(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitModule_def(ctx) {
		if (this.#inBody) return null;
		const alias = ctx.ALIAS?.();
		if (alias) this.#add("module", alias.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitFunction_def(ctx) {
		if (this.#inBody) return null;
		const variable = ctx.variable?.();
		if (variable) {
			const paramLists = ctx.expressions_?.() ?? [];
			const params =
				paramLists.length > 0 ? this.#extractParams(paramLists[0]) : [];
			this.#add("function", variable.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitMacro_def(ctx) {
		if (this.#inBody) return null;
		const variable = ctx.variable?.();
		if (variable) {
			const params = this.#extractParams(ctx.expressions_?.());
			this.#add("function", variable.getText(), ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitAnonymous_function() {
		return null;
	}
}

export default class ElixirMap {
	static status = "done";
	static entryRule = "parse";
	static extensions = [".ex", ".exs"];

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
