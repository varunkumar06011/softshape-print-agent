// ─────────────────────────────────────────────────────────────────────────────
// lanAddress.ts — this PC's address on the restaurant LAN
// ─────────────────────────────────────────────────────────────────────────────
// Captains reach the billing PC at this address, and the cashier screen shows
// it so staff can type it into the captain app. Windows PCs often have extra
// adapters (VirtualBox / Hyper-V / VPN / Bluetooth) and a self-assigned
// 169.254.x.x address on an unplugged port; taking the first IPv4 address
// found could report one of those instead of the real WiFi / Ethernet address.
// ─────────────────────────────────────────────────────────────────────────────

import os from "node:os";

const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|hyper-v|vbox|loopback|bluetooth|tailscale|zerotier|hamachi|wsl|docker|vpn|tap-|tun/i;
const PHYSICAL_ADAPTER = /wi-?fi|wlan|wireless|ethernet|^eth|^en/i;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

function isPrivateIPv4(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** LAN IPv4 addresses of this PC, most likely the real WiFi / Ethernet one first. */
export function getLanIpv4Addresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const found: { address: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const addr of addrs || []) {
      if (addr.family !== "IPv4" || addr.internal || addr.address.startsWith("169.254.")) continue;
      let score = 0;
      if (PHYSICAL_ADAPTER.test(name)) score += 2;
      if (/^192\.168\./.test(addr.address)) score += 1;
      if (!isPrivateIPv4(addr.address)) score -= 3;
      found.push({ address: addr.address, score });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.address);
}

/** The address captains should use, or null. */
export function getLanIpv4(interfaces?: Interfaces): string | null {
  return getLanIpv4Addresses(interfaces)[0] ?? null;
}
