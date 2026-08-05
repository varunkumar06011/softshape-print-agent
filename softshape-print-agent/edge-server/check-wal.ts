import { Database } from "bun:sqlite";

// Check the live DB (with WAL)
const db = new Database("C:/Users/akhil/.softshape/edge.db");

// Check all edge_config keys
const configs = db.query("SELECT key, substr(value, 1, 80) as val FROM edge_config ORDER BY key").all() as any[];
console.log("=== edge_config keys ===");
for (const c of configs) {
  console.log(`  ${c.key}: ${c.val}`);
}

// Check if there's ANY data
const tables = db.query("SELECT COUNT(*) as c FROM 'table'").get() as any;
const menuItems = db.query("SELECT COUNT(*) as c FROM menu_item").get() as any;
const sections = db.query("SELECT COUNT(*) as c FROM section").get() as any;
const categories = db.query("SELECT COUNT(*) as c FROM category").get() as any;
console.log("\n=== Data counts (with WAL) ===");
console.log("  tables:", tables?.c);
console.log("  sections:", sections?.c);
console.log("  categories:", categories?.c);
console.log("  menu_items:", menuItems?.c);

// Check sync_queue
const syncQ = db.query("SELECT COUNT(*) as c FROM sync_queue").get() as any;
console.log("  sync_queue total:", syncQ?.c);

db.close();
