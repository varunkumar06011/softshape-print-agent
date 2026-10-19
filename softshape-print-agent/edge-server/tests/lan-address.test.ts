// ─────────────────────────────────────────────────────────────────────────────
// lan-address.test.ts — the PC reports its real WiFi / Ethernet address
// ─────────────────────────────────────────────────────────────────────────────
// Run: cd edge-server && bun test tests/lan-address.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "bun:test";
import { getLanIpv4, getLanIpv4Addresses } from "../lanAddress.ts";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null }) as any;

test("a virtual adapter listed first is not reported as the PC's address", () => {
  const nets = {
    "VirtualBox Host-Only Network": [v4("192.168.56.1")],
    "vEthernet (Default Switch)": [v4("172.20.48.1")],
    "Wi-Fi": [v4("192.168.1.37")],
  };
  expect(getLanIpv4(nets)).toBe("192.168.1.37");
});

test("self-assigned 169.254 and loopback addresses are skipped", () => {
  const nets = {
    "Ethernet 2": [v4("169.254.10.4")],
    "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
    "Ethernet": [v4("192.168.0.20")],
  };
  expect(getLanIpv4Addresses(nets)).toEqual(["192.168.0.20"]);
});

test("WiFi / Ethernet adapters come before other adapters", () => {
  const nets = { "Local Area Connection* 3": [v4("10.0.0.5")], "Wi-Fi": [v4("10.0.0.9")] };
  expect(getLanIpv4Addresses(nets)).toEqual(["10.0.0.9", "10.0.0.5"]);
});

test("no LAN address → null", () => {
  expect(getLanIpv4({ "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)] })).toBeNull();
});
