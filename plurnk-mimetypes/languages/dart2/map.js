import Dart2ParserVisitor from "./generated/Dart2ParserVisitor.js";

class SymbolExtractor extends Dart2ParserVisitor {
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

	#extractParams(formalParameterList) {
		if (!formalParameterList) return [];
		const params = [];
		const normals = formalParameterList.normalFormalParameters?.();
		if (normals) {
			const paramNodes = normals.normalFormalParameter?.() ?? [];
			for (const p of paramNodes) {
				const noMeta = p.normalFormalParameterNoMetadata?.();
				if (!noMeta) continue;
				const simple = noMeta.simpleFormalParameter?.();
				const funcParam = noMeta.functionFormalParameter?.();
				const fieldParam = noMeta.fieldFormalParameter?.();
				if (simple) {
					const decl = simple.declaredIdentifier?.();
					const id =
						decl?.identifier?.()?.getText() ?? simple.identifier?.()?.getText();
					if (id) params.push(id);
				} else if (funcParam) {
					const id = funcParam.identifier?.()?.getText();
					if (id) params.push(id);
				} else if (fieldParam) {
					const id = fieldParam.identifier?.()?.getText();
					if (id) params.push(`this.${id}`);
				}
			}
		}
		const optional = formalParameterList.optionalOrNamedFormalParameters?.();
		if (optional) {
			const optPositional = optional.optionalPositionalFormalParameters?.();
			const named = optional.namedFormalParameters?.();
			const defaults =
				optPositional?.defaultFormalParameter?.() ??
				named?.defaultNamedParameter?.() ??
				[];
			for (const d of defaults) {
				const np =
					d.normalFormalParameter?.() ?? d.normalFormalParameterNoMetadata?.();
				if (!np) continue;
				const noMeta = np.normalFormalParameterNoMetadata?.() ?? np;
				const simple = noMeta.simpleFormalParameter?.();
				const funcParam = noMeta.functionFormalParameter?.();
				const fieldParam = noMeta.fieldFormalParameter?.();
				if (simple) {
					const decl = simple.declaredIdentifier?.();
					const id =
						decl?.identifier?.()?.getText() ?? simple.identifier?.()?.getText();
					if (id) params.push(id);
				} else if (funcParam) {
					const id = funcParam.identifier?.()?.getText();
					if (id) params.push(id);
				} else if (fieldParam) {
					const id = fieldParam.identifier?.()?.getText();
					if (id) params.push(`this.${id}`);
				}
			}
		}
		return params;
	}

	// Scope boundary: functionBody
	visitFunctionBody(ctx) {
		const wasInBody = this.#inBody;
		this.#inBody = true;
		this.visitChildren(ctx);
		this.#inBody = wasInBody;
		return null;
	}

	visitClassDeclaration(ctx) {
		if (this.#inBody) return null;
		const id =
			ctx.typeIdentifier?.()?.getText() ??
			ctx.mixinApplicationClass?.()?.typeIdentifier?.()?.getText();
		if (id) this.#add("class", id, ctx);
		return this.visitChildren(ctx);
	}

	visitMixinDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.typeIdentifier?.()?.getText();
		if (id) this.#add("class", id, ctx);
		return this.visitChildren(ctx);
	}

	visitExtensionDeclaration(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.()?.getText();
		if (id) this.#add("class", id, ctx);
		return this.visitChildren(ctx);
	}

	visitEnumType(ctx) {
		if (this.#inBody) return null;
		const id = ctx.identifier?.()?.getText();
		if (id) this.#add("enum", id, ctx);
		return null;
	}

	visitTypeAlias(ctx) {
		if (this.#inBody) return null;
		const id =
			ctx.typeIdentifier?.()?.getText() ??
			ctx.functionTypeAlias?.()?.functionPrefix?.()?.identifier?.()?.getText();
		if (id) this.#add("type", id, ctx);
		return null;
	}

	// Top-level function: functionSignature functionBody
	visitTopLevelDeclaration(ctx) {
		if (this.#inBody) return null;
		const funcSig = ctx.functionSignature?.();
		if (funcSig) {
			const id = funcSig.identifier?.()?.getText();
			if (id) {
				const params = this.#extractParams(
					funcSig.formalParameterPart?.()?.formalParameterList?.(),
				);
				this.#add("function", id, ctx, params);
			}
		}
		const getSig = ctx.getterSignature?.();
		if (getSig && !funcSig) {
			const id = getSig.identifier?.()?.getText();
			if (id) this.#add("function", id, ctx);
		}
		const setSig = ctx.setterSignature?.();
		if (setSig && !funcSig && !getSig) {
			const id = setSig.identifier?.()?.getText();
			if (id) {
				const params = this.#extractParams(setSig.formalParameterList?.());
				this.#add("function", id, ctx, params);
			}
		}
		return this.visitChildren(ctx);
	}

	// Class members: methodSignature functionBody | declaration SC
	visitClassMemberDeclaration(ctx) {
		const methodSig = ctx.methodSignature?.();
		if (methodSig) {
			this.#visitMethodSignature(methodSig, ctx);
			return this.visitChildren(ctx);
		}
		const decl = ctx.declaration?.();
		if (decl) {
			this.#visitDeclarationAsField(decl, ctx);
		}
		return this.visitChildren(ctx);
	}

	#visitMethodSignature(methodSig, outerCtx) {
		const funcSig = methodSig.functionSignature?.();
		if (funcSig) {
			const id = funcSig.identifier?.()?.getText();
			if (id) {
				const params = this.#extractParams(
					funcSig.formalParameterPart?.()?.formalParameterList?.(),
				);
				this.#add("method", id, outerCtx, params);
			}
			return;
		}
		const getSig = methodSig.getterSignature?.();
		if (getSig) {
			const id = getSig.identifier?.()?.getText();
			if (id) this.#add("method", id, outerCtx);
			return;
		}
		const setSig = methodSig.setterSignature?.();
		if (setSig) {
			const id = setSig.identifier?.()?.getText();
			if (id) {
				const params = this.#extractParams(setSig.formalParameterList?.());
				this.#add("method", id, outerCtx, params);
			}
			return;
		}
		const ctorSig = methodSig.constructorSignature?.();
		if (ctorSig) {
			const name = ctorSig.constructorName?.()?.getText();
			if (name) {
				const params = this.#extractParams(ctorSig.formalParameterList?.());
				this.#add("method", name, outerCtx, params);
			}
			return;
		}
		const factorySig = methodSig.factoryConstructorSignature?.();
		if (factorySig) {
			const name = factorySig.constructorName?.()?.getText();
			if (name) {
				const params = this.#extractParams(factorySig.formalParameterList?.());
				this.#add("method", name, outerCtx, params);
			}
			return;
		}
		const opSig = methodSig.operatorSignature?.();
		if (opSig) {
			const op = opSig.operator?.()?.getText();
			if (op) {
				const params = this.#extractParams(opSig.formalParameterList?.());
				this.#add("method", `operator ${op}`, outerCtx, params);
			}
		}
	}

	#visitDeclarationAsField(decl, outerCtx) {
		// Static const/final fields
		const staticFinals =
			decl.staticFinalDeclarationList?.()?.staticFinalDeclaration?.() ?? [];
		for (const sf of staticFinals) {
			const id = sf.identifier?.()?.getText();
			if (id) this.#add("field", id, outerCtx);
		}
		// Instance/static variable fields
		const initIds =
			decl.initializedIdentifierList?.()?.initializedIdentifier?.() ?? [];
		for (const ii of initIds) {
			const id = ii.identifier?.()?.getText();
			if (id) this.#add("field", id, outerCtx);
		}
		// Covariant identifierList (late final with no initializer)
		const idList = decl.identifierList?.()?.identifier?.() ?? [];
		for (const id of idList) {
			const name = id.getText();
			if (name) this.#add("field", name, outerCtx);
		}
		// Getter/setter/function declared without methodSignature path
		const funcSig = decl.functionSignature?.();
		if (funcSig) {
			const id = funcSig.identifier?.()?.getText();
			if (id) {
				const params = this.#extractParams(
					funcSig.formalParameterPart?.()?.formalParameterList?.(),
				);
				this.#add("method", id, outerCtx, params);
			}
		}
		const getSig = decl.getterSignature?.();
		if (getSig && !funcSig) {
			const id = getSig.identifier?.()?.getText();
			if (id) this.#add("method", id, outerCtx);
		}
		const setSig = decl.setterSignature?.();
		if (setSig && !funcSig && !getSig) {
			const id = setSig.identifier?.()?.getText();
			if (id) {
				const params = this.#extractParams(setSig.formalParameterList?.());
				this.#add("method", id, outerCtx, params);
			}
		}
		const ctorSig = decl.constructorSignature?.();
		if (ctorSig && !funcSig && !getSig && !setSig) {
			const name = ctorSig.constructorName?.()?.getText();
			if (name) {
				const params = this.#extractParams(ctorSig.formalParameterList?.());
				this.#add("method", name, outerCtx, params);
			}
		}
		const opSig = decl.operatorSignature?.();
		if (opSig) {
			const op = opSig.operator?.()?.getText();
			if (op) {
				const params = this.#extractParams(opSig.formalParameterList?.());
				this.#add("method", `operator ${op}`, outerCtx, params);
			}
		}
	}

	// Exclude imports
	visitLibraryImport() {
		return null;
	}

	visitLibraryExport() {
		return null;
	}

	visitPartDirective() {
		return null;
	}
}

export default class Dart2Map {
	static status = "done";
	static entryRule = "compilationUnit";
	static extensions = [".dart"];

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
