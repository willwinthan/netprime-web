import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React changes rarely: a separate chunk stays cached across app deploys.
        manualChunks: { react: ["react", "react-dom"] }
      }
    }
  },
  server: {
    port: 5173,
    host: true
  }
});
