// ─────────────────────────────────────────────────────────────────────────────
// contract/lanAuth.ts — LAN authentication perimeter (Runtime v2)
// ─────────────────────────────────────────────────────────────────────────────
// FROZEN CONTRACT — the Runtime binds to 0.0.0.0 so every device on the
// restaurant LAN can reach it. "On the LAN" is therefore NOT an authorization
// decision. Every Runtime v2 route must be classified here, exactly once:
//
//   PUBLIC        — non-mutating liveness/discovery only. Must not return
//                   configuration, business data, or secrets. Adding an entry
//                   requires a written justification in the route spec.
//   RUNTIME_TOKEN — device-level Bearer token (per billing PC). The default for
//                   reads and for operational commands.
//   STAFF_TOKEN   — user-bound token from offline PIN login, with role and
//                   optional permission checks. Required for anything
//                   financially or administratively sensitive.
//
// Rules:
//   - Every mutating command route is authenticated. There are no public writes.
//   - A route with no classification is DENIED, not allowed. `classifyRoute`
//     returns null and the caller must reject.
//   - This module is declarative only: it holds no request state and performs
//     no I/O, so it can be unit-tested and audited on its own.
// ─────────────────────────────────────────────────────────────────────────────

export type RouteAuthClass = "PUBLIC" | "RUNTIME_TOKEN" | "STAFF_TOKEN";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteAuthSpec {
  // Exact path or path prefix (prefix entries end with "/").
  path: string;
  methods: HttpMethod[];
  authClass: RouteAuthClass;
  // Minimum role, checked against the staff token when authClass is STAFF_TOKEN.
  minRole?: "CAPTAIN" | "CASHIER" | "MANAGER" | "ADMIN" | "OWNER";
  // Permission key that must be truthy in the staff token permissions JSON.
  permission?: string;
  // Mutating routes are held to the stricter review bar and are never PUBLIC.
  mutating: boolean;
  // Required for PUBLIC entries: why exposing this without auth is safe.
  publicJustification?: string;
}

// ── Runtime v2 route table ───────────────────────────────────────────────────
// Base path for the v2 surface. Keeping it distinct from /api/edge/* lets v1 and
// v2 coexist during migration without ambiguous routing.

export const RUNTIME_V2_BASE = "/runtime/v2";

