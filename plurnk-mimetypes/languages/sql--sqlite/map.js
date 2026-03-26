import SQLiteParserVisitor from "./generated/SQLiteParserVisitor.js";

class SymbolExtractor extends SQLiteParserVisitor {
	#symbols = [];
	#currentTable = null;

	get symbols() {
		return this.#symbols;
	}

	#add(kind, name, ctx) {
		this.#symbols.push({
			name,
			kind,
			line: ctx.start.line,
			endLine: ctx.stop?.line ?? ctx.start.line,
		});
	}

	visitCreate_table_stmt(ctx) {
		const name = ctx.table_name()?.getText();
		if (name) this.#add("class", name, ctx);
		this.#currentTable = name;
		this.visitChildren(ctx);
		this.#currentTable = null;
		return null;
	}

	visitColumn_def(ctx) {
		if (!this.#currentTable) return null;
		const name = ctx.column_name()?.getText();
		if (name) this.#add("field", name, ctx);
		return null;
	}

	visitCreate_view_stmt(ctx) {
		const name = ctx.view_name()?.getText();
		if (name) this.#add("class", name, ctx);
		return null;
	}

	visitCreate_index_stmt(ctx) {
		const name = ctx.index_name()?.getText();
		if (name) this.#add("variable", name, ctx);
		return null;
	}

	visitCreate_trigger_stmt(ctx) {
		const name = ctx.trigger_name()?.getText();
		if (name) this.#add("function", name, ctx);
		return null;
	}
}

export default class SQLiteMap {
	static status = "done";
	static entryRule = "parse";
	static extensions = [".sql", ".sqlite", ".sqlite3"];

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
