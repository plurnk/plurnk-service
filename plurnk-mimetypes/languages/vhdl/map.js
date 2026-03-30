import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import vhdlVisitor from "./generated/vhdlVisitor.js";

class Extractor extends withExtractor(vhdlVisitor) {
	visitEntity_declaration(ctx) {
		const id = ctx.identifier?.()?.[0];
		if (id) this._add("module", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitArchitecture_body(ctx) {
		const ids = ctx.identifier?.() ?? [];
		const name = ids[0];
		if (name) this._add("class", name.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitProcess_statement(ctx) {
		const label = ctx.label_colon?.();
		const name = label?.identifier?.()?.getText() ?? "<anonymous>";
		this._add("function", name, ctx);
		return null;
	}

	visitSignal_declaration(ctx) {
		const idList = ctx.identifier_list?.();
		if (idList) {
			for (const id of idList.identifier?.() ?? []) {
				this._add("field", id.getText(), ctx);
			}
		}
		return null;
	}

	visitInterface_port_declaration(ctx) {
		const idList = ctx.identifier_list?.();
		if (idList) {
			for (const id of idList.identifier?.() ?? []) {
				this._add("field", id.getText(), ctx);
			}
		}
		return null;
	}

	visitSubprogram_body(ctx) {
		const spec = ctx.subprogram_specification?.();
		if (!spec) return null;
		const procSpec = spec.procedure_specification?.();
		const funcSpec = spec.function_specification?.();
		const designator = procSpec?.designator?.() ?? funcSpec?.designator?.();
		const name = designator?.identifier?.()?.getText() ?? designator?.getText();
		if (name) this._add("function", name, ctx);
		return null;
	}

	visitSubprogram_declaration(ctx) {
		const spec = ctx.subprogram_specification?.();
		if (!spec) return null;
		const procSpec = spec.procedure_specification?.();
		const funcSpec = spec.function_specification?.();
		const designator = procSpec?.designator?.() ?? funcSpec?.designator?.();
		const name = designator?.identifier?.()?.getText() ?? designator?.getText();
		if (name) this._add("function", name, ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "design_file",
	extensions: [".vhd", ".vhdl"],
});
