import { Database } from "bun:sqlite";
const db = new Database("C:/Users/akhil/.softshape/edge.db");

// Check all edge_config keys
const configs = db.query("SELECT key, substr(value, 1, 100) as val FROM edge_config ORDER BY key").all() as any[];
console.log("=== edge_config keys ===");
for (const c of configs) {
  console.log(`  ${c.key}: ${c.val}`);
}

// Check data counts now
const tables = db.query("SELECT COUNT(*) as c FROM 'table'").get() as any;
const menuItems = db.query("SELECT COUNT(*) as c FROM menu_item").get() as any;
const sections = db.query("SELECT COUNT(*) as c FROM section").get() as any;
console.log("\n=== Data counts ===");
console.log("  tables:", tables?.c, "sections:", sections?.c, "menu_items:", menuItems?.c);

db.close();
