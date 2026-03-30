import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import ScalaVisitor from "./generated/ScalaVisitor.js";

class Extractor extends withExtractor(ScalaVisitor) {
	#inTemplate = false;

	#extractParams(paramClauses) {
		if (!paramClauses) return [];
		const params = [];
		const clauses = paramClauses.paramClause?.() ?? [];
		for (const clause of clauses) {
			const paramsNode = clause.params?.();
			if (!paramsNode) continue;
			const paramNodes = paramsNode.param?.() ?? [];
			for (const p of paramNodes) {
				const id = p.Id?.()?.getText();
				if (id) params.push(id);
			}
		}
		const implicitParams = paramClauses.params?.();
		if (implicitParams) {
			const paramNodes = implicitParams.param?.() ?? [];
			for (const p of paramNodes) {
				const id = p.Id?.()?.getText();
				if (id) params.push(id);
			}
		}
		return params;
	}

	visitBlock(ctx) {
		return this._gateBody(ctx);
	}

	visitTemplateBody(ctx) {
		const wasInTemplate = this.#inTemplate;
		this.#inTemplate = true;
		this.visitChildren(ctx);
		this.#inTemplate = wasInTemplate;
		return null;
	}

	visitTmplDef(ctx) {
		if (this._inBody) return null;
		const classDef = ctx.classDef?.();
		if (classDef) {
			const id = classDef.Id?.()?.getText();
			if (id) this._add("class", id, ctx);
			return this.visitChildren(ctx);
		}
		const objectDef = ctx.objectDef?.();
		if (objectDef) {
			const id = objectDef.Id?.()?.getText();
			if (id) this._add("module", id, ctx);
			return this.visitChildren(ctx);
		}
		const traitDef = ctx.traitDef?.();
		if (traitDef) {
			const id = traitDef.Id?.()?.getText();
			if (id) this._add("interface", id, ctx);
			return this.visitChildren(ctx);
		}
		return this.visitChildren(ctx);
	}

	visitDef_(ctx) {
		if (this._inBody) return null;
		const funDef = ctx.funDef?.();
		if (funDef) {
			const funSig = funDef.funSig?.();
			const id = funSig?.Id?.()?.getText();
			if (id) {
				const params = this.#extractParams(funSig.paramClauses?.());
				const kind = this.#inTemplate ? "method" : "function";
				this._add(kind, id, ctx, params);
			}
			return this.visitChildren(ctx);
		}
		const typeDef = ctx.typeDef?.();
		if (typeDef) {
			const id = typeDef.Id?.()?.getText();
			if (id) this._add("type", id, ctx);
			return null;
		}
		const patVarDef = ctx.patVarDef?.();
		if (patVarDef) {
			this.#visitPatVarDef(patVarDef, ctx);
			return null;
		}
		return this.visitChildren(ctx);
	}

	visitDcl(ctx) {
		if (this._inBody) return null;
		const funDcl = ctx.funDcl?.();
		if (funDcl) {
			const funSig = funDcl.funSig?.();
			const id = funSig?.Id?.()?.getText();
			if (id) {
				const params = this.#extractParams(funSig.paramClauses?.());
				const kind = this.#inTemplate ? "method" : "function";
				this._add(kind, id, ctx, params);
			}
			return null;
		}
		const valDcl = ctx.valDcl?.();
		if (valDcl) {
			const ids = valDcl.ids?.();
			if (ids) {
				const kind = this.#inTemplate ? "field" : "variable";
				const idNodes = ids.Id?.() ?? [];
				for (const id of idNodes) {
					this._add(kind, id.getText(), ctx);
				}
			}
			return null;
		}
		const varDcl = ctx.varDcl?.();
		if (varDcl) {
			const ids = varDcl.ids?.();
			if (ids) {
				const kind = this.#inTemplate ? "field" : "variable";
				const idNodes = ids.Id?.() ?? [];
				for (const id of idNodes) {
					this._add(kind, id.getText(), ctx);
				}
			}
			return null;
		}
		const typeDcl = ctx.typeDcl?.();
		if (typeDcl) {
			const id = typeDcl.Id?.()?.getText();
			if (id) this._add("type", id, ctx);
		}
		return null;
	}

	#visitPatVarDef(patVarDef, outerCtx) {
		const kind = this.#inTemplate ? "field" : "variable";
		const patDef = patVarDef.patDef?.();
		if (patDef) {
			const patterns = patDef.pattern2?.() ?? [];
			for (const pat of patterns) {
				const name = pat.getText();
				if (name && /^[A-Za-z_]/.test(name)) {
					this._add(kind, name, outerCtx);
				}
			}
			return;
		}
		const varDef = patVarDef.varDef?.();
		if (varDef) {
			const varPatDef = varDef.patDef?.();
			if (varPatDef) {
				const patterns = varPatDef.pattern2?.() ?? [];
				for (const pat of patterns) {
					const name = pat.getText();
					if (name && /^[A-Za-z_]/.test(name)) {
						this._add(kind, name, outerCtx);
					}
				}
				return;
			}
			const ids = varDef.ids?.();
			if (ids) {
				const idNodes = ids.Id?.() ?? [];
				for (const id of idNodes) {
					this._add(kind, id.getText(), outerCtx);
				}
			}
		}
	}

	visitImport_(_ctx) {
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "compilationUnit",
	extensions: [".scala", ".sc"],
});
