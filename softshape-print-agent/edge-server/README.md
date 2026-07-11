# SoftShape Edge Server

Local edge server that runs on the restaurant's billing PC. Handles the **hot path** — order creation, KOT printing, table management — with zero cloud dependency for sub-50ms response times.

## Architecture

```
Captain/Cashier App (LAN)  ──HTTP──→  Edge Server (localhost:3100)
                                          ├── SQLite (local DB)
                                          ├── Direct USB printing (Tauri)
                                          └── Background sync → Cloud Backend
```

## What It Does

- **Order creation**: Writes to local SQLite, prints KOT directly via Tauri, returns in <50ms
- **KOT printing**: ESC/POS bytes sent directly to USB printer — no socket relay, no Redis
- **Table management**: Reads from local SQLite — no network round-trip
- **Cloud sync**: Pushes orders/KOTs to cloud in background; pulls menu/setting changes every 60s
- **Offline resilient**: Restaurant operates normally even if internet goes down

## Requirements

- **Bun** runtime (includes built-in SQLite, HTTP server, fetch)
- **Tauri** print agent running alongside (for raw printer access)

## Setup (Development)

```bash
# 1. Install Bun if not already installed
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. Install dependencies
cd edge-server
bun install

# 3. Start the edge server
bun run dev
```

The server starts on `http://0.0.0.0:3100` (accessible from any device on the LAN).

## Setup (Production / Restaurant)

### Option A: Standalone executable

```bash
bun build --compile server.ts --outfile edge-server.exe
```

This produces a standalone `edge-server.exe` (~50MB) with Bun runtime + SQLite embedded. No Node.js installation needed on the restaurant PC.

### Option B: Tauri sidecar

Add to `tauri.conf.json`:
```json
{
  "tauri": {
    "bundle": {
      "externalBin": ["edge-server/edge-server.exe"]
    }
  }
}
```

The Tauri app launches `edge-server.exe` as a sidecar process on startup.

## API Endpoints

### Health & Status

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `GET` | `/api/edge/status` | Session + config sync status |

### Registration & Config

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/edge/register` | Register with cloud using setup token |
| `POST` | `/api/edge/config/sync` | Trigger full config re-download |
| `POST` | `/api/edge/config/pull` | Trigger incremental config pull |
| `POST` | `/api/edge/logout` | Clear session |

### Registration Example

```bash
curl -X POST http://localhost:3100/api/edge/register \
  -H "Content-Type: application/json" \
  -d '{
    "setupToken": "your-setup-token",
    "restaurantCode": "SS-001",
    "backendUrl": "https://api.softshape.ai"
  }'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_PORT` | `3100` | HTTP server port |
| `EDGE_DB_PATH` | `~/.softshape/edge.db` | SQLite database file path |

## Database

Uses Bun's built-in SQLite (`bun:sqlite`). Database file is created automatically at:
- Default: `~/.softshape/edge.db`
- Custom: Set `EDGE_DB_PATH` environment variable

### Tables (hot-path only)

- `outlet` — restaurant settings, branding, tax config
- `tax_profile` — GST/tax profiles
- `price_profile` + `price_profile_item` — price overrides
- `venue` — venue configuration (DINE_IN, parcel, bar, etc.)
- `floor` — floor layout
- `section` — sections within floors
- `table` — restaurant tables with live status
- `category` — menu categories
- `menu_item` — menu items with printer routing
- `menu_item_variant` — size/variant options
- `menu_item_addon` — add-on options
- `venue_price` — per-venue price overrides
- `venue_menu_item_availability` — per-venue availability
- `order_record` — orders (with `cloud_synced` flag)
- `order_item` — order line items
- `kot` — kitchen order tickets
- `kot_item` — KOT line items
- `daily_counter` — KOT/bill/transaction counters
- `sync_queue` — edge → cloud push queue
- `sync_state` — cloud → edge pull tracking
- `edge_config` — local settings (session, printer mapping)

## File Structure

```
edge-server/
├── server.ts     — HTTP server + route handlers (entry point)
├── db.ts         — SQLite schema + query helpers
├── auth.ts       — Session token management
├── config.ts     — Cloud config download + incremental sync
├── package.json  — Dependencies (socket.io-client only)
├── tsconfig.json — TypeScript config for Bun
└── README.md     — This file
```

## What's Next (Parts 2-7)

- **Part 2**: Order creation endpoint + ESC/POS builder + direct printing
- **Part 3**: Table/menu/section read endpoints
- **Part 4**: Edge → cloud sync worker
- **Part 5**: Cloud → edge incremental sync (full implementation)
- **Part 6**: Captain app edge detection + routing
- **Part 7**: Cloud backend sync receiver + config endpoints
