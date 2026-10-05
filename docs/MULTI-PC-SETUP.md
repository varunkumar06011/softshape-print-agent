# Two (or more) billing PCs in one restaurant

Example: **Kandukuru Family Restaurant** — a dine-in hall (captains, its own billing PC) and an
outside curry point (no captains, its own billing PC). One restaurant account, two **venues**,
two billing PCs on the same Wi-Fi.

Everything below is settings. Nothing changes for a restaurant that has a single billing PC.

## 1. Network (once, on the router)

- Give the **dine-in PC**, the **curry-point PC** and the **kitchen printer** fixed IP addresses
  (DHCP reservation). Write them down.
- Kitchen printer must be a **network printer** (IP:port, normally `192.168.x.x:9100`) so both PCs can
  print to it. A USB printer attached to one PC cannot be used by the other PC.

## 2. Cloud setup (Admin app → Manage Space)

1. Create two venues: **Dine In** and **Curry Point**.
2. Set each venue's **Bill printer** (the printer connected to that PC — its Windows printer name, or `IP:port`).
   - Dine In → dine-in bill printer
   - Curry Point → curry-point bill printer
3. Curry Point: leave **KOT = ON** and give it counter "tables" (e.g. Counter 1…N). Orders taken on these
   print a KOT to the kitchen printer and the bill to the curry-point bill printer.
   - The cashier's quick **Walk-in** mode never prints a KOT. Use counter tables if the kitchen must get a ticket.
4. Set the item prices for each venue (venue prices) as usual.
5. Kitchen printer: set the shared kitchen printer to `IP:port` in the printer mapping, and keep the
   category printer target on *kitchen*. Both PCs then send KOTs to the same printer.

## 3. Install the cashier app on both PCs

- Install and register the **dine-in PC first**. The first registered PC becomes the restaurant's
  *primary* PC, which is the address the cloud gives to captain phones.
- Register the curry-point PC second.

## 4. "This PC" screen on each PC (once)

Log in on that PC as **Owner/Admin** → sidebar → **This PC**.

| Setting | Dine-in PC | Curry-point PC |
|---|---|---|
| Venue served by this PC | Dine In | Curry Point |
| Bill number prefix | `D-` | `C-` |
| Captains connect to this PC | ON | **OFF** |

Save, then reload the cashier screen. The PC now shows only its own venue's tables and prints
bills numbered `D-1, D-2…` / `C-1, C-2…`, so the two PCs never issue the same bill number.
These settings are stored on that PC only and are never uploaded, so one PC cannot change the other.

## 5. Captain phones

- Join the restaurant Wi-Fi and log in. The app finds the dine-in PC automatically and skips any PC
  set to "Captains connect: OFF".
- If a phone ever connects to the wrong PC: Settings → Edge URL → `http://<dine-in PC IP>:3101`.
- Captains print to: the dine-in bill printer (via the dine-in PC) and the kitchen printer. They never
  print to the curry-point printer.

## 6. Check before going live

1. Dine-in PC: place an order from a captain phone → KOT prints in the kitchen; bill prints on the dine-in printer as `D-1`.
2. Curry-point PC: order on a counter table → KOT prints in the kitchen; bill prints on the curry-point printer as `C-1`.
3. Admin app → Transactions: both bills appear, combined, with their prefixes.
4. Cashier header / sync indicator on both PCs shows nothing pending after a minute.

## Good to know

- The **cashier app's own sales dashboard** shows that PC's sales only. The combined view is in the Admin app (cloud).
- A "Close day"/X-report on a cashier PC covers that PC.
- Undo: *This PC* → Venue = *All venues*, empty prefix, Captains ON — back to normal behaviour.
- If the bound venue is later deleted in the cloud, the PC automatically falls back to showing all venues
  (and logs a warning) instead of showing an empty screen.
