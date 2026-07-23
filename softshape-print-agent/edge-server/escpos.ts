// ─────────────────────────────────────────────────────────────────────────────
// escpos.ts — ESC/POS thermal printer command builders (edge server port)
// ─────────────────────────────────────────────────────────────────────────────
// Ported from softshape-backend/src/utils/escpos.ts
// Pure TypeScript string manipulation — no external dependencies.
//
// Generates raw ESC/POS commands for:
//   - Food KOT (Kitchen Order Ticket)
//   - Liquor KOT (Bar Order Ticket)
//   - Cancel KOT
//   - Bill Receipt
// ─────────────────────────────────────────────────────────────────────────────

// ─── ESC/POS Constants ───────────────────────────────────────────────────────

const INIT = '\x1B\x40';
const CENTER = '\x1B\x61\x01';
const LEFT = '\x1B\x61\x00';
const BOLD_ON = '\x1B\x45\x01';
const BOLD_OFF = '\x1B\x45\x00';
const SIZE_2X = '\x1D\x21\x11';
const SIZE_2X_TALL = '\x1D\x21\x12';
const SIZE_NORMAL = '\x1D\x21\x00';
const SIZE_HEIGHT = '\x1D\x21\x01';
const CUT = '\x1D\x56\x42\x00';
const FONT_A = '\x1B\x4D\x00';

const LINE_NORMAL = 42;
const LINE_2X = 21;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PrintItem {
  name: string;
  price?: number;
  quantity: number;
  notes?: string | null;
  type?: "food" | "liquor";
}

export interface OrderData {
  tableNumber: number | string;
  orderId: string;
  items: PrintItem[];
  restaurantName?: string;
  kotNumber?: number | string;
  kotId?: string;
  captainName?: string;
  orderByRole?: string;
  sectionName?: string;
  sectionTag?: string;
}

export interface BillPrintRestaurant {
  name?: string;
  receiptHeader?: string | null;
  receiptSubHeader?: string | null;
  address?: string | null;
  phone?: string | null;
  gstin?: string | null;
}

