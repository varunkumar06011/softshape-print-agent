import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const db = new Database(join(homedir(), ".softshape", "edge.db"));
db.query("DELETE FROM edge_config WHERE key='active_instance_lock'").run();
db.query("DELETE FROM edge_config WHERE key='setup_nonce'").run();
console.log("[cleanup] Instance lock + setup nonce cleared");
db.close();
