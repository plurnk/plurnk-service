// References query for tree-sitter-cpp (issue #19; SPEC §16).
// Same conventions as queries/typescript.ts and queries/rust.ts:
//   - import refs capture bound names: the final identifier of
//     `using std::vector;` (qualified chains nest on the NAME side in this
//     grammar, so depth-1 and depth-2 forms are patterned — depth ≥3 using
//     declarations are rare enough to skip). `using namespace std;` opens a
//     scope rather than binding a symbol and `#include` is a path — neither
//     is emitted.
//   - call refs capture the callee name node: plain identifiers, the method
//     name of field-expression calls (`obj.area()` / `ptr->scale()`), the
//     FINAL segment of qualified calls (`helper::square()` → square, depth
//     ≤2 scopes), and template-function heads (`make_unique<T>()`).
//   - instantiate = new-expression type names (plain, qualified final
//     segment, template head) and compound-literal construction
//     (`Token{}`). Constructor-style declarations (`Circle c(1.0);`) are
//     NOT instantiate — the grammar parses them as plain declarations and
//     their type names already surface as type refs.
//   - inherit = base_class_clause type names (qualified bases capture the
//     final segment).
//   - type refs cover param/field/local/return positions (template heads
//     included, template arguments not — mirrors the rust query's scope);
//     class/struct/enum DEFINITION names are never in a `type:` field of
//     these parents, so they stay out.
//   - `use` is reserved; bare identifier reads are not emitted.
export const refsQuery = `
(using_declaration (qualified_identifier name: (identifier) @ref.import))
(using_declaration (qualified_identifier name: (qualified_identifier name: (identifier) @ref.import)))

(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (qualified_identifier name: (identifier) @ref.call))
(call_expression function: (qualified_identifier name: (qualified_identifier name: (identifier) @ref.call)))
(call_expression function: (template_function name: (identifier) @ref.call))
(call_expression function: (qualified_identifier name: (template_function name: (identifier) @ref.call)))

(new_expression type: (type_identifier) @ref.instantiate)
(new_expression type: (qualified_identifier name: (type_identifier) @ref.instantiate))
(new_expression type: (template_type name: (type_identifier) @ref.instantiate))
(compound_literal_expression type: (type_identifier) @ref.instantiate)

(base_class_clause (type_identifier) @ref.inherit)
(base_class_clause (qualified_identifier name: (type_identifier) @ref.inherit))

(parameter_declaration type: (type_identifier) @ref.type)
(parameter_declaration type: (template_type name: (type_identifier) @ref.type))
(parameter_declaration type: (qualified_identifier name: (type_identifier) @ref.type))
(parameter_declaration type: (qualified_identifier name: (template_type name: (type_identifier) @ref.type)))

(field_declaration type: (type_identifier) @ref.type)
(field_declaration type: (template_type name: (type_identifier) @ref.type))
(field_declaration type: (qualified_identifier name: (type_identifier) @ref.type))
(field_declaration type: (qualified_identifier name: (template_type name: (type_identifier) @ref.type)))

(declaration type: (type_identifier) @ref.type)
(declaration type: (template_type name: (type_identifier) @ref.type))
(declaration type: (qualified_identifier name: (type_identifier) @ref.type))
(declaration type: (qualified_identifier name: (template_type name: (type_identifier) @ref.type)))

(function_definition type: (type_identifier) @ref.type)
(function_definition type: (template_type name: (type_identifier) @ref.type))
(function_definition type: (qualified_identifier name: (type_identifier) @ref.type))
(function_definition type: (qualified_identifier name: (template_type name: (type_identifier) @ref.type)))
`;
