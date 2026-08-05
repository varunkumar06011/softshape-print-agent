import { Database } from "bun:sqlite";
const db = new Database("C:/Users/akhil/.softshape/edge.db");

// Check registration
const restaurantId = db.query("SELECT value FROM edge_config WHERE key = 'restaurant_id'").get() as any;
const backendUrl = db.query("SELECT value FROM edge_config WHERE key = 'backend_url'").get() as any;
const sessionToken = db.query("SELECT value FROM edge_config WHERE key = 'session_token'").get() as any;
const deviceId = db.query("SELECT value FROM edge_config WHERE key = 'device_id'").get() as any;
console.log("restaurant_id:", restaurantId?.value);
console.log("backend_url:", backendUrl?.value);
console.log("session_token:", sessionToken?.value ? sessionToken.value.substring(0, 20) + "..." : null);
console.log("device_id:", deviceId?.value);

// Check data counts
const tables = db.query("SELECT COUNT(*) as c FROM 'table'").get() as any;
const menuItems = db.query("SELECT COUNT(*) as c FROM menu_item").get() as any;
const orders = db.query("SELECT COUNT(*) as c FROM order_record").get() as any;
const settledOrders = db.query("SELECT COUNT(*) as c FROM order_record WHERE status = 'SETTLED'").get() as any;
const txns = db.query("SELECT COUNT(*) as c FROM transaction_record").get() as any;
const syncQueue = db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0").get() as any;
const syncQueuePending = db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'pending'").get() as any;
const syncQueueDead = db.query("SELECT COUNT(*) as c FROM sync_queue WHERE synced = 0 AND state = 'dead_letter'").get() as any;
console.log("\nData counts:");
console.log("  tables:", tables?.c);
console.log("  menu_items:", menuItems?.c);
console.log("  orders:", orders?.c);
console.log("  settled_orders:", settledOrders?.c);
console.log("  transaction_records:", txns?.c);
console.log("  sync_queue_pending:", syncQueuePending?.c);
console.log("  sync_queue_dead_letter:", syncQueueDead?.c);
console.log("  sync_queue_total_unsynced:", syncQueue?.c);

// Check recent transactions
const recentTxns = db.query("SELECT id, kind, order_id, cloud_synced, created_at FROM transaction_record ORDER BY created_at DESC LIMIT 5").all() as any[];
console.log("\nRecent transactions:");
for (const t of recentTxns) {
  console.log(`  ${t.id} kind=${t.kind} order=${t.order_id} synced=${t.cloud_synced} created=${new Date(t.created_at).toISOString()}`);
}

// Check analytics data (items sold)
const itemsSold = db.query("SELECT COUNT(*) as c FROM order_item").get() as any;
console.log("\norder_items:", itemsSold?.c);

// Check a sample of KOTs
const kots = db.query("SELECT COUNT(*) as c FROM kot").get() as any;
console.log("kots:", kots?.c);
