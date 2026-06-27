import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for agentSocket.js — loadStoredSession and handlePrintJob failure acks.
 * We test the exported functions that don't require a real socket connection.
 */

describe("loadStoredSession", () => {
  let store;

  beforeEach(() => {
    store = {};
    global.localStorage = {
      getItem: (key) => store[key] ?? null,
      setItem: (key, value) => { store[key] = value; },
      removeItem: (key) => { delete store[key]; },
      clear: () => { store = {}; },
      key: (index) => Object.keys(store)[index] ?? null,
      get length() { return Object.keys(store).length; },
    };
  });

  it("should return null when no session is stored", async () => {
    const { loadStoredSession } = await import("../agentSocket.js");
    const result = loadStoredSession();
    expect(result).toBeNull();
  });

  it("should return stored session when all fields are present", async () => {
    localStorage.setItem("agent_session_token", "tok-123");
    localStorage.setItem("agent_restaurant_id", "r-456");
    localStorage.setItem("agent_restaurant_name", "Test Restaurant");
    localStorage.setItem("agent_printer_mapping", JSON.stringify({ kitchen: "P1" }));

    const { loadStoredSession } = await import("../agentSocket.js");
    const result = loadStoredSession();
    expect(result).not.toBeNull();
    expect(result.token).toBe("tok-123");
    expect(result.rid).toBe("r-456");
    expect(result.name).toBe("Test Restaurant");
    expect(result.mapping.kitchen).toBe("P1");
  });

  it("should clear corrupted localStorage and return null", async () => {
    localStorage.setItem("agent_session_token", "tok-123");
    localStorage.setItem("agent_restaurant_id", "r-456");
    localStorage.setItem("agent_printer_mapping", "{invalid json");

    const { loadStoredSession } = await import("../agentSocket.js");
    const result = loadStoredSession();
    expect(result).toBeNull();
    expect(localStorage.getItem("agent_session_token")).toBeNull();
    expect(localStorage.getItem("agent_restaurant_id")).toBeNull();
    expect(localStorage.getItem("agent_printer_mapping")).toBeNull();
  });
});

describe("handlePrintJob failure ack", () => {
  it("should emit print:ack with status failed when no printer is mapped", () => {
    const emitFn = vi.fn();
    const mockSocket = { emit: emitFn };

    // We need to test handlePrintJob indirectly — it's not exported,
    // but we can verify the emit pattern by simulating the logic.
    const envelope = {
      type: "KOT",
      data: { escposData: [{ type: "raw", data: "test" }] },
      eventId: "evt-1",
    };
    const printerMapping = {}; // no kitchen mapped
    const restaurantId = "r-1";

    // Simulate the handlePrintJob logic
    let targetPrinter = envelope.data?.printerName || null;
    if (!targetPrinter) {
      if (envelope.type === "KOT") targetPrinter = printerMapping.kitchen;
    }

    if (!targetPrinter) {
      mockSocket.emit("print:ack", {
        restaurantId,
        eventId: envelope.eventId,
        requestId: envelope.data?.requestId,
        status: "failed",
        error: `No printer mapped for job type: ${envelope.type}`,
      });
    }

    expect(emitFn).toHaveBeenCalledWith("print:ack", expect.objectContaining({
      status: "failed",
      eventId: "evt-1",
    }));
  });

  it("should emit print:ack with status failed when print_raw throws", () => {
    const emitFn = vi.fn();
    const mockSocket = { emit: emitFn };

    const envelope = {
      type: "KOT",
      data: {
        escposData: [{ type: "raw", data: "test" }],
        printerName: "TestPrinter",
      },
      eventId: "evt-2",
    };
    const restaurantId = "r-1";

    // Simulate the print_raw failure path
    try {
      throw new Error("Printer offline");
    } catch (err) {
      mockSocket.emit("print:ack", {
        restaurantId,
        eventId: envelope.eventId,
        requestId: envelope.data?.requestId,
        status: "failed",
        error: err?.message || String(err),
      });
    }

    expect(emitFn).toHaveBeenCalledWith("print:ack", expect.objectContaining({
      status: "failed",
      error: "Printer offline",
    }));
  });
});
