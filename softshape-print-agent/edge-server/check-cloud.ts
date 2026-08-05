// Check what restaurants/data exist in the cloud backend
import { Database } from "bun:sqlite";

// Query the cloud PostgreSQL via the backend API
const res = await fetch("http://localhost:3000/api/health");
const health = await res.json();
console.log("Cloud health:", JSON.stringify(health));

// Try to get restaurants list (might need auth)
const res2 = await fetch("http://localhost:3000/api/restaurants");
console.log("\nRestaurants status:", res2.status);
if (res2.ok) {
  const data = await res2.json();
  console.log("Restaurants:", JSON.stringify(data).substring(0, 500));
}

// Check edge routes
const res3 = await fetch("http://localhost:3000/api/edge/status");
console.log("\nEdge status:", res3.status);
if (res3.ok) {
  const data = await res3.json();
  console.log("Edge status:", JSON.stringify(data));
}
