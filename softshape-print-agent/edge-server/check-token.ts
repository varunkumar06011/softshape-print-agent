import { Database } from "bun:sqlite";
const db = new Database("C:/Users/akhil/.softshape/edge.db");
const row = db.query("SELECT value FROM edge_config WHERE key = 'runtime_token'").get() as any;
console.log("Runtime token:", row?.value);
