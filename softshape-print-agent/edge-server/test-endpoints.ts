// Test all edge server endpoints with proper auth
const RUNTIME_TOKEN = "070edb5d8b1a06429e9ebed3bb05624605bc318541f98895eb2ea59be751d8bb";
const EDGE_API_KEY = "4483fe10c4099bf57061b375554c3909e20daf12ca3b838a78d46ce534abf4f5";

const headers = {
  "Authorization": `Bearer ${RUNTIME_TOKEN}`,
  "X-Edge-Key": EDGE_API_KEY,
  "Content-Type": "application/json",
};

async function testEndpoint(name: string, path: string) {
  try {
    const res = await fetch(`http://localhost:3101${path}`, { headers });
    const status = res.status;
    if (status === 200) {
      const data = await res.json();
      const summary = Array.isArray(data) ? `array[${data.length}]` : typeof data === "object" ? Object.keys(data).join(",") : String(data);
      console.log(`✓ ${name}: ${status} — ${summary}`);
      return data;
    } else {
      const text = await res.text();
      console.log(`✗ ${name}: ${status} — ${text.substring(0, 100)}`);
      return null;
    }
  } catch (e) {
    console.log(`✗ ${name}: ERROR — ${(e as Error).message}`);
    return null;
  }
}

console.log("=== Edge Server Endpoint Tests ===\n");

// 1. Status
await testEndpoint("Status", "/api/edge/status");

// 2. Tables
const tables = await testEndpoint("Tables", "/api/edge/tables");
if (tables && Array.isArray(tables) && tables.length > 0) {
  console.log(`  First table: ${JSON.stringify(tables[0]).substring(0, 200)}`);
}

// 3. Menu
await testEndpoint("Menu", "/api/edge/menu");

// 4. Transactions
const txns = await testEndpoint("Transactions", "/api/edge/transactions?limit=5");
if (txns && Array.isArray(txns) && txns.length > 0) {
  console.log(`  First txn: ${JSON.stringify(txns[0]).substring(0, 200)}`);
}

// 5. Item Analytics
const today = new Date().toISOString().split("T")[0];
const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
await testEndpoint("Item Analytics", `/api/edge/analytics/items-sold?startDate=${weekAgo}&endDate=${today}`);

// 6. X-Report
await testEndpoint("X-Report", `/api/edge/x-report?date=${today}`);

// 7. Expenditures
await testEndpoint("Expenditures", `/api/edge/expenditures?date=${today}&limit=10`);
await testEndpoint("Expenditure Summary", `/api/edge/expenditures/today-summary?date=${today}`);

// 8. Ledger Categories
await testEndpoint("Ledger Categories", "/api/edge/ledger-categories?entryType=EXPENSE");

console.log("\n=== Done ===");
