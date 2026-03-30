import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import SQLiteParserVisitor from "./generated/SQLiteParserVisitor.js";

class Extractor extends withExtractor(SQLiteParserVisitor) {
	#currentTable = null;

	visitCreate_table_stmt(ctx) {
		const name = ctx.table_name()?.getText();
		if (name) this._add("class", name, ctx);
		this.#currentTable = name;
		this.visitChildren(ctx);
		this.#currentTable = null;
		return null;
	}

	visitColumn_def(ctx) {
		if (!this.#currentTable) return null;
		const name = ctx.column_name()?.getText();
		if (name) this._add("field", name, ctx);
		return null;
	}

	visitCreate_view_stmt(ctx) {
		const name = ctx.view_name()?.getText();
		if (name) this._add("class", name, ctx);
		return null;
	}

	visitCreate_index_stmt(ctx) {
		const name = ctx.index_name()?.getText();
		if (name) this._add("variable", name, ctx);
		return null;
	}

	visitCreate_trigger_stmt(ctx) {
		const name = ctx.trigger_name()?.getText();
		if (name) this._add("function", name, ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "parse",
	extensions: [".sql", ".sqlite", ".sqlite3"],
});
