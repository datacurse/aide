import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { daemonControl } from "./vite-daemon.js"

const PORT = Number(process.env["AIDE_PORT"] ?? 4317)
const DAEMON = `http://127.0.0.1:${PORT}`

export default defineConfig({
  // The daemon is started and stopped by the dev server, not by a sibling
  // `pnpm -r --parallel` process. Two owners would race for the port, and a
  // process nobody owns cannot be restarted from the UI.
  plugins: [react(), tailwindcss(), daemonControl(PORT)],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: DAEMON,
        changeOrigin: true,
        // A daemon that is down is a normal state here, not an incident. Left
        // alone this logs a stack trace per request and hands the browser an
        // HTML error page, so a JSON 503 the client can actually read is both
        // quieter and more useful.
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            const out = res as { headersSent?: boolean; writeHead?: Function; end?: Function; destroy?: Function }
            if (typeof out.writeHead === "function" && !out.headersSent) {
              out.writeHead(503, { "content-type": "application/json" })
              out.end?.(JSON.stringify({ message: `daemon is not running on ${PORT}` }))
            } else {
              out.destroy?.()
            }
          })
        },
      },
      "/ws": {
        target: DAEMON,
        ws: true,
        changeOrigin: true,
        // Websocket upgrades fail the same way; the hook keeps the reconnect
        // loop in useRunStream from being drowned in proxy stack traces.
        configure: (proxy) => {
          proxy.on("error", (_err, _req, res) => {
            ;(res as { destroy?: Function }).destroy?.()
          })
        },
      },
    },
  },
})
