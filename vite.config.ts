import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../dist/web",
  },
  root: "web",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4280",
    },
  },
});
