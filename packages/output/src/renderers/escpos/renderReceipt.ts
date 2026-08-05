import type { OrderData } from "../../models/OrderOutput";
import type { ReceiptTax } from "../../models/ReceiptOutput";
import type { RenderedOutput } from "../../models/RenderedOutput";
import { RENDERER_VERSION } from "./constants";
import {
  INIT, CENTER, LEFT, BOLD_ON, BOLD_OFF,
  SIZE_2X, SIZE_NORMAL, CUT, LINE_WIDTH,
} from "./constants";
import { separator, formatItemLine, formatTxnDisplayId, formatNow } from "./helpers";

export function renderReceipt(orderData: OrderData, tax: ReceiptTax): RenderedOutput {
  const { tableNumber, orderId, items, restaurantName, txnNumber, txnDate, captainName, sectionTag } = orderData;

  const resolvedRestaurantName = restaurantName || (
    sectionTag === 'venue-family-restaurant' || sectionTag === 'venue-restaurant-parcel'
      ? 'FAMILY RESTAURANT'
      : 'RESTAURANT'
  );

  const { date, time } = formatNow();

  const foodItems    = items.filter((i) => i.type === "food");
  const liquorItems  = items.filter((i) => i.type === "liquor");

  const foodSubtotal    = foodItems.reduce((s, i) => s + Number(i.price ?? 0) * i.quantity, 0);
  const liquorSubtotal  = liquorItems.reduce((s, i) => s + Number(i.price ?? 0) * i.quantity, 0);

  const cgst = tax.cgst;
  const sgst = tax.sgst;
  const total = Math.round((foodSubtotal + liquorSubtotal + tax.total) * 100) / 100;

  const fmt = (n: number) => `Rs.${n.toFixed(2)}`;

  const cmds: string[] = [
    INIT,
    CENTER,
    BOLD_ON,
    SIZE_2X,
    `${resolvedRestaurantName}\n`,
    BOLD_OFF,
    SIZE_NORMAL,
    LEFT,
    separator("="),
    `Table: ${tableNumber}\n`,
    `Bill #: ${formatTxnDisplayId(txnDate, txnNumber) || orderId.slice(-6).toUpperCase()}\n`,
    `Date : ${date}\n`,
    `Time : ${time}\n`,
  ];

  if (captainName) {
    cmds.push(`Captain: ${captainName}\n`);
  }

  cmds.push(separator("="), "\n");

  if (foodItems.length > 0) {
    cmds.push(LEFT, SIZE_2X, BOLD_ON, "FOOD\n", BOLD_OFF, SIZE_NORMAL, "\n");
    for (const item of foodItems) {
      cmds.push(
        SIZE_2X, BOLD_ON,
        formatItemLine(`${item.quantity}x ${item.name}`, fmt(Number(item.price ?? 0) * item.quantity), LINE_WIDTH),
        BOLD_OFF, SIZE_NORMAL,
      );
      if (item.notes) cmds.push(`   * ${item.notes}\n`);
    }
    cmds.push("\n");
  }

  if (liquorItems.length > 0) {
    cmds.push(LEFT, SIZE_2X, BOLD_ON, "LIQUOR\n", BOLD_OFF, SIZE_NORMAL, "\n");
    for (const item of liquorItems) {
      cmds.push(
        SIZE_2X, BOLD_ON,
        formatItemLine(`${item.quantity}x ${item.name}`, fmt(Number(item.price ?? 0) * item.quantity), LINE_WIDTH),
        BOLD_OFF, SIZE_NORMAL,
      );
      if (item.notes) cmds.push(`   * ${item.notes}\n`);
    }
    cmds.push("\n");
  }

  cmds.push(separator("="));
  if (foodItems.length > 0) cmds.push(BOLD_ON, formatItemLine("Food Subtotal", fmt(foodSubtotal), LINE_WIDTH), BOLD_OFF);
  if (liquorItems.length > 0) cmds.push(BOLD_ON, formatItemLine("Liquor Subtotal", fmt(liquorSubtotal), LINE_WIDTH), BOLD_OFF);
  if (cgst > 0) cmds.push(BOLD_ON, formatItemLine("CGST", fmt(cgst), LINE_WIDTH), BOLD_OFF);
  if (sgst > 0) cmds.push(BOLD_ON, formatItemLine("SGST", fmt(sgst), LINE_WIDTH), BOLD_OFF);

  cmds.push(
    separator("="),
    BOLD_ON,
    formatItemLine("TOTAL", fmt(total), LINE_WIDTH),
    BOLD_OFF,
    separator("="),
    CENTER,
    "Thank you for dining with us!\n",
    "Please visit again.\n",
    LEFT,
    "\n\n\n",
    CUT,
  );

  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join("") }] };
}
