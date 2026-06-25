# SoftShape Print Agent

Windows tray application for silent thermal printer management.
Replaces QZ Tray — no Java, no browser certificates, no print dialogs.

## How it works

1. Owner installs this app on the Windows PC connected to the printers.
2. App connects to the SoftShape backend via Socket.IO.
3. When a captain sends a KOT or cashier prints a bill, the backend emits a `print_job` event.
4. This app receives the event and sends raw ESC/POS bytes directly to the mapped printer.
5. Printer prints instantly — no dialog, no clicks.

## Setup (Development)

```bash
# Install dependencies
npm install

# Run in dev mode (opens Tauri window + Vite dev server)
npm run tauri dev

# Build the Windows installer (.exe / .msi)
npm run tauri build
```

### Environment

Create a `.env` file in the project root:

```
VITE_BACKEND_URL=https://softshape-backend.onrender.com
```

## Authentication Flow

1. Owner opens Admin Dashboard → Printers tab
2. Clicks **Generate Setup Token** (valid 15 minutes)
3. Opens the Print Agent app on the printer PC
4. Enters the setup token
5. App calls `/api/print/agent-register` → receives a 30-day session token
6. App stores the token and auto-connects on future starts

## Printer Support

- **USB**: via Windows printer name (appears in Windows Devices & Printers)
- **Network/WiFi**: via raw TCP to IP:9100 (use the `print_network` Tauri command)

## Communication with Backend

| Event | Direction | Purpose |
|---|---|---|
| `agent:join` | App → Backend | Join the restaurant's print room |
| `print_job` | Backend → App | Receive a print job with ESC/POS data |
| `print:ack` | App → Backend | Acknowledge job was printed |
| `agent:joined` | Backend → App | Confirm room join + buffered job count |

## Tauri Rust Commands

- `list_printers()` — Returns all installed Windows printers
- `print_raw(printerName, bytes)` — Send raw bytes to a named USB printer
- `print_network(ip, port, bytes)` — Send raw bytes to a network printer via TCP

## Project Structure

```
softshape-print-agent/
├── package.json          # Node dependencies (Vite + socket.io-client)
├── vite.config.js        # Vite dev server config
├── src/                  # Web frontend (HTML/JS/CSS)
│   ├── index.html        # Main UI
│   ├── main.js           # Frontend entry point
│   ├── agentSocket.js    # Socket.IO communication layer
│   └── styles.css        # App styling
└── src-tauri/            # Rust backend
    ├── Cargo.toml        # Rust dependencies
    ├── tauri.conf.json   # Tauri config (window, bundle, etc.)
    ├── build.rs          # Tauri build script
    └── src/
        ├── main.rs       # Tauri commands (list_printers, print_raw, print_network)
        └── windows_printing.rs  # Win32 raw printing implementation
```
