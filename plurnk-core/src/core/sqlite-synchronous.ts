import { Knob } from "@plurnk/plurnk-meta";

// {§db-durability}: resolve policy before opening any application database connection.
export const sqliteSynchronous = () => Knob.choice(
    "PLURNK_SERVICE_SQLITE_SYNCHRONOUS", ["OFF", "NORMAL", "FULL", "EXTRA"],
);