export const RUNTIME_V2_ROUTES: RouteAuthSpec[] = [
  // ── Liveness / discovery ───────────────────────────────────────────────────
  {
    path: `${RUNTIME_V2_BASE}/ping`,
    methods: ["GET"],
    authClass: "PUBLIC",
    mutating: false,
    publicJustification:
      "Liveness probe for LAN discovery and read-only/degraded detection. Returns only " +
      "{ ok, runtimeState, apiVersion } — no tenant data, configuration, or secrets. " +
      "Clients must be able to detect an unavailable Runtime before they hold any token.",
  },

  // ── Status / health ────────────────────────────────────────────────────────
  {
    path: `${RUNTIME_V2_BASE}/status`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
  {
    path: `${RUNTIME_V2_BASE}/health`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
  {
    path: `${RUNTIME_V2_BASE}/metrics`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },

  // ── Commands (operational writes) ──────────────────────────────────────────
  // A single command endpoint. Per-command role/permission requirements are
  // enforced by the command registry, because the command name is in the body.
  {
    path: `${RUNTIME_V2_BASE}/commands`,
    methods: ["POST"],
    authClass: "RUNTIME_TOKEN",
    mutating: true,
  },

  // ── Queries (projection reads) ─────────────────────────────────────────────
  {
    path: `${RUNTIME_V2_BASE}/queries/`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },

  // ── Dead Letter Queue (operator surface) ───────────────────────────────────
  {
    path: `${RUNTIME_V2_BASE}/dlq`,
    methods: ["GET"],
    authClass: "STAFF_TOKEN",
    minRole: "MANAGER",
    mutating: false,
  },
  {
    path: `${RUNTIME_V2_BASE}/dlq/resolve`,
    methods: ["POST"],
    authClass: "STAFF_TOKEN",
    minRole: "ADMIN",
    mutating: true,
  },
  {
    path: `${RUNTIME_V2_BASE}/dlq/replay`,
    methods: ["POST"],
    authClass: "STAFF_TOKEN",
    minRole: "ADMIN",
    mutating: true,
  },

  // ── Maintenance (destructive / diagnostic) ─────────────────────────────────
  {
    path: `${RUNTIME_V2_BASE}/projections/rebuild`,
    methods: ["POST"],
    authClass: "STAFF_TOKEN",
    minRole: "ADMIN",
    mutating: true,
  },

  // ── Shadow Comparison (M2.5 diagnostics) ───────────────────────────────────
  // Temporary: remove after V1 cutover.
  {
    path: `${RUNTIME_V2_BASE}/shadow/log`,
    methods: ["POST"],
    authClass: "RUNTIME_TOKEN",
    mutating: true,
  },
  {
    path: `${RUNTIME_V2_BASE}/shadow/stats`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
  {
    path: `${RUNTIME_V2_BASE}/shadow/mismatches`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
  // ── M2.6A: Release Status & Export ──────────────────────────────────────────
  {
    path: `${RUNTIME_V2_BASE}/release-status`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
  {
    path: `${RUNTIME_V2_BASE}/shadow/export`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
  // Per-session export: /runtime/v2/shadow/export/:sessionId
  // Uses prefix match — classifyRoute checks startsWith for paths ending with "/".
  {
    path: `${RUNTIME_V2_BASE}/shadow/export/`,
    methods: ["GET"],
    authClass: "RUNTIME_TOKEN",
    mutating: false,
  },
];

// ── Role hierarchy ───────────────────────────────────────────────────────────
// Mirrors the hierarchy already used by verifyEdgeRole in server.ts.

export const LAN_ROLE_HIERARCHY: Record<string, number> = {
  CAPTAIN: 1,
  CASHIER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

export function roleMeetsMinimum(role: string | null | undefined, minRole: string): boolean {
  const actual = LAN_ROLE_HIERARCHY[(role || "").toUpperCase()] ?? 0;
  const required = LAN_ROLE_HIERARCHY[minRole.toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
  return actual >= required;
}

// ── Classification ───────────────────────────────────────────────────────────
// Returns null when the route is not declared. Callers MUST treat null as deny.

export function classifyRoute(pathname: string, method: string): RouteAuthSpec | null {
  const upperMethod = method.toUpperCase() as HttpMethod;

  for (const spec of RUNTIME_V2_ROUTES) {
    const matches = spec.path.endsWith("/")
      ? pathname.startsWith(spec.path)
      : pathname === spec.path;
    if (matches && spec.methods.includes(upperMethod)) return spec;
  }
  return null;
}

export function isRuntimeV2Path(pathname: string): boolean {
  return pathname === RUNTIME_V2_BASE || pathname.startsWith(`${RUNTIME_V2_BASE}/`);
}

// ── Self-audit ───────────────────────────────────────────────────────────────
// Invariants that must hold for the route table itself. Exposed so a test can
// assert them, and so a future route addition cannot quietly weaken the
// perimeter: no public writes, and every public route carries a justification.

export interface RouteTableViolation {
  path: string;
  problem: string;
}

export function auditRouteTable(routes: RouteAuthSpec[] = RUNTIME_V2_ROUTES): RouteTableViolation[] {
  const violations: RouteTableViolation[] = [];
  const seen = new Map<string, Set<HttpMethod>>();

  for (const spec of routes) {
    if (spec.mutating && spec.authClass === "PUBLIC") {
      violations.push({ path: spec.path, problem: "mutating route cannot be PUBLIC" });
    }

    if (spec.authClass === "PUBLIC" && !spec.publicJustification) {
      violations.push({ path: spec.path, problem: "PUBLIC route requires publicJustification" });
    }

    if (spec.authClass !== "STAFF_TOKEN" && (spec.minRole || spec.permission)) {
      violations.push({
        path: spec.path,
        problem: "minRole/permission only apply to STAFF_TOKEN routes",
      });
    }

    if (spec.methods.length === 0) {
      violations.push({ path: spec.path, problem: "route declares no methods" });
    }

    const mutatingMethods: HttpMethod[] = ["POST", "PATCH", "DELETE"];
    const hasMutatingMethod = spec.methods.some((m) => mutatingMethods.includes(m));
    if (hasMutatingMethod && !spec.mutating) {
      violations.push({
        path: spec.path,
        problem: "route uses a mutating HTTP method but is not marked mutating",
      });
    }

    // Duplicate (path, method) pairs make the effective policy order-dependent.
    const methodsForPath = seen.get(spec.path) ?? new Set<HttpMethod>();
    for (const method of spec.methods) {
      if (methodsForPath.has(method)) {
        violations.push({ path: spec.path, problem: `duplicate declaration for ${method}` });
      }
      methodsForPath.add(method);
    }
    seen.set(spec.path, methodsForPath);
  }

  return violations;
}
