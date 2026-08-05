// Find the restaurant code and login
import jwt from "jsonwebtoken";

const AGENT_JWT_SECRET = "dev-only-agent-secret";

// Try common restaurant codes
const codes = ["TEST", "DEMO", "SOFTSHAPE", "SS", "BAR", "RESTAURANT"];

for (const code of codes) {
  const loginRes = await fetch("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@softshape.in", password: "password123", restaurantCode: code }),
  });
  if (loginRes.ok) {
    const data = await loginRes.json();
    console.log(`Login succeeded with code=${code}:`, JSON.stringify(data).substring(0, 300));
    break;
  } else {
    const errBody = await loginRes.json().catch(() => ({}));
    console.log(`code=${code}: ${loginRes.status} ${errBody.error || ''}`);
  }
}

// Try to find the restaurant via the onboard endpoint
const onboardRes = await fetch("http://localhost:3000/api/onboard/restaurants");
console.log("\nOnboard restaurants:", onboardRes.status);
if (onboardRes.ok) {
  const data = await onboardRes.json();
  console.log(JSON.stringify(data).substring(0, 500));
}

// Try the edge key endpoint with various approaches
// Let's generate a setup token directly using the agent secret
// We need the restaurantId — let's try to find it

// Try the health check for restaurant info
const checkRes = await fetch("http://localhost:3000/api/edge/health");
console.log("\nEdge health:", checkRes.status);
if (checkRes.ok) {
  const data = await checkRes.json();
  console.log(JSON.stringify(data).substring(0, 500));
}
