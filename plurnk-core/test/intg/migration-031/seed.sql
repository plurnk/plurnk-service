-- {§db-migrations} A database the migration before 31 left: a model worker has sent its peer a message the peer's
-- live loop has not answered. Constant fixture SQL, run once against that version; it names no column 31 adds.

-- EXEC: test_seed_message_openers
INSERT INTO workspaces (id, name) VALUES (1, 'openers');
INSERT INTO worker_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
INSERT INTO workers (id, workspace_id, name, origin) VALUES (1, 1, 'main', 'model'), (2, 1, 'peer', 'model');
INSERT INTO loops (id, worker_id, sequence, prompt, max_turns) VALUES (1, 1, 1, 'Ask the peer.', -1), (2, 2, 1, 'What is the answer?', -1);
INSERT INTO loop_messages (id, loop_id, ordinal, source, body) VALUES (1, 2, 1, 'worker://main', 'What is the answer?');
