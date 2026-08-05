import { Database } from "bun:sqlite";

const files = [
  "C:/Users/akhil/.softshape/backups/edge-2026-08-04.db",
  "C:/Users/akhil/.softshape/backups/edge-pre-migrate-1785578231782.db",
  "C:/Users/akhil/.softshape/backups/edge-periodic-1785234292967.db",
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
    let txns = 0;
    try { txns = (db.query("SELECT COUNT(*) as c FROM transaction_record").get() as any)?.c || 0; } catch {}
    let syncQueue = 0;
    try { syncQueue = (db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0").get() as any)?.c || 0; } catch {}
    let expenditures = 0;
    try { expenditures = (db.query("SELECT COUNT(*) as c FROM expenditure").get() as any)?.c || 0; } catch {}
    console.log("  restaurant_id:", restaurantId?.value);
    console.log("  tables:", tables?.c, "menu_items:", menuItems?.c, "orders:", orders?.c, "settled:", settledOrders?.c);
    console.log("  txns:", txns, "sync_queue_unsynced:", syncQueue, "expenditures:", expenditures);
    db.close();
  } catch (e) {
    console.log("  Error:", (e as Error).message);
  }
}
