import { describe, it, expect, beforeEach, vi } from "vitest";

function mockLocalStorage() {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    key: (index) => Object.keys(store)[index] ?? null,
    get length() { return Object.keys(store).length; },
  };
}

function createMockSocket() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    disconnect: vi.fn(),
  };
}

/**
 * Tests for agentSocket.js — loadStoredSession, fetchWithRetry, health check,
 * registration, and real handlePrintJob failure acks.
 */

describe("loadStoredSession", () => {
  beforeEach(() => {
    global.localStorage = mockLocalStorage();
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

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    global.fetch = vi.fn();
    global.localStorage = mockLocalStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the response on first success", async () => {
    const { fetchWithRetry } = await import("../agentSocket.js");
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await fetchWithRetry("http://localhost:3000/api/test", { method: "POST" });

    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on network failure and succeeds", async () => {
    const { fetchWithRetry } = await import("../agentSocket.js");
    global.fetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const promise = fetchWithRetry("http://localhost:3000/api/test");
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx errors", async () => {
    const { fetchWithRetry } = await import("../agentSocket.js");
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: "Bad token" }),
    });

    await expect(fetchWithRetry("http://localhost:3000/api/test")).rejects.toThrow("Bad token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx errors up to the configured attempts", async () => {
    const { fetchWithRetry, FetchError } = await import("../agentSocket.js");
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    });

    let caughtErr;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const promise = fetchWithRetry(
      "http://localhost:3000/api/test",
      {},
      { retries: 2 },
    ).catch((e) => {
      caughtErr = e;
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(caughtErr).toBeInstanceOf(FetchError);
    expect(caughtErr.type).toBe("server");
    expect(caughtErr.statusCode).toBe(503);
    expect(caughtErr.message).toBe("HTTP 503: Service Unavailable");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("classifies timeouts as FetchError type 'timeout'", async () => {
    const { fetchWithRetry, FetchError } = await import("../agentSocket.js");
    const abortError = new Error("timeout");
    abortError.name = "AbortError";
    global.fetch.mockRejectedValueOnce(abortError);

    const err = await fetchWithRetry(
      "http://localhost:3000/api/test",
      {},
      { retries: 1, timeoutMs: 100 },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(FetchError);
    expect(err.type).toBe("timeout");
  });
});

describe("checkBackendHealth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    global.fetch = vi.fn();
    global.localStorage = mockLocalStorage();
  });

  it("returns ok when /api/health responds 200", async () => {
    const { checkBackendHealth } = await import("../agentSocket.js");
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await checkBackendHealth();
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws a timeout FetchError when the request aborts", async () => {
    const { checkBackendHealth, FetchError } = await import("../agentSocket.js");
    const abortError = new Error("timeout");
    abortError.name = "AbortError";
    global.fetch.mockRejectedValueOnce(abortError);

    const err = await checkBackendHealth(100).catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.type).toBe("timeout");
  });
});

describe("registerAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    global.fetch = vi.fn();
    global.localStorage = mockLocalStorage();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends restaurantCode and returns registration data", async () => {
    const { registerAgent } = await import("../agentSocket.js");
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        sessionToken: "sess-123",
        restaurantId: "rid-456",
        restaurantName: "Test Restaurant",
        missedJobs: [],
      }),
    });

    const data = await registerAgent({
      setupToken: "token-abc",
      agentId: "agent-1",
      restaurantCode: "N6XMQI",
      printerMapping: {},
    });

    expect(data.sessionToken).toBe("sess-123");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/print/agent-register",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer token-abc",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: "agent-1",
          printerMapping: {},
          restaurantCode: "N6XMQI",
        }),
      }),
    );
  });

  it("reports backend error messages", async () => {
    const { registerAgent } = await import("../agentSocket.js");
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "Restaurant code does not match the setup token" }),
    });

    await expect(
      registerAgent({ setupToken: "token-abc", agentId: "agent-1", restaurantCode: "WRONG" }),
    ).rejects.toThrow("Restaurant code does not match the setup token");
  });

  it("calls onAttempt for each retry attempt", async () => {
    const { registerAgent } = await import("../agentSocket.js");
    global.fetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sessionToken: "sess-123", restaurantId: "rid-456", missedJobs: [] }),
      });

    const onAttempt = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const promise = registerAgent({
      setupToken: "token-abc",
      agentId: "agent-1",
      onAttempt,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(onAttempt).toHaveBeenCalledWith(1, 3);
    expect(onAttempt).toHaveBeenCalledWith(2, 3);
  });
});

describe("handlePrintJob failure acks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    global.fetch = vi.fn();
    global.localStorage = mockLocalStorage();
  });

  it("emits print:ack failed when no printer is mapped", async () => {
    const mockSocket = createMockSocket();
    vi.doMock("socket.io-client", () => ({ io: () => mockSocket }));

    const { handlePrintJob, connectAgent } = await import("../agentSocket.js");
    connectAgent({
      token: "tok",
      rid: "r-1",
      mapping: {},
      onStatusChange: () => {},
      onPrintJob: () => {},
    });

    const envelope = {
      type: "KOT",
      data: { escposData: [{ type: "raw", data: "test" }] },
      eventId: "evt-1",
    };

    await handlePrintJob(envelope);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "print:ack",
      expect.objectContaining({
        status: "failed",
        error: "No printer mapped for job type: KOT",
      }),
    );
  });

  it("emits print:ack failed when no ESC/POS data is present", async () => {
    const mockSocket = createMockSocket();
    vi.doMock("socket.io-client", () => ({ io: () => mockSocket }));

    const { handlePrintJob, connectAgent } = await import("../agentSocket.js");
    connectAgent({
      token: "tok",
      rid: "r-1",
      mapping: { kitchen: "KitchenPrinter" },
      onStatusChange: () => {},
      onPrintJob: () => {},
    });

    const envelope = {
      type: "KOT",
      data: {},
      eventId: "evt-2",
    };

    await handlePrintJob(envelope);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "print:ack",
      expect.objectContaining({
        status: "failed",
        error: "No ESC/POS data in job: KOT",
      }),
    );
  });
});
