-- PREP: native_content_retain
INSERT INTO native_contents (hash, content) VALUES ($hash, $content)
ON CONFLICT (hash) DO NOTHING;

-- PREP: native_content_read
SELECT content FROM native_contents WHERE hash = $hash;
