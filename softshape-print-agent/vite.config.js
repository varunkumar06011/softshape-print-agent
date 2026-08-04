import { defineConfig } from "vite";

// ─────────────────────────────────────────────────────────────────────────────
// DO NOT BUILD THIS COPY — BUILD THE ROOT COPY INSTEAD
// ─────────────────────────────────────────────────────────────────────────────
// The shipped print agent is the ROOT copy at softshape-print-agent/src/.
// CI runs `npx tauri build` from the repo root, which builds the root copy.
//
// This nested copy (softshape-print-agent/softshape-print-agent/) exists ONLY
// because its edge-server/ directory is bundled as a resource by the
// cashier-desktop app. Its frontend (src/) and Tauri app (src-tauri/) are NOT
// shipped and should NOT be built.
//
// NOTE: This nested copy previously contained edge-WS integration that the root
// copy was missing. That code has been ported to the root copy's main.js as of
// 2025-07. Do not assume this nested copy is a superset — it may diverge further
// over time. If you need to make print-agent changes, edit the ROOT copy.
//
// To build the print agent:  cd softshape-print-agent && npx tauri build
// ─────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === "production" || process.argv.includes("build")) {
  console.error(
    "\n[DO NOT BUILD] This nested copy's frontend is not shipped.\n" +
    "The active print agent is at softshape-print-agent/src/ (the ROOT copy).\n" +
    "This nested copy exists only for its edge-server/ directory, which is bundled\n" +
    "into the cashier-desktop app as a resource.\n\n" +
    "To build the print agent: cd softshape-print-agent && npx tauri build\n"
  );
  process.exit(1);
}

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
});
