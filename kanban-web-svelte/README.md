# kanban-web-svelte

A Svelte-based Kanban web UI module that drives the embedded `kanban-orchestrator` runtime in `pi-kit`.

## Runtime dependency

Start the embedded runtime from pi first (inside your target repo session):

```text
/kanban-runtime-start --port 0
```

The command returns JSON with:

- `baseUrl` (for example `http://127.0.0.1:54321`)
- `token`

Use those values in the UI connection panel.

## Local development

```bash
cd kanban-web-svelte
npm install
npm run dev
```

Default dev URL: `http://localhost:4174`

## Build

```bash
npm run build
npm run preview
```

## Implemented UI flow

- Load board from `GET /kanban/board`
- Click card to open action dialog
- Execute action via `POST /kanban/actions/execute`
- Subscribe to `GET /kanban/stream` (SSE) for live state updates
- Read status panel and recent events for observability
