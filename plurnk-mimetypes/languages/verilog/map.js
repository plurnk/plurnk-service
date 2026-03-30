import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import VerilogParserVisitor from "./generated/VerilogParserVisitor.js";

class Extractor extends withExtractor(VerilogParserVisitor) {
	visitModule_declaration(ctx) {
		const id = ctx.module_identifier?.();
		if (id) this._add("module", id.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitTask_declaration(ctx) {
		const id = ctx.task_identifier?.();
		if (id) this._add("function", id.getText(), ctx);
		return null;
	}

	visitFunction_declaration(ctx) {
		const id = ctx.function_identifier?.();
		if (id) this._add("function", id.getText(), ctx);
		return null;
	}

	visitInput_declaration(ctx) {
		const ids = ctx.list_of_port_identifiers?.();
		if (ids) {
			for (const pid of ids.port_identifier?.() ?? []) {
				this._add("field", pid.getText(), ctx);
			}
		}
		return null;
	}

	visitOutput_declaration(ctx) {
		const ids = ctx.list_of_port_identifiers?.();
		if (ids) {
			for (const pid of ids.port_identifier?.() ?? []) {
				this._add("field", pid.getText(), ctx);
			}
		}
		const varIds = ctx.list_of_variable_port_identifiers?.();
		if (varIds) {
			for (const vt of varIds.variable_type?.() ?? []) {
				const id = vt.variable_identifier?.();
				if (id) this._add("field", id.getText(), ctx);
			}
		}
		return null;
	}

	visitNet_declaration(ctx) {
		const netIds = ctx.list_of_net_identifiers?.();
		if (netIds) {
			for (const nid of netIds.net_id?.() ?? []) {
				this._add("field", nid.getText(), ctx);
			}
		}
		const declAssigns = ctx.list_of_net_decl_assignments?.();
		if (declAssigns) {
			for (const nda of declAssigns.net_decl_assignment?.() ?? []) {
				const id = nda.net_identifier?.();
				if (id) this._add("field", id.getText(), ctx);
			}
		}
		return null;
	}

	visitReg_declaration(ctx) {
		const ids = ctx.list_of_variable_identifiers?.();
		if (ids) {
			for (const vt of ids.variable_type?.() ?? []) {
				const id = vt.variable_identifier?.();
				if (id) this._add("field", id.getText(), ctx);
			}
		}
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "source_text",
	extensions: [".v"],
});