export interface CancelKotItem {
  name: string;
  quantity: number;
  menuType?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function separator(ch = "-"): string {
  return ch.repeat(LINE_NORMAL) + "\n";
}

function pad(str: string | number, len: number): string {
  return String(str).padEnd(len);
}

function padRight(left: string | number, right: string | number, width = LINE_NORMAL): string {
  const leftStr = String(left).slice(0, width - String(right).length - 1);
  return leftStr.padEnd(width - String(right).length) + right;
}

function formatItemLine(label: string, valueStr: string): string {
  const available = LINE_NORMAL - valueStr.length;
  return label.substring(0, available).padEnd(available) + valueStr + "\n";
}

function formatTxnDisplayId(txnDate?: string, txnNumber?: number): string {
  if (!txnDate || !txnNumber) return "";
  const [year, month, day] = txnDate.split("-");
  const datePart = `${day}/${month}/${year.slice(-2)}`;
  const seqPart = String(txnNumber).padStart(3, "0");
  return `${datePart}-${seqPart}`;
}

// ─── Food KOT ────────────────────────────────────────────────────────────────

export function buildFoodKOT(orderData: OrderData): { type: string; format: string; data: string }[] {
  const { tableNumber, orderId, items, kotId, sectionName, captainName, orderByRole, sectionTag } = orderData;
  const foodItems = items.filter((i) => i.type === "food");
  const roleLabel = orderByRole === 'CASHIER' ? 'Cashier' : orderByRole === 'ADMIN' ? 'Admin' : orderByRole === 'OWNER' ? 'Owner' : 'Captain';

  if (foodItems.length === 0) return [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

  const displayKotId = kotId || "N/A";
  const rawTableLabel = (tableNumber || 'N/A').toString();
  const tableDisplay = (sectionTag && sectionTag.startsWith('venue-'))
    ? rawTableLabel
    : (/^[BT]\d+$/i.test(rawTableLabel) ? rawTableLabel.slice(1) : rawTableLabel);

  const headerName = (orderData.restaurantName && orderData.restaurantName.trim())
    ? orderData.restaurantName.toUpperCase()
    : (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
        ? 'FAMILY RESTAURANT' : 'RESTAURANT');

  const cmds: string[] = [INIT, CENTER, BOLD_ON, `${headerName}\n`, BOLD_OFF];

  if (sectionName) cmds.push(`${sectionName}\n`);

  cmds.push(LEFT, separator("-"), BOLD_ON, SIZE_2X);

  const kotLabel = `KOT No : ${displayKotId}`;
  const tableLabel = `Table : ${tableDisplay}`;
  const kotTableGap = Math.max(1, LINE_2X - kotLabel.length - tableLabel.length);
  cmds.push(`${kotLabel}${' '.repeat(kotTableGap)}${tableLabel}\n`);
  cmds.push(SIZE_NORMAL, BOLD_OFF);

  cmds.push(
    `${roleLabel} : ${captainName && captainName !== 'N/A' ? captainName : roleLabel}\n`,
    `Date : ${dateStr}  Time : ${timeStr}\n`,
    separator("-"), BOLD_ON, "Qty  Item\n", BOLD_OFF, separator("-"),
  );

  for (const item of foodItems) {
    cmds.push(SIZE_2X_TALL, BOLD_ON, `${item.quantity}  ${item.name.toUpperCase()}\n`, BOLD_OFF, SIZE_NORMAL);
    if (item.notes) cmds.push(`     * ${item.notes}\n`);
  }

  cmds.push(
    separator("-"), BOLD_ON, SIZE_2X,
    `Hall Name : ${sectionName || 'Family Restaurant'}\n`,
    SIZE_NORMAL, BOLD_OFF, CENTER, "--- Kitchen Order Ticket ---\n", LEFT, "\n\n\n", CUT,
  );

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// ─── Liquor / Bar KOT ────────────────────────────────────────────────────────

export function buildLiquorKOT(orderData: OrderData): { type: string; format: string; data: string }[] {
  const { tableNumber, orderId, items, kotId, sectionName, captainName, orderByRole, sectionTag } = orderData;
  const liquorItems = items.filter((i) => i.type === "liquor");
  const roleLabel = orderByRole === 'CASHIER' ? 'Cashier' : orderByRole === 'ADMIN' ? 'Admin' : orderByRole === 'OWNER' ? 'Owner' : 'Captain';

  if (liquorItems.length === 0) return [];

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

  const displayKotId = kotId || "N/A";
  const rawTableLabel = (tableNumber || 'N/A').toString();
  const tableDisplay = (sectionTag && sectionTag.startsWith('venue-'))
    ? rawTableLabel
    : (/^[BT]\d+$/i.test(rawTableLabel) ? rawTableLabel.slice(1) : rawTableLabel);

  const headerName = (orderData.restaurantName && orderData.restaurantName.trim())
    ? orderData.restaurantName.toUpperCase()
    : (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
        ? 'FAMILY RESTAURANT' : 'RESTAURANT');

  const sectionLabel = sectionName || (sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
    ? 'COUNTER ORDER' : 'BAR ORDER');

  const cmds: string[] = [INIT, CENTER, BOLD_ON, `${headerName}\n`, BOLD_OFF];

  if (sectionLabel) cmds.push(`${sectionLabel}\n`);

  cmds.push(LEFT, separator("-"), BOLD_ON, SIZE_2X);

  const kotLabel = `KOT No : ${displayKotId}`;
  const tableLabel = `Table : ${tableDisplay}`;
  const kotTableGap = Math.max(1, LINE_2X - kotLabel.length - tableLabel.length);
  cmds.push(`${kotLabel}${' '.repeat(kotTableGap)}${tableLabel}\n`);
  cmds.push(SIZE_NORMAL, BOLD_OFF);

  cmds.push(
    separator("-"),
    `${roleLabel} : ${captainName && captainName !== 'N/A' ? captainName : roleLabel}\n`,
    `Date : ${dateStr}  Time : ${timeStr}\n`,
    separator("-"), BOLD_ON, "Qty  Item\n", BOLD_OFF, separator("-"),
  );

  for (const item of liquorItems) {
    cmds.push(SIZE_HEIGHT, BOLD_ON, `${item.quantity}  ${item.name.toUpperCase()}\n`, BOLD_OFF, SIZE_NORMAL);
    if (item.notes) cmds.push(`     * ${item.notes}\n`);
  }

  cmds.push(
    separator("-"), BOLD_ON, SIZE_2X,
    `Hall Name : ${sectionName || 'N/A'}\n`,
    SIZE_NORMAL, BOLD_OFF, CENTER, "--- Bar Order Ticket ---\n", LEFT, "\n\n\n", CUT,
  );

  return [{ type: "raw", format: "plain", data: cmds.join("") }];
}

// ─── Cancel KOT ──────────────────────────────────────────────────────────────

export interface CancelKotPrintInput {
  tableNumber: string | number;
  cancelledBy: string;
  timestamp: string;
  items: CancelKotItem[];
  sectionName?: string;
  sectionTag?: string | null;
  restaurant?: BillPrintRestaurant;
}

export function buildCancelKOT(input: CancelKotPrintInput): { type: string; format: string; data: string }[] {
  const { tableNumber, cancelledBy, timestamp, items, sectionName, sectionTag, restaurant } = input;

  const timeStr = new Date(timestamp || Date.now()).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });

  const receiptHeader = restaurant?.receiptHeader || restaurant?.name || 'RESTAURANT';
  const secTag = (sectionTag || '').toLowerCase();
  const isVenue = secTag.startsWith('venue-');

  const headerName = (receiptHeader && receiptHeader.trim())
    ? receiptHeader.toUpperCase()
    : (secTag === 'venue-family-restaurant' || secTag === 'venue-restaurant-parcel'
        ? 'FAMILY RESTAURANT' : 'RESTAURANT');

  const rawTable = (tableNumber || 'N/A').toString();
  const tableDisplay = isVenue
    ? rawTable
    : (/^[BT]\d+$/i.test(rawTable) ? rawTable.slice(1) : rawTable);

  const hallName = secTag === 'venue-family-restaurant'
    ? 'DINE IN'
    : (secTag === 'venue-restaurant-parcel'
      ? 'OWNER(FAMILY RESTAURANT)'
      : (sectionName ? sectionName.toUpperCase() : 'N/A'));

  const allItems = (items || []).filter((i) => i);
  const isSingle = allItems.length <= 1;
  const firstItem = allItems[0];
  const itemType = firstItem?.menuType === 'BAR' ? 'Bar Item' : 'Food Item';

  const cmds: string[] = [
    INIT, CENTER, BOLD_ON, `${headerName}\n`, BOLD_OFF,
    `CANCEL ORDER\n`, separator('-'), BOLD_ON, SIZE_2X,
    `Table : ${tableDisplay}\n`, SIZE_NORMAL, BOLD_OFF,
    `Time  : ${timeStr}\n`, `By    : ${cancelledBy || 'Staff'}\n`, separator('-'),
  ];

  if (isSingle) {
    if (firstItem) {
      const itemLine = `${firstItem.quantity}    ${firstItem.name.toUpperCase()}  CANCELLED`;
      cmds.push(LEFT, FONT_A, SIZE_HEIGHT, BOLD_ON, itemLine + '\n', BOLD_OFF, SIZE_NORMAL, `Type  : ${itemType}\n`);
    }
  } else {
    cmds.push(SIZE_HEIGHT, BOLD_ON, "Qty  Item\n", BOLD_OFF, SIZE_NORMAL, separator('-'));
    allItems.forEach((item) => {
      const itemLine = `${item.quantity}    ${item.name.toUpperCase()}  CANCELLED`;
      cmds.push(LEFT, FONT_A, SIZE_HEIGHT, BOLD_ON, itemLine + '\n', BOLD_OFF, SIZE_NORMAL);
    });
  }

  cmds.push(
    separator('-'), CENTER, BOLD_ON, SIZE_2X,
    `Hall Name : ${hallName}\n`, SIZE_NORMAL, BOLD_OFF,
    separator('-'), CENTER, "--- Cancel Order Ticket ---\n", LEFT, separator('-'),
    SIZE_2X_TALL, BOLD_ON, '** CANCELLED **\n', BOLD_OFF, SIZE_NORMAL, '\n\n\n', CUT,
  );

  return [{ type: 'raw', format: 'plain', data: cmds.join('') }];
}

// ─── Bill Receipt ────────────────────────────────────────────────────────────

export interface BillPrintInput {
  tableNumber: string | number;
  items: Array<{ name: string; quantity: number; price: number; menuType?: "FOOD" | "LIQUOR"; gstEnabled?: boolean }>;
  totalAmount: number;
  restaurant?: BillPrintRestaurant;
  sectionTag?: string | null;
  gstCategory?: string | null;
  gstRate?: number | null;
  gstRegistered?: boolean;
  pricesIncludeGst?: boolean;
  discountPercent?: number;
  serviceChargePercent?: number;
  billNumber?: string | null;
}

function getEffectiveGstRate(gstRate: number | null | undefined, gstCategory: string | null | undefined, gstRegistered: boolean | null | undefined): number {
  if (gstRegistered === false) return 0;
  if (gstRate != null && gstRate > 0) return gstRate;
  const category = (gstCategory || 'NON_AC').toUpperCase();
  return category === 'AC' ? 18 : 5;
}

function getGstBreakdownWithRate(taxableAmount: number, ratePercent: number, _pricesIncludeGst: boolean) {
  const amount = Math.max(0, Number(taxableAmount) || 0);

  if (ratePercent <= 0) {
    return { cgst: 0, sgst: 0, tax: 0, baseAmount: amount };
  }

  const totalRate = ratePercent / 100;
  const halfRate = totalRate / 2;
  const tax = amount * totalRate;
  const cgst = amount * halfRate;
  const sgst = amount * halfRate;
  return { cgst, sgst, tax, baseAmount: amount };
}

export function buildBill(input: BillPrintInput): { type: string; format: string; data: string }[] {
  const { tableNumber, items, totalAmount, restaurant, sectionTag } = input;
  const receiptHeader = restaurant?.receiptHeader || restaurant?.name || 'RESTAURANT';
  const secTag = (sectionTag || '').toLowerCase();
  const venueLabel = secTag === 'venue-family-restaurant' || secTag === 'venue-restaurant-parcel'
    ? receiptHeader
    : (secTag.startsWith('venue-bar-') ? 'BAR ORDER' : receiptHeader);

  const cmds: string[] = [INIT, CENTER, BOLD_ON, `${venueLabel}\n`, BOLD_OFF, SIZE_NORMAL];

  if (restaurant?.receiptSubHeader) cmds.push(CENTER, `${restaurant.receiptSubHeader}\n`);
  if (restaurant?.address) cmds.push(CENTER, `${restaurant.address}\n`);
  if (restaurant?.phone) cmds.push(CENTER, `Phone: ${restaurant.phone}\n`);
  if (restaurant?.gstin) cmds.push(CENTER, `GSTIN: ${restaurant.gstin}\n`);

  cmds.push(
    SIZE_2X, BOLD_ON, 'BILL RECEIPT\n', BOLD_OFF, SIZE_NORMAL, separator(),
  );

  if (input.billNumber) {
    cmds.push(LEFT, BOLD_ON, `Bill No : ${input.billNumber}\n`, BOLD_OFF);
  }
  cmds.push(
    LEFT, `Table : ${tableNumber}\n`,
    `Date  : ${new Date().toLocaleString('en-IN')}\n`, separator(),
    BOLD_ON, pad('ITEM', 24) + pad('QTY', 6) + 'AMT'.padStart(12) + '\n', BOLD_OFF, separator(),
  );

  (items || []).forEach((item) => {
    const name = String(item.name || '').slice(0, 24);
    const qty = String(item.quantity || 1);
    const amt = 'Rs.' + ((item.price || 0) * (item.quantity || 1)).toFixed(2);
    cmds.push(pad(name, 24) + pad(qty, 6) + amt.padStart(12) + '\n');
  });

  const foodItems = items.filter((i) => i.menuType === 'FOOD');
  const liquorItems = items.filter((i) => i.menuType !== 'FOOD');
  const foodSubtotal = foodItems.reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const liquorSubtotal = liquorItems.reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const totalSubtotal = foodSubtotal + liquorSubtotal;

  // GST-exempt items: any item (food or liquor) with gstEnabled=false is exempt.
  // Liquor defaults to gstEnabled=false (no GST) but admin can enable it per item.
  const gstExemptFood = foodItems.filter((i) => i.gstEnabled === false).reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const gstExemptLiquor = liquorItems.filter((i) => i.gstEnabled === false).reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const gstExemptTotal = gstExemptFood + gstExemptLiquor;

  // Discount on raw subtotal first (proportional) — matches settlement
  const discPercent = Number(input.discountPercent || 0);
  const discountAmount = discPercent > 0
    ? Math.round(totalSubtotal * (discPercent / 100) * 100) / 100
    : 0;

  const discountedSubtotal = Math.max(0, totalSubtotal - discountAmount);
  const gstExemptAfterDiscount = Math.max(0, gstExemptTotal - (discountAmount > 0 && totalSubtotal > 0 ? discountAmount * (gstExemptTotal / totalSubtotal) : 0));
  const taxableAmount = Math.max(0, discountedSubtotal - gstExemptAfterDiscount);

  const effectiveRate = getEffectiveGstRate(input.gstRate, input.gstCategory, input.gstRegistered);
  const { cgst, sgst, tax } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!input.pricesIncludeGst);

