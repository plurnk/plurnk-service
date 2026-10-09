-- MIGRATE: 16 selection_statements
-- Released in 2.0.0 and frozen ({§db-migrations}): a shape change is the next MIGRATE version, never an edit here.
-- {§target-group} {§db-migrations}: normalize derived ASTs, never original emissions or reasoning.
-- Historical group members determined dispatch; duplicated top-level fields did not override them.
UPDATE turns
SET packet = json_set(packet, '$.assistant.ops', json((
    WITH operations AS (
        SELECT item.key AS ordinal,
               turns.packet -> ('$.assistant.ops[' || item.key || ']') AS statement
        FROM json_each(turns.packet, '$.assistant.ops') AS item
    ), normalized AS (
        SELECT ordinal, member.key AS member_ordinal,
               CASE WHEN json_extract(statement, '$.op') IN ('READ', 'KILL')
                         AND json_type(statement, '$.group') = 'array'
                    THEN json_set(json_remove(statement, '$.group'),
                        '$.target', json(member.value -> '$.target'),
                        '$.lineMarker', json(member.value -> '$.lineMarker'),
                        '$.metadata', json(member.value -> '$.metadata'),
                        '$.matcher', json(CASE
                            WHEN json_type(member.value, '$.matcher') = 'null'
                                 AND json_type(statement, '$.group[0].matcher') = 'null'
                            THEN statement -> '$.matcher'
                            ELSE member.value -> '$.matcher'
                        END),
                        '$.body', json(CASE
                            WHEN json_extract(statement, '$.op') = 'KILL' AND member.key > 0 THEN 'null'
                            ELSE statement -> '$.body'
                        END))
                    ELSE statement
               END AS statement
        FROM operations
        LEFT JOIN json_each(CASE
            WHEN json_extract(statement, '$.op') IN ('READ', 'KILL')
                 AND json_type(statement, '$.group') = 'array' THEN statement -> '$.group'
            ELSE '[]'
        END) AS member ON 1
    )
    SELECT json_group_array(json(statement) ORDER BY ordinal, member_ordinal) FROM normalized
)))
WHERE EXISTS (
    SELECT 1 FROM json_each(turns.packet, '$.assistant.ops') AS item
    WHERE json_extract(turns.packet, '$.assistant.ops[' || item.key || '].op') IN ('READ', 'KILL')
      AND json_type(turns.packet, '$.assistant.ops[' || item.key || '].group') = 'array'
);
