import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
  define: {
    "import.meta.env.VITE_BACKEND_URL": JSON.stringify("http://localhost:3000"),
    "import.meta.env?.VITE_BACKEND_URL": JSON.stringify("http://localhost:3000"),
  },
});
