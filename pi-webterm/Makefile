.PHONY: dev build install test clean

# ─── Development ────────────────────────────────────────────────

dev: install
	@echo "Starting Pi WebTerm in dev mode..."
	@echo "Open http://localhost:4730 in your browser."
	@cd server && npx tsx watch src/index.ts

# ─── Build ──────────────────────────────────────────────────────

build: install-ui
	@echo "Building UI..."
	@cd ui && npx vite build
	@echo "UI built to ui/dist/"

# ─── Install ────────────────────────────────────────────────────

install: install-server install-ui

install-server:
	@echo "Installing server dependencies..."
	@cd server && npm install

install-ui:
	@echo "Installing UI dependencies..."
	@cd ui && npm install

# ─── Test ───────────────────────────────────────────────────────

test: install-server
	@cd server && npx vitest run

test-watch: install-server
	@cd server && npx vitest

# ─── Clean ──────────────────────────────────────────────────────

clean:
	@rm -rf ui/dist
	@rm -rf server/dist
	@echo "Cleaned build artifacts"

# ─── Production (build + start) ─────────────────────────────────

run: build
	@echo "\n  🔗 Pi WebTerm starting..."
	@echo "  📱 Open in mobile browser: http://<your-ip>:4730\n"
	@cd server && npx tsx src/index.ts

# ─── Type Check ─────────────────────────────────────────────────

typecheck: install-server
	@cd server && npx tsc --noEmit
	@echo "Type check passed"
