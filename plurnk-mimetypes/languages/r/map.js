import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import RVisitor from "./generated/RVisitor.js";

class Extractor extends withExtractor(RVisitor) {
	visitCompoundStatement(ctx) {
		return this._gateBody(ctx);
	}

	visitAssignment(ctx) {
		if (this._inBody) return null;
		const exprs = ctx.expr?.() ?? [];
		const lhs = exprs[0];
		const rhs = exprs[1];
		if (!lhs || !rhs) return this.visitChildren(ctx);
		const name = lhs.getText();
		const rhsText = rhs.constructor.name;
		if (rhsText === "FunctionDefinitionContext") {
			const formlist = rhs.formlist?.();
			const params = this.#extractParams(formlist);
			this._add("function", name, ctx, params);
		}
		return this.visitChildren(ctx);
	}

	visitFunctionDefinition(ctx) {
		if (this._inBody) return null;
		return this.visitChildren(ctx);
	}

	#extractParams(formlist) {
		if (!formlist) return [];
		const forms = formlist.form?.() ?? [];
		const params = [];
		for (const f of forms) {
			const id = f.ID?.();
			if (id) params.push(id.getText());
			const text = f.getText();
			if (text === "..." || text === ".") params.push(text);
		}
		return params;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "prog",
	extensions: [".r", ".R"],
});
