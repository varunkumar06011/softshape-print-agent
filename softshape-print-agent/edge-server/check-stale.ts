import { Database } from "bun:sqlite";

const files = [
  "C:/Users/akhil/.softshape/edge.db.stale-schema-1785578231802",
  "C:/Users/akhil/.softshape/edge.db.stale-schema-1784751725015",
  "C:/Users/akhil/.softshape/edge.db.stale-schema-1784751701552",
];

for (const file of files) {
  console.log(`\n=== ${file.split('/').pop()} ===`);
  try {
    const db = new Database(file, { readonly: true });
    const restaurantId = db.query("SELECT value FROM edge_config WHERE key = 'restaurant_id'").get() as any;
    const tables = db.query("SELECT COUNT(*) as c FROM 'table'").get() as any;
    const menuItems = db.query("SELECT COUNT(*) as c FROM menu_item").get() as any;
    const orders = db.query("SELECT COUNT(*) as c FROM order_record").get() as any;
    const settledOrders = db.query("SELECT COUNT(*) as c FROM order_record WHERE status = 'SETTLED'").get() as any;
    const txns = db.query("SELECT COUNT(*) as c FROM transaction_record").get() as any;
    console.log("  restaurant_id:", restaurantId?.value);
    console.log("  tables:", tables?.c, "menu_items:", menuItems?.c, "orders:", orders?.c, "settled:", settledOrders?.c, "txns:", txns?.c);
    db.close();
  } catch (e) {
    console.log("  Error:", e);
  }
}
