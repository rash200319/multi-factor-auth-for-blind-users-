import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: { port: 5190, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        enrol: resolve(__dirname, "enrol.html"),
        recover: resolve(__dirname, "recover.html"),
      },
    },
  },
});
