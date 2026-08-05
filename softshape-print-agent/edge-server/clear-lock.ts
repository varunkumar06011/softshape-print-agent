import { Database } from "bun:sqlite";
const db = new Database("C:/Users/akhil/.softshape/edge.db");
db.query("DELETE FROM edge_config WHERE key = 'active_instance_lock'").run();
console.log("Instance lock cleared");
db.close();
