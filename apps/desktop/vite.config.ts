import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    proxy: {
      // Lets the dev server stand in for `git-nav serve`, so a browser on another device gets
      // hot reloading and the API from a single origin.
      "/api": {
        target: process.env.GIT_NAV_SERVER ?? "http://127.0.0.1:4300",
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
