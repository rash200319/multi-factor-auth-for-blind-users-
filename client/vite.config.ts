import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    port: 5190,
    strictPort: true,
    // Vite blocks requests whose Host header it doesn't recognise (DNS
    // rebinding protection). Quick-tunnel hostnames are random each run,
    // so allow the whole trycloudflare.com domain rather than one literal
    // hostname — see tools/tunnel.mjs for the HTTPS-tunnel dev flow.
    allowedHosts: [".trycloudflare.com"],
  },
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
