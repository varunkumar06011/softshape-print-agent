// E2E test: simulate the captain app's full login + print flow
import bcrypt from "bcryptjs";

const EDGE_URL = "http://127.0.0.1:3101";

async function testFlow() {
  console.log("=== E2E Captain Login Flow Test ===\n");

  // Step 1: Health check
  console.log("Step 1: Health check...");
  const health = await fetch(`${EDGE_URL}/health`);
  const h = await health.json();
  console.log(`  isOperational=${h.isOperational}, sessionValid=${h.sessionValid}, onboarded=${h.onboarded}`);
  if (!h.isOperational) throw new Error("Edge server not operational");
  console.log("  ✅ PASS\n");

  // Step 2: Fetch staff list (no auth)
  console.log("Step 2: Fetch staff list (no auth headers)...");
  const staffRes = await fetch(`${EDGE_URL}/api/edge/staff`);
  if (!staffRes.ok) throw new Error(`Staff list failed: ${staffRes.status}`);
  const staffData = await staffRes.json();
  console.log(`  Found ${staffData.staff.length} staff members`);
  const captain = staffData.staff.find(s => s.role === "CAPTAIN");
  if (!captain) throw new Error("No captain found in staff list");
  console.log(`  Captain: ${captain.name} (${captain.id})`);
  console.log("  ✅ PASS\n");

  // Step 3: PIN login (no auth headers — public LAN path)
  console.log("Step 3: PIN login with correct PIN (1234)...");
  const pinRes = await fetch(`${EDGE_URL}/api/edge/auth/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: captain.id, pin: "1234" }),
  });
  if (!pinRes.ok) {
    const err = await pinRes.json().catch(() => ({}));
    throw new Error(`PIN login failed: ${pinRes.status} ${JSON.stringify(err)}`);
  }
  const pinData = await pinRes.json();
  console.log(`  success=${pinData.success}`);
  console.log(`  user=${pinData.user.name} (${pinData.user.role})`);
  console.log(`  runtimeToken=${pinData.runtimeToken ? "present (" + pinData.runtimeToken.slice(0, 16) + "...)" : "MISSING"}`);
  console.log(`  edgeApiKey=${pinData.edgeApiKey ? "present (" + pinData.edgeApiKey.slice(0, 16) + "...)" : "MISSING"}`);
  if (!pinData.runtimeToken) throw new Error("No runtimeToken in response");
  if (!pinData.edgeApiKey) throw new Error("No edgeApiKey in response");
  console.log("  ✅ PASS\n");

  // Step 4: PIN login with wrong PIN
  console.log("Step 4: PIN login with wrong PIN (9999)...");
  const wrongPinRes = await fetch(`${EDGE_URL}/api/edge/auth/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: captain.id, pin: "9999" }),
  });
  console.log(`  status=${wrongPinRes.status}`);
  if (wrongPinRes.status !== 401) throw new Error(`Expected 401, got ${wrongPinRes.status}`);
  console.log("  ✅ PASS (correctly rejected)\n");

  // Step 5: Use runtime token + edge API key to fetch outlet config
  console.log("Step 5: Fetch outlet config with received credentials...");
  const outletRes = await fetch(`${EDGE_URL}/api/edge/outlet`, {
    headers: {
      "X-Edge-Key": pinData.edgeApiKey,
      "Authorization": `Bearer ${pinData.runtimeToken}`,
    },
  });
  if (!outletRes.ok) {
    const err = await outletRes.json().catch(() => ({}));
    throw new Error(`Outlet fetch failed: ${outletRes.status} ${JSON.stringify(err)}`);
  }
  const outlet = await outletRes.json();
  console.log(`  Outlet: ${outlet.name} (${outlet.restaurant_code || outlet.restaurantCode})`);
  console.log("  ✅ PASS\n");

  // Step 6: Fetch tables with credentials
  console.log("Step 6: Fetch tables with credentials...");
  const tablesRes = await fetch(`${EDGE_URL}/api/edge/tables`, {
    headers: {
      "X-Edge-Key": pinData.edgeApiKey,
      "Authorization": `Bearer ${pinData.runtimeToken}`,
    },
  });
  if (!tablesRes.ok) {
    const err = await tablesRes.json().catch(() => ({}));
    throw new Error(`Tables fetch failed: ${tablesRes.status} ${JSON.stringify(err)}`);
  }
  const tablesData = await tablesRes.json();
  const tables = tablesData.tables || tablesData;
  console.log(`  Tables: ${Array.isArray(tables) ? tables.length : Object.keys(tables).length}`);
  console.log("  ✅ PASS\n");

  // Step 7: Fetch menu with credentials
  console.log("Step 7: Fetch menu items with credentials...");
  const menuRes = await fetch(`${EDGE_URL}/api/edge/menu`, {
    headers: {
      "X-Edge-Key": pinData.edgeApiKey,
      "Authorization": `Bearer ${pinData.runtimeToken}`,
    },
  });
  if (!menuRes.ok) {
    const err = await menuRes.json().catch(() => ({}));
    throw new Error(`Menu fetch failed: ${menuRes.status} ${JSON.stringify(err)}`);
  }
  const menuData = await menuRes.json();
  const items = menuData.items || menuData.menuItems || [];
  console.log(`  Menu items: ${items.length}`);
  console.log("  ✅ PASS\n");

  // Step 8: Try accessing protected endpoint WITHOUT credentials (should fail)
  console.log("Step 8: Access protected endpoint without auth (should fail)...");
  const noAuthRes = await fetch(`${EDGE_URL}/api/edge/outlet`);
  console.log(`  status=${noAuthRes.status}`);
  if (noAuthRes.status === 200) throw new Error("Should have been rejected without auth");
  console.log("  ✅ PASS (correctly rejected)\n");

  // Step 9: Try with only edge API key (no runtime token)
  console.log("Step 9: Access with only X-Edge-Key (no Bearer)...");
  const keyOnlyRes = await fetch(`${EDGE_URL}/api/edge/outlet`, {
    headers: { "X-Edge-Key": pinData.edgeApiKey },
  });
  console.log(`  status=${keyOnlyRes.status}`);
  if (keyOnlyRes.status === 200) throw new Error("Should have been rejected without runtime token");
  console.log("  ✅ PASS (correctly rejected)\n");

  console.log("=== ALL TESTS PASSED ===");
  console.log("\nSummary:");
  console.log("  - /api/edge/staff works without auth (PUBLIC_LAN_PATHS + PUBLIC_PATHS)");
  console.log("  - /api/edge/auth/pin works without auth (PUBLIC_LAN_PATHS + PUBLIC_PATHS)");
  console.log("  - PIN login returns runtimeToken AND edgeApiKey");
  console.log("  - Protected endpoints work with both credentials");
  console.log("  - Protected endpoints reject missing credentials");
  process.exit(0);
}

testFlow().catch(err => {
  console.error("\n❌ TEST FAILED:", err.message);
  process.exit(1);
});
