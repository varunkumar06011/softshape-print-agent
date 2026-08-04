<div align="center">

<img src="https://img.shields.io/badge/SoftShape-Print_Agent-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiPjxyZWN0IHg9IjMiIHk9IjQiIHdpZHRoPSIxOCIgaGVpZ2h0PSIxNSIgcng9IjIiLz48cGF0aCBkPSJNMTggOWg0djNoLTR6Ii8+PC9zdmc+" alt="SoftShape Print Agent" />

# 🖨️ SoftShape Print Agent

**The Windows tray app that replaces QZ Tray — silent ESC/POS printing without Java, browser certificates, or print dialogs.**

[![Version](https://img.shields.io/badge/version-5.1.0-6366f1)](./package.json)
[![Tauri](https://img.shields.io/badge/Tauri-1-24C8D8?logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.70+-000000?logo=rust)](https://rust-lang.org)
[![Windows](https://img.shields.io/badge/Windows-10+-0078D6?logo=windows)](https://microsoft.com)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite)](https://vitejs.dev)
[![License](https://img.shields.io/badge/license-ISC-22c55e)](./package.json)

</div>

---

## 🚀 What is SoftShape Print Agent?

The **SoftShape Print Agent** is a lightweight **Windows desktop app** that turns any Windows PC connected to thermal printers into a silent print server for the SoftShape POS.

It listens to the SoftShape backend over **Socket.IO** and prints **KOTs, bills, and bar receipts** instantly by sending raw **ESC/POS** bytes straight to the printer. No browser print dialog. No Java runtime. No manual clicks.

If you are looking for a **QZ Tray alternative**, **silent ESC/POS thermal printing for Windows**, or a **restaurant print agent** that just works, this is it.

---

## ⚙️ How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                  SoftShape Print Agent                     │
│  Tauri window (Vite UI) + Rust core + Win32 printing API    │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Socket.IO
                              ▼
                   ┌─────────────────────┐
                   │  SoftShape Backend  │
                   │  emits print_job    │
                   └─────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │   USB printer│    │ Network printer│   │ Fallback printer│
    │  ESC/POS raw │    │  TCP/IP 9100  │    │  retry queue   │
    └─────────────┘    └─────────────┘    └─────────────┘
```

### One-time setup flow

1. Owner installs the Print Agent on the Windows PC connected to the printers.
2. From **Admin → Printers**, the owner generates a 15-minute setup token.
3. In the Print Agent, the owner enters the **restaurant code** and **setup token**.
4. The app calls `/api/print/agent-register` and receives a 30-day session token.
5. The app maps **kitchen, bar, and bill printers** to their Windows names or network IPs.
6. From now on, every `print_job` event from the backend prints automatically.

### Real-time print events

| Event | Direction | Purpose |
|---|---|---|
| `agent:join` | App → Backend | Join the restaurant's print room |
| `print_job` | Backend → App | Receive a print job with ESC/POS data |
| `print:ack` | App → Backend | Acknowledge that a job was printed |
| `agent:joined` | Backend → App | Confirm room join + buffered job count |

---

## ✨ Key Features

- **🖨️ Silent ESC/POS printing** — No Windows print dialog, no browser popup, no Java.
- **🔌 USB & network printers** — Print via Windows printer name or raw TCP to IP:9100.
- **📡 Socket.IO real-time** — Jobs arrive instantly from the backend and are acknowledged back.
- **🔐 Secure registration** — Time-bound setup tokens and 30-day session tokens with automatic reconnection.
- **🧠 Smart retries** — Network errors and 5xx are retried with exponential backoff; 4xx errors are surfaced immediately.
- **🗺️ Per-station printer mapping** — Map kitchen, bar, and bill printers independently.
- **📦 Buffered jobs** — If the agent is offline, the backend queues jobs and replays them on reconnect.
- **⚙️ Auto-updater ready** — Tauri updater support for Windows `.exe` and `.msi` releases.

---

## 🐛 Bugs We Faced & Hardening We Added

Printing in a live restaurant is unforgiving. These are the war stories we solved:

- **Build-time backend URL trap** — `VITE_BACKEND_URL` is baked into the bundle at build time. Early releases accidentally pointed at the wrong backend because the env var was missing or stale. We now throw a clear error at startup if the URL is not set and document it in every CI workflow.
- **Retry storms on bad tokens** — A wrong setup token caused the agent to retry forever. We split retry logic so **4xx client errors fail fast** while **5xx / network / timeout errors retry with exponential backoff**.
- **Silent registration failures** — Network errors were swallowed in the UI. We added explicit failure categories: `timeout`, `network`, `client`, `server`, plus the exact backend URL and a **Retry** button.
- **Tauri API shape differences** — Between Tauri v1 setups, `window.__TAURI__.invoke` and `window.__TAURI__.tauri.invoke` both exist. We wrote a resolver that binds whichever is available so the same build works across environments.
- **Printer name mismatch** — Windows printer names are case-sensitive and can contain spaces. We validate names against the live `list_printers()` result before every print job and fall back to a default queue if the mapped printer disappears.
- **Lost print jobs on reconnect** — If the agent disconnects during a lunch rush, jobs could be lost. We added the `print:ack` handshake so the backend buffers unacknowledged jobs and replays them after `agent:joined`.
- **Mixed-content in embedded webview** — The Tauri webview blocks insecure content. We ensure the agent only talks to the configured HTTPS backend and use the standalone `server.js` for local Cashier desktop integration where needed.

---

## 🎯 Our Vision

> We want every restaurant to have **plug-and-play thermal printing** that works on any Windows PC, in any kitchen, without calling a technician or installing Java.

The Print Agent is designed to be invisible: install it once, map the printers, and never think about it again. It should print the first KOT and the ten-thousandth KOT with equal speed and zero drama.

---

## 🛠️ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create environment file
cp .env.example .env
# Edit .env and set VITE_BACKEND_URL to your SoftShape backend

# 3. Run in dev mode (Tauri window + Vite dev server)
npm run tauri dev

# 4. Build the Windows installer (.exe / .msi)
npm run tauri build
```

### Environment

```env
# Required at build time — the agent bakes this URL into the bundle
VITE_BACKEND_URL=https://your-softshape-backend.com
```

Changing the backend URL requires a rebuild. The app will throw a clear error if this variable is missing.

---

## 🧰 Tauri Rust Commands

| Command | Purpose |
|---|---|
| `list_printers()` | Returns all installed Windows printers |
| `print_raw(printerName, bytes)` | Send raw ESC/POS bytes to a named USB printer |
| `print_network(ip, port, bytes)` | Send raw ESC/POS bytes to a network printer via TCP |

---

## 📁 Project Structure

```
softshape-print-agent/
├── package.json          # Node dependencies (Vite + socket.io-client)
├── vite.config.js        # Vite dev server config
├── .env.example          # Required build-time environment variables
├── src/                  # Web frontend (HTML/JS/CSS)
│   ├── index.html        # Main UI
│   ├── main.js           # Frontend entry point
│   ├── agentSocket.js    # Socket.IO communication + retry logic
│   └── styles.css        # App styling
└── src-tauri/            # Rust + Tauri core
    ├── Cargo.toml        # Rust dependencies
    ├── tauri.conf.json   # Tauri window, bundle, and updater config
    ├── build.rs          # Tauri build script
    └── src/
        ├── main.rs         # Tauri command handlers
        └── windows_printing.rs  # Win32 raw printing implementation
```

---

## 🔍 SEO Notes

The SoftShape Print Agent is built for searches like **QZ Tray alternative**, **ESC/POS thermal printer Windows**, **silent receipt printer software**, **restaurant print agent**, **raw printer driver for POS**, and **Windows thermal printer integration**.

It is a practical, no-Java replacement for browser-based POS printing on Windows.

---

## 📄 License

[ISC](./package.json) — SoftShape AI.
