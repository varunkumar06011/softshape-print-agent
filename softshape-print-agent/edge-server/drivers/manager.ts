// ─────────────────────────────────────────────────────────────────────────────
// drivers/manager.ts — Device Manager (v1)
// ─────────────────────────────────────────────────────────────────────────────
// Loads, initializes, and supervises all drivers.
// Polls health() on each driver for the /health endpoint.
// Emits device.state_changed events when a driver transitions states.
//
// Phase 0: skeleton with driver registration and health aggregation.
// Phase 2+: printer driver gets real implementation (delegates to print service).
// Phase 6: external plugin loading.
// ─────────────────────────────────────────────────────────────────────────────

import type { Driver, DriverHealth, DriverType } from "./types.ts";
import type { DeviceHealth } from "../contract/types.ts";
import type { DriverState } from "../contract/states.ts";
import { runtimeLog } from "../contract/logger.ts";

interface DriverRegistration {
  driver: Driver;
  lastState: DriverState;
}

export class DeviceManager {
  private drivers: Map<string, DriverRegistration> = new Map();
  private initialized = false;

  // ── Register a driver ──────────────────────────────────────────────────────

  register(driver: Driver): void {
    if (this.drivers.has(driver.name)) {
      runtimeLog.warn("Driver already registered, replacing", { name: driver.name });
    }
    this.drivers.set(driver.name, {
      driver,
      lastState: "OFFLINE",
    });
    runtimeLog.info("Driver registered", { name: driver.name, type: driver.type });
  }

  // ── Initialize all registered drivers ──────────────────────────────────────

  async initializeAll(): Promise<void> {
    const entries = Array.from(this.drivers.values());
    for (const entry of entries) {
      try {
        await entry.driver.initialize();
        const health = entry.driver.health();
        entry.lastState = health.state;
        runtimeLog.info("Driver initialized", {
          name: entry.driver.name,
          state: health.state,
        });
      } catch (err) {
        runtimeLog.error("Driver initialization failed", {
          name: entry.driver.name,
          error: String(err),
        });
      }
    }
    this.initialized = true;
  }

  // ── Shutdown all drivers ───────────────────────────────────────────────────

  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.drivers.values());
    for (const entry of entries) {
      try {
        await entry.driver.shutdown();
        runtimeLog.info("Driver shut down", { name: entry.driver.name });
      } catch (err) {
        runtimeLog.error("Driver shutdown failed", {
          name: entry.driver.name,
          error: String(err),
        });
      }
    }
    this.initialized = false;
  }

  // ── Get health for all drivers (for /health endpoint) ──────────────────────

  getDeviceHealths(): DeviceHealth[] {
    const result: DeviceHealth[] = [];
    for (const [name, entry] of this.drivers) {
      const health = entry.driver.health();
      result.push({
        name,
        type: entry.driver.type as unknown as DriverType,
        state: health.state,
        lastError: health.lastError,
        lastCheckedAt: health.lastCheckedAt,
        details: health.details,
      });
    }
    return result;
  }

  // ── Unregister a driver (used by plugin hot-reload) ─────────────────────────

  unregister(name: string): boolean {
    if (this.drivers.has(name)) {
      this.drivers.delete(name);
      runtimeLog.info("Driver unregistered", { name });
      return true;
    }
    return false;
  }

  // ── Get a specific driver by name ──────────────────────────────────────────

  getDriver(name: string): Driver | null {
    return this.drivers.get(name)?.driver ?? null;
  }

  // ── Get all drivers of a specific type ─────────────────────────────────────

  getDriversByType(type: DriverType): Driver[] {
    return Array.from(this.drivers.values())
      .filter((e) => e.driver.type === type)
      .map((e) => e.driver);
  }

  // ── Check for state transitions and log them ───────────────────────────────
  // Called periodically by the Runtime. Returns transitions that occurred.

  checkTransitions(): Array<{ name: string; type: string; oldState: DriverState; newState: DriverState; reason: string }> {
    const transitions: Array<{ name: string; type: string; oldState: DriverState; newState: DriverState; reason: string }> = [];
    for (const [name, entry] of this.drivers) {
      const health = entry.driver.health();
      if (health.state !== entry.lastState) {
        const transition = {
          name,
          type: entry.driver.type,
          oldState: entry.lastState,
          newState: health.state,
          reason: health.lastError ?? "normal transition",
        };
        transitions.push(transition);
        entry.lastState = health.state;
        runtimeLog.info("Driver state changed", transition);
      }
    }
    return transitions;
  }

  // ── Is the manager initialized? ────────────────────────────────────────────

  isInitialized(): boolean {
    return this.initialized;
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

export const deviceManager = new DeviceManager();
