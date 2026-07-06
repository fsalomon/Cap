import { resolve } from "node:path";
import { defineConfig } from "vite";

// Same constraint as vite.content.config.ts: manifest content scripts run as
// classic scripts, so this must stay a single self-contained IIFE with no ES
// module imports. Built as its own entry (rather than folded into
// content-bootstrap.js) so it stays independently reviewable/removable —
// it has nothing to do with the overlay UI bootstrap loads.
export default defineConfig({
	build: {
		emptyOutDir: false,
		outDir: "dist",
		rollupOptions: {
			input: resolve(__dirname, "src/content/step-logger.ts"),
			output: {
				format: "iife",
				entryFileNames: "assets/content-step-logger.js",
			},
		},
	},
});
