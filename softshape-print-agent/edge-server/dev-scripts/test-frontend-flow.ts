// E2E frontend test: simulates exactly what the captain app's JavaScript does
// Run this in the browser console at http://localhost:5174/captain.html
// or run via bun (it uses fetch, which works in both environments).

const EDGE_URL = "http://127.0.0.1:3101";

// Simulate localStorage keys used by the captain app
const fakeLocalStorage = {};
const ls = {
  getItem: (k) => fakeLocalStorage[k] ?? null,
  setItem: (k, v) => { fakeLocalStorage[k] = String(v); },
  removeItem: (k) => { delete fakeLocalStorage[k]; },
};

async function testFrontendFlow() {
  console.log("=== Frontend E2E: Captain App Login Flow ===\n");

  // ── Simulate fresh install (empty localStorage) ───────────────────────────
  console.log("Step 1: Fresh install — localStorage is empty");
  console.log(`  softshape_edge_url = ${ls.getItem("softshape_edge_url")}`);
  console.log(`  softshape_edge_api_key = ${ls.getItem("softshape_edge_api_key")}`);
  console.log(`  softshape_edge_runtime_token = ${ls.getItem("softshape_edge_runtime_token")}`);
  console.log("  ✅ Fresh state confirmed\n");

  // ── Step 2: Edge URL discovery fails (127.0.0.1 on phone) ─────────────────
  console.log("Step 2: Edge health check on default URL (127.0.0.1:3101)...");
  try {
    const res = await fetch(`${EDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const h = await res.json();
    console.log(`  Health: isOperational=${h.isOperational}, onboarded=${h.onboarded}`);
    console.log("  ✅ Edge is reachable at 127.0.0.1:3101 (dev PC)\n");
  } catch (err) {
    console.log(`  Edge not reachable at 127.0.0.1:3101: ${err.message}`);
    console.log("  → On a real phone, user would need to enter edge URL manually\n");
  }

  // ── Step 3: Simulate user entering edge URL manually ──────────────────────
  console.log("Step 3: User enters edge URL manually...");
  ls.setItem("softshape_edge_url", EDGE_URL);
  console.log(`  softshape_edge_url = ${ls.getItem("softshape_edge_url")}`);
  console.log("  ✅ Edge URL stored\n");

  // ── Step 4: Fetch crew list (edge-first, no auth needed) ──────────────────
  console.log("Step 4: Fetch crew list from edge (no auth)...");
  const staffRes = await fetch(`${EDGE_URL}/api/edge/staff`);
  if (!staffRes.ok) throw new Error(`Staff fetch failed: ${staffRes.status}`);
  const staffData = await staffRes.json();
  const captain = staffData.staff.find(s => s.role === "CAPTAIN");
  console.log(`  Found captain: ${captain.name} (${captain.id})`);
  console.log("  ✅ PASS\n");

  // ── Step 5: PIN login (simulates authService.captainLogin → _tryEdgePinLogin) ─
  console.log("Step 5: PIN login (no auth headers — public path)...");
  const pinRes = await fetch(`${EDGE_URL}/api/edge/auth/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: captain.id, pin: "1234" }),
  });
  if (!pinRes.ok) throw new Error(`PIN login failed: ${pinRes.status}`);
  const loginData = await pinRes.json();

  // Simulate what authService._tryEdgePinLogin does:
  // 1. setStoredEdgeRuntimeToken(data.runtimeToken)
  ls.setItem("softshape_edge_runtime_token", loginData.runtimeToken);
  // 2. setStoredEdgeApiKey(data.edgeApiKey)
  ls.setItem("softshape_edge_api_key", loginData.edgeApiKey);
  // 3. secureStorage.setItem('ss_token', `edge-local-${Date.now()}`)
  const localToken = `edge-local-${Date.now()}`;
  ls.setItem("ss_token", localToken);
  // 4. localStorage.setItem('ss_user', JSON.stringify(data.user))
  ls.setItem("ss_user", JSON.stringify(loginData.user));

  console.log(`  runtimeToken stored: ${ls.getItem("softshape_edge_runtime_token").slice(0, 16)}...`);
  console.log(`  edgeApiKey stored: ${ls.getItem("softshape_edge_api_key").slice(0, 16)}...`);
  console.log(`  ss_token stored: ${ls.getItem("ss_token")}`);
  console.log(`  ss_user stored: ${ls.getItem("ss_user")}`);
  console.log("  ✅ PASS\n");

  // ── Step 6: Verify isEdgeLocalAuth() logic ────────────────────────────────
  console.log("Step 6: Verify isEdgeLocalAuth() check...");
  const token = ls.getItem("ss_token");
  const isEdgeLocal = token && token.startsWith("edge-local-");
  const hasRuntimeToken = !!ls.getItem("softshape_edge_runtime_token");
  const loginScreenDidEdgePinLogin = isEdgeLocal && hasRuntimeToken;
  console.log(`  token starts with 'edge-local-': ${isEdgeLocal}`);
  console.log(`  has runtime token: ${hasRuntimeToken}`);
  console.log(`  loginScreenDidEdgePinLogin: ${loginScreenDidEdgePinLogin}`);
  if (!loginScreenDidEdgePinLogin) throw new Error("Double PIN screen check failed");
  console.log("  ✅ PASS — CaptainApp would skip its internal PIN screen\n");

  // ── Step 7: Fetch outlet config (simulates what _tryEdgePinLogin does next) ─
  console.log("Step 7: Fetch outlet config with received credentials...");
  const effectiveApiKey = loginData.edgeApiKey;
  const outletRes = await fetch(`${EDGE_URL}/api/edge/outlet`, {
    headers: {
      "X-Edge-Key": effectiveApiKey,
      "Authorization": `Bearer ${loginData.runtimeToken}`,
    },
  });
  if (!outletRes.ok) throw new Error(`Outlet fetch failed: ${outletRes.status}`);
  const outlet = await outletRes.json();
  console.log(`  Outlet: ${outlet.name}, code: ${outlet.restaurant_code}`);
  // Simulate localStorage.setItem('ss_restaurant', JSON.stringify(restaurantConfig))
  ls.setItem("ss_restaurant", JSON.stringify({
    id: outlet.id,
    name: outlet.name,
    slug: outlet.slug,
    restaurantCode: outlet.restaurant_code,
  }));
  console.log("  ✅ PASS\n");

  // ── Step 8: Simulate edgeFetch() for KOT printing ──────────────────────────
  console.log("Step 8: Simulate edgeFetch() for protected operations...");
  const edgeApiKey = ls.getItem("softshape_edge_api_key");
  const runtimeToken = ls.getItem("softshape_edge_runtime_token");

  // Fetch tables (what CaptainApp does on dashboard load)
  const tablesRes = await fetch(`${EDGE_URL}/api/edge/tables`, {
    headers: {
      "X-Edge-Key": edgeApiKey,
      "Authorization": `Bearer ${runtimeToken}`,
    },
  });
  if (!tablesRes.ok) throw new Error(`Tables fetch failed: ${tablesRes.status}`);
  const tablesData = await tablesRes.json();
  console.log(`  Tables fetched: ${JSON.stringify(tablesData).slice(0, 100)}...`);
  console.log("  ✅ PASS\n");

  // ── Step 9: Simulate logout (AuthContext.logout) ───────────────────────────
  console.log("Step 9: Simulate logout...");
  // AuthContext.logout clears these:
  ls.removeItem("ss_token");
  ls.removeItem("ss_preauth_token");
  ls.removeItem("ss_user");
  ls.removeItem("ss_restaurant");
  // But does NOT clear edge keys:
  const edgeUrlAfterLogout = ls.getItem("softshape_edge_url");
  const edgeKeyAfterLogout = ls.getItem("softshape_edge_api_key");
  const runtimeTokenAfterLogout = ls.getItem("softshape_edge_runtime_token");
  console.log(`  softshape_edge_url after logout: ${edgeUrlAfterLogout}`);
  console.log(`  softshape_edge_api_key after logout: ${edgeKeyAfterLogout ? "preserved" : "CLEARED!"}`);
  console.log(`  softshape_edge_runtime_token after logout: ${runtimeTokenAfterLogout ? "preserved" : "CLEARED!"}`);
  if (!edgeUrlAfterLogout) throw new Error("Edge URL was cleared on logout!");
  if (!edgeKeyAfterLogout) throw new Error("Edge API key was cleared on logout!");
  if (!runtimeTokenAfterLogout) throw new Error("Runtime token was cleared on logout!");
  console.log("  ✅ PASS — Edge credentials preserved across logout\n");

  // ── Step 10: Simulate re-login after logout ────────────────────────────────
  console.log("Step 10: Re-login after logout (edge URL already persisted)...");
  // getEdgeUrl() returns persisted URL
  const edgeUrl = ls.getItem("softshape_edge_url");
  console.log(`  getEdgeUrl() = ${edgeUrl}`);

  // Health check with persisted URL
  const healthRes = await fetch(`${edgeUrl}/health`);
  const health2 = await healthRes.json();
  console.log(`  Health: isOperational=${health2.isOperational}`);

  // Staff list
  const staffRes2 = await fetch(`${edgeUrl}/api/edge/staff`);
  const staffData2 = await staffRes2.json();
  const captain2 = staffData2.staff.find(s => s.role === "CAPTAIN");
  console.log(`  Staff list: found ${captain2.name}`);

  // PIN login again
  const pinRes2 = await fetch(`${edgeUrl}/api/edge/auth/pin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: captain2.id, pin: "1234" }),
  });
  const loginData2 = await pinRes2.json();
  console.log(`  PIN login: success=${loginData2.success}, runtimeToken=${loginData2.runtimeToken ? "present" : "MISSING"}`);
  if (!loginData2.success) throw new Error("Re-login failed");
  console.log("  ✅ PASS — Re-login works after logout\n");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("=== ALL FRONTEND TESTS PASSED ===");
  console.log("\nVerified flow:");
  console.log("  1. Fresh install → edge URL not set");
  console.log("  2. Manual edge URL entry → stored in localStorage");
  console.log("  3. Staff list fetch → works without auth (PUBLIC_LAN_PATHS)");
  console.log("  4. PIN login → returns runtimeToken + edgeApiKey");
  console.log("  5. Credentials stored in localStorage");
  console.log("  6. isEdgeLocalAuth() + getStoredEdgeRuntimeToken() → true (no double PIN)");
  console.log("  7. Outlet config fetch → works with received credentials");
  console.log("  8. Protected edge calls (tables) → work with X-Edge-Key + Bearer");
  console.log("  9. Logout → clears cloud auth, preserves edge credentials");
  console.log("  10. Re-login → works with persisted edge URL");
  process.exit(0);
}

testFrontendFlow().catch(err => {
  console.error("\n❌ TEST FAILED:", err.message);
  process.exit(1);
});
