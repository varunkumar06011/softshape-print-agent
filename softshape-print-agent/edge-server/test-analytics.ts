const RUNTIME_TOKEN = "070edb5d8b1a06429e9ebed3bb05624605bc318541f98895eb2ea59be751d8bb";
const EDGE_API_KEY = "4483fe10c4099bf57061b375554c3909e20daf12ca3b838a78d46ce534abf4f5";

const headers = {
  "Authorization": `Bearer ${RUNTIME_TOKEN}`,
  "X-Edge-Key": EDGE_API_KEY,
  "Content-Type": "application/json",
};

const today = new Date().toISOString().split("T")[0];
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

console.log(`Date range: ${weekAgo} to ${today}\n`);

// Item Analytics
const res = await fetch(`http://localhost:3101/api/edge/analytics/items-sold?startDate=${weekAgo}&endDate=${today}`, { headers });
const data = await res.json();
console.log("=== Item Analytics ===");
console.log("Status:", res.status);
console.log("Summary:", JSON.stringify(data.summary));
console.log("Date range:", JSON.stringify(data.dateRange));
console.log("Items count:", data.items?.length || 0);
if (data.items && data.items.length > 0) {
  console.log("\nTop 5 items:");
  const sorted = [...data.items].sort((a: any, b: any) => (b.quantity || b.totalQty || 0) - (a.quantity || a.totalQty || 0));
  for (const item of sorted.slice(0, 5)) {
    console.log(`  ${item.name || item.menuItemName}: qty=${item.quantity || item.totalQty}, revenue=${item.revenue || item.totalRevenue}`);
  }
} else {
  console.log("No items returned");
  console.log("Full response:", JSON.stringify(data).substring(0, 500));
}

// Also try last 30 days
console.log(`\n=== Last 30 days: ${monthAgo} to ${today} ===`);
const res2 = await fetch(`http://localhost:3101/api/edge/analytics/items-sold?startDate=${monthAgo}&endDate=${today}`, { headers });
const data2 = await res2.json();
console.log("Items count:", data2.items?.length || 0);
if (data2.items && data2.items.length > 0) {
  console.log("\nTop 5 items:");
  const sorted = [...data2.items].sort((a: any, b: any) => (b.quantity || b.totalQty || 0) - (a.quantity || a.totalQty || 0));
  for (const item of sorted.slice(0, 5)) {
    console.log(`  ${item.name || item.menuItemName}: qty=${item.quantity || item.totalQty}, revenue=${item.revenue || item.totalRevenue}`);
  }
}

// Check transactions
console.log("\n=== Transactions (last 30 days) ===");
const txnRes = await fetch(`http://localhost:3101/api/edge/transactions?limit=10`, { headers });
const txns = await txnRes.json();
console.log("Transactions count:", Array.isArray(txns) ? txns.length : "not array");
if (Array.isArray(txns) && txns.length > 0) {
  for (const t of txns.slice(0, 3)) {
    console.log(`  ${t.id}: amount=${t.amount || t.totalAmount}, date=${t.createdAt || t.created_at}`);
  }
}

// Check orders
console.log("\n=== Orders ===");
const orderRes = await fetch(`http://localhost:3101/api/edge/orders?limit=10`, { headers });
if (orderRes.ok) {
  const orders = await orderRes.json();
  console.log("Orders count:", Array.isArray(orders) ? orders.length : "not array");
} else {
  console.log("Orders status:", orderRes.status, await orderRes.text());
}
