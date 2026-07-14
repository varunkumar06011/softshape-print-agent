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

### Order Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/edge/order` | Create order + KOT (local DB + direct print) |
| `POST` | `/api/edge/order/update` | Add items to existing order + print new KOT |
| `POST` | `/api/edge/order/cancel` | Cancel KOT item (print cancel ticket) |
| `POST` | `/api/edge/kot/reprint` | Reprint KOT for an order |

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

- **Part 2**: Order creation endpoint + ESC/POS builder + direct printing ✅
- **Part 3**: Table/menu/section read endpoints ✅
- **Part 4**: Edge → cloud sync worker ✅
- **Part 5**: Cloud → edge incremental sync (full implementation) ✅
- **Part 6**: Captain app edge detection + routing ✅
- **Part 7**: Cloud backend sync receiver + config endpoints ✅

## Planned: Local Bill & Settlement Endpoints

The following endpoints are **not yet implemented** on the edge server. They are scoped for a future milestone to enable full offline bill generation and settlement without cloud round-trips.

### Planned Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/edge/order/print-bill` | Generate bill locally (calculate totals, GST, discounts), print directly, assign local bill number |
| `POST` | `/api/edge/order/settle` | Settle order locally (mark PAID, free table, create local transaction record), enqueue cloud sync |
| `POST` | `/api/edge/order/reprint-bill` | Reprint existing bill from local DB (reuse bill number, recalculate with current discount) |

### Implementation Scope

1. **`/api/edge/order/print-bill`**
   - Input: `orderId`, `discountPercent`, `restaurantId`
   - Logic:
     - Fetch order + items from local SQLite
     - Calculate totals (subtotal, GST, discount, service charge) using outlet settings
     - Generate next bill number from `daily_counter`
     - Build ESC/POS bill bytes via `buildFinalBill()` from `escpos.ts`
     - Print directly via Tauri USB
     - Update `order_record.status` → `BILLING_REQUESTED`, store `bill_number`
     - Update table status → `Waiting Bill`
     - Enqueue sync: `order` (update), `table` (update)
   - Returns: `{ success, billNumber, order, printResults }`

2. **`/api/edge/order/settle`**
   - Input: `orderId`, `paymentMethod`, `tipAmount`, `cashAmount`, `cardAmount`
   - Logic:
     - Fetch order from local SQLite, verify status is `BILLING_REQUESTED`
     - Create local transaction record in `order_record` (or a new `transaction` table)
     - Mark order as `PAID`, set `settled_at`
     - Reset table: status → `AVAILABLE`, clear `current_bill`, `kot_history`, `active_order`
     - Generate settlement ESC/POS receipt and print
     - Enqueue sync: `order` (update), `table` (update), `transaction` (insert)
   - Returns: `{ success, transactionId, order, table, printResults }`

3. **`/api/edge/order/reprint-bill`**
   - Input: `orderId`, `discountPercent` (optional, defaults to stored value)
   - Logic:
     - Fetch order + items + existing bill number from local SQLite
     - Recalculate bill with current discount
     - Build ESC/POS bill bytes, print directly
     - No status change (bill already exists)
   - Returns: `{ success, billNumber, printResults }`

### Schema Changes Required

- Add `bill_number` column to `order_record` (TEXT, nullable)
- Add `settled_at` column to `order_record` (INTEGER, nullable)
- Add `payment_method`, `tip_amount`, `cash_amount`, `card_amount` columns to `order_record`
- Consider a `transaction` table for local settlement records (mirrors cloud `Transaction` model)
- Add `bill_number` to `daily_counter` sequence (alongside `kot_number`)

### Cloud Reconciliation

- When sync worker pushes a locally-settled order to cloud, the cloud backend should:
  1. Verify the order exists and is not already settled
  2. Create a cloud `Transaction` record with the local bill number
  3. Mark the cloud order as `PAID`
  4. If bill number conflicts (cloud already assigned a different number), log a warning and keep the local number
- The sync worker should push `transaction` records with `cloud_synced = 0` first, then `order` updates
- If cloud settlement already happened (e.g., another device settled online), the edge server should accept the cloud's bill number and update local DB on next config pull
