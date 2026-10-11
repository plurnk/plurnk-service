import SqlRite from "@possumtech/sqlrite";

// {§db-durability}: observe real connections, including their migration/INIT writes.
// Only the test SQL registry is extended; launcher options pass through unchanged.
const open = SqlRite.open.bind(SqlRite);
SqlRite.open = async (options) => {
    const db = await open({ ...options, dir: [...options.dir, import.meta.dirname] });
    try {
        const writer = await db.durability_writer.get();
        const readers = [];
        for (let index = 0; index < Math.max(1, options.readers ?? 0); index++) {
            readers.push(await db.durability_reader.get());
        }
        const history = await db.durability_history.all();
        const integrity = await db.durability_integrity.get();
        process.stderr.write(`durability-witness: ${JSON.stringify({ writer, readers, history, integrity })}\n`);
        return db;
    } catch (cause) {
        await db.close();
        throw cause;
    }
};
