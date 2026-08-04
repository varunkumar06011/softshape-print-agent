// ─────────────────────────────────────────────────────────────────────────────
// drivers/pluginLoader.ts — External Plugin Loader (Phase 6)
// ─────────────────────────────────────────────────────────────────────────────
// Loads external driver modules from the drivers/plugins/ directory.
// A plugin is any .ts or .js file that exports a default class implementing
// the Driver interface.
//
// Plugin file structure:
//   drivers/plugins/
//     my-printer.ts    — export default class implements Driver
//     my-payment.ts    — export default class implements Driver
//
// The loader scans the directory on startup, dynamically imports each file,
// validates the exported class against the Driver interface, and registers
// it with the DeviceManager.
//
// Hot-reload: POST /api/edge/drivers/reload re-scans the directory and
// loads any new plugins without restarting the Runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { runtimeLog } from "../contract/logger.ts";
import type { Driver, DriverType } from "./types.ts";
import { deviceManager } from "./manager.ts";

const PLUGINS_DIR = join(import.meta.dir, "plugins");

const VALID_TYPES: DriverType[] = ["printer", "payment", "barcode", "scale", "display"];

interface LoadedPlugin {
  name: string;
  filePath: string;
  loadedAt: number;
}

const loadedPlugins: Map<string, LoadedPlugin> = new Map();

// ── Load all plugins from the plugins directory ──────────────────────────────

export async function loadPlugins(): Promise<{ loaded: number; errors: number }> {
  let loaded = 0;
  let errors = 0;

  if (!existsSync(PLUGINS_DIR)) {
    runtimeLog.info("Plugins directory does not exist — skipping plugin load", {
      dir: PLUGINS_DIR,
    });
    return { loaded: 0, errors: 0 };
  }

  let files: string[];
  try {
    files = readdirSync(PLUGINS_DIR).filter(
      (f) => extname(f) === ".ts" || extname(f) === ".js" || extname(f) === ".mjs",
    );
  } catch (err) {
    runtimeLog.error("Failed to read plugins directory", { error: String(err) });
    return { loaded: 0, errors: 1 };
  }

  for (const file of files) {
    const filePath = join(PLUGINS_DIR, file);
    try {
      const success = await loadSinglePlugin(filePath);
      if (success) {
        loaded++;
      } else {
        errors++;
      }
    } catch (err) {
      runtimeLog.error("Plugin load error", { file, error: String(err) });
      errors++;
    }
  }

  runtimeLog.info("Plugin loading complete", { loaded, errors, total: files.length });

  // Initialize newly loaded plugins
  for (const [name] of loadedPlugins) {
    const driver = deviceManager.getDriver(name);
    if (driver) {
      try {
        await driver.initialize();
        runtimeLog.info("Plugin initialized", { name, state: driver.health().state });
      } catch (err) {
        runtimeLog.error("Plugin initialization failed", { name, error: String(err) });
      }
    }
  }

  return { loaded, errors };
}

// ── Load a single plugin file ────────────────────────────────────────────────

async function loadSinglePlugin(filePath: string): Promise<boolean> {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;

    // Dynamic import — Bun supports importing .ts files directly
    const module = await import(`file://${filePath.replace(/\\/g, "/")}`);

    // The plugin must export a default class that implements Driver
    const DriverClass = module.default;
    if (!DriverClass || typeof DriverClass !== "function") {
      runtimeLog.warn("Plugin missing default export — skipping", { file: filePath });
      return false;
    }

    // Instantiate the driver
    const driver: Driver = new DriverClass();

    // Validate the driver implements the interface
    if (!validateDriver(driver, filePath)) {
      return false;
    }

    // Check for duplicate name — replace if already loaded
    if (loadedPlugins.has(driver.name)) {
      const existing = loadedPlugins.get(driver.name)!;
      runtimeLog.warn("Plugin already loaded — replacing", {
        name: driver.name,
        oldFile: existing.filePath,
        newFile: filePath,
      });
    }

    // Register with the DeviceManager
    deviceManager.register(driver);

    loadedPlugins.set(driver.name, {
      name: driver.name,
      filePath,
      loadedAt: Date.now(),
    });

    runtimeLog.info("Plugin loaded", {
      name: driver.name,
      type: driver.type,
      file: filePath,
    });

    return true;
  } catch (err) {
    runtimeLog.error("Failed to load plugin", { file: filePath, error: String(err) });
    return false;
  }
}

// ── Validate that an object satisfies the Driver interface ───────────────────

function validateDriver(obj: any, filePath: string): boolean {
  if (typeof obj.name !== "string" || !obj.name) {
    runtimeLog.warn("Plugin invalid: missing or invalid 'name' property", { file: filePath });
    return false;
  }

  if (typeof obj.type !== "string" || !VALID_TYPES.includes(obj.type)) {
    runtimeLog.warn("Plugin invalid: missing or invalid 'type' property", {
      file: filePath,
      type: obj.type,
      validTypes: VALID_TYPES,
    });
    return false;
  }

  if (typeof obj.initialize !== "function") {
    runtimeLog.warn("Plugin invalid: missing initialize() method", { file: filePath });
    return false;
  }

  if (typeof obj.health !== "function") {
    runtimeLog.warn("Plugin invalid: missing health() method", { file: filePath });
    return false;
  }

  if (typeof obj.shutdown !== "function") {
    runtimeLog.warn("Plugin invalid: missing shutdown() method", { file: filePath });
    return false;
  }

  return true;
}

// ── Reload all plugins (hot-reload) ──────────────────────────────────────────

export async function reloadPlugins(): Promise<{ loaded: number; errors: number; removed: number }> {
  // Shut down and unregister all currently loaded plugins
  let removed = 0;
  for (const [name, plugin] of loadedPlugins) {
    const driver = deviceManager.getDriver(name);
    if (driver) {
      try {
        await driver.shutdown();
      } catch (err) {
        runtimeLog.error("Plugin shutdown error during reload", { name, error: String(err) });
      }
      deviceManager.unregister(name);
    }
    loadedPlugins.delete(name);
    removed++;
  }

  // Reload all plugins from the directory
  const result = await loadPlugins();

  // Initialize newly loaded plugins so they don't stay OFFLINE
  for (const [name] of loadedPlugins) {
    const driver = deviceManager.getDriver(name);
    if (driver) {
      try {
        await driver.initialize();
        runtimeLog.info("Plugin initialized after reload", {
          name,
          state: driver.health().state,
        });
      } catch (err) {
        runtimeLog.error("Plugin initialization failed after reload", {
          name,
          error: String(err),
        });
      }
    }
  }

  return { ...result, removed };
}

// ── Get info about loaded plugins ────────────────────────────────────────────

export function getLoadedPlugins(): Array<{ name: string; filePath: string; loadedAt: number }> {
  return Array.from(loadedPlugins.values());
}

// ── Get the plugins directory path ───────────────────────────────────────────

export function getPluginsDir(): string {
  return PLUGINS_DIR;
}
