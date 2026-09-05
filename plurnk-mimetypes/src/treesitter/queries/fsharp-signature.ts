// {§mimetype-references}: signatures share declaration mapping with F#,
// but their grammar has no implementation application nodes.
export const refsQuery = `
(import_decl (long_identifier) @ref.import)
(class_inherits_decl (simple_type (long_identifier) @ref.inherit))
(typed_pattern (simple_type (long_identifier) @ref.type))
(record_field (simple_type (long_identifier) @ref.type))
(argument_spec (simple_type (long_identifier) @ref.type))
(curried_spec (simple_type (long_identifier) @ref.type))
`;