  // Service charge on (discountedSubtotal + GST) — matches settlement
  const scPercent = Number(input.serviceChargePercent || 0);
  const serviceChargeAmount = scPercent > 0
    ? Math.round((discountedSubtotal + tax) * (scPercent / 100) * 100) / 100
    : 0;

  const rawTotal = Math.max(0, discountedSubtotal + tax + serviceChargeAmount);
  const roundedTotal = Math.round(rawTotal * 100) / 100;
  const roundOff = Math.round((roundedTotal - rawTotal) * 100) / 100;

  // ── Render totals ──────────────────────────────────────────────────────
  cmds.push(separator());
  cmds.push(padRight('Subtotal', 'Rs.' + totalSubtotal.toFixed(2)) + '\n');

  // GST breakdown (CGST + SGST) — matches backend's buildFinalBill format
  if (tax > 0) {
    cmds.push(padRight('CGST', 'Rs.' + cgst.toFixed(2)) + '\n');
    cmds.push(padRight('SGST', 'Rs.' + sgst.toFixed(2)) + '\n');
  }

  // Service charge line — only print if non-zero
  if (serviceChargeAmount > 0) {
    cmds.push(padRight(`Service Charge ${scPercent}%`, 'Rs.' + serviceChargeAmount.toFixed(2)) + '\n');
  }

  // Discount line — matches backend's buildFinalBill format exactly:
  //   (-) Discount {percent}% :{amount}
  if (discPercent > 0 && discountAmount > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`(-) Discount ${Math.round(discPercent).toFixed(0)}% :${String(Math.round(discountAmount).toFixed(0)).padStart(LINE_NORMAL - 22)}\n`);
    cmds.push(BOLD_OFF);
  }

  // Round off line — only print if non-zero (matches frontend billing.js)
  if (roundOff !== 0) {
    cmds.push(padRight('Round Off', 'Rs.' + roundOff.toFixed(2)) + '\n');
  }

  cmds.push(
    separator('='),
    BOLD_ON, padRight('TOTAL', 'Rs.' + roundedTotal.toFixed(2)) + '\n', BOLD_OFF,
    separator(), CENTER, 'Thank you! Visit again.\n', '\n',
    'Powered by Softshape.ai\n', '\n\n\n', CUT,
  );

  return [{ type: 'raw', format: 'plain', data: cmds.join('') }];
}
