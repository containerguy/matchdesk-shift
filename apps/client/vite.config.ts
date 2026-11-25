import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative Pfade, damit der Build auch unter einem Unterpfad läuft (z. B. /game-servers/shift/)
  base: "./",
  server: {
    port: 5173,
    host: true,
    proxy: { "/ws": { target: "ws://localhost:3000", ws: true } }
  }
});
