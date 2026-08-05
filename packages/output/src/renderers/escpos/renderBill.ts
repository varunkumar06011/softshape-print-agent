import type { BillData, BillPrintInput } from "../../models/BillOutput";
import type { RenderedOutput } from "../../models/RenderedOutput";
import { RENDERER_VERSION } from "./constants";
import {
  INIT, CENTER, LEFT, BOLD_ON, BOLD_OFF,
  SIZE_2X, SIZE_NORMAL, SIZE_HEIGHT, CUT,
  LINE_NORMAL,
} from "./constants";
import {
  separator, pad, padRight,
  getEffectiveGstRate, getGstBreakdownWithRate,
} from "./helpers";

export function renderFinalBill(data: BillData): RenderedOutput {
  const cmds: string[] = [];

  cmds.push(INIT);

  const venueName = ((data as any).restaurant?.receiptHeader?.trim() || (data as any).restaurant?.name?.trim() || 'RESTAURANT').toUpperCase();

  cmds.push(CENTER);
  cmds.push(BOLD_ON);
  cmds.push(SIZE_HEIGHT);
  cmds.push(`${venueName}\n`);
  cmds.push(BOLD_OFF);
  cmds.push(SIZE_NORMAL);

  const restaurantInfo = (data as any).restaurant;

  cmds.push(CENTER);
  if (restaurantInfo?.receiptSubHeader) {
    cmds.push(`${restaurantInfo.receiptSubHeader}\n`);
  }
  if (restaurantInfo?.address) {
    cmds.push(`${restaurantInfo.address}\n`);
  }
  if (restaurantInfo?.phone) {
    cmds.push(`Phone: ${restaurantInfo.phone}\n`);
  }
  if (data.gstIn) {
    cmds.push(`GST IN: ${data.gstIn}\n`);
  }

  cmds.push(separator("-"));

  if (data.isCancelled) {
    cmds.push(BOLD_ON);
    cmds.push(SIZE_2X);
    cmds.push('*** CANCELLED BILL ***\n');
    cmds.push(SIZE_NORMAL);
    cmds.push(BOLD_OFF);
    cmds.push(separator("-"));
  }

  if (data.isReprint) {
    cmds.push(BOLD_ON);
    cmds.push(SIZE_2X);
    cmds.push('*** REPRINT BILL ***\n');
    cmds.push(SIZE_NORMAL);
    cmds.push(BOLD_OFF);
    cmds.push(separator("-"));
  }

  const rawTable = (data.tableNumber || 'N/A').toString();
  const tableNumeric = (data.sectionTag && data.sectionTag.startsWith('venue-'))
    ? rawTable
    : rawTable.replace(/^[BT]/i, '');

  cmds.push(SIZE_HEIGHT);
  cmds.push(BOLD_ON);
  const billNo = data.billNumber || 'N/A';
  const billTableGap = Math.max(1, LINE_NORMAL - `Bill No : ${billNo}`.length - `Table: ${tableNumeric}`.length);
  cmds.push(`Bill No : ${billNo}${' '.repeat(billTableGap)}Table: ${tableNumeric}\n`);
  cmds.push(BOLD_OFF);
  cmds.push(SIZE_NORMAL);

  cmds.push(`Date: ${data.date || 'N/A'}\n`);

  if (data.kotNumbers && data.kotNumbers.length > 0) {
    cmds.push(`KOT No : ${data.kotNumbers.join(', ')}\n`);
  }

  cmds.push(`Time: ${data.time || 'N/A'}\n`);

  if (data.captain && data.captain !== 'N/A') {
    const captainGap = Math.max(1, LINE_NORMAL - `Captain: ${data.captain}`.length - `Waiter: Waiter`.length);
    cmds.push(`Captain: ${data.captain}${' '.repeat(captainGap)}Waiter: Waiter\n`);
  }

  cmds.push(separator("-"));

  cmds.push(LEFT);
  cmds.push('Item            Qty    Price    Amount\n');
  cmds.push(separator("-"));

  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    cmds.push('NO ITEMS\n');
  } else {
    data.items.forEach(item => {
      cmds.push(BOLD_ON);
      const itemName = item.name.toUpperCase().substring(0, 24);
      cmds.push(`${itemName}\n`);
      cmds.push(BOLD_OFF);
      const qty = String(item.quantity).padStart(4);
      const price = String(Math.round(item.price).toFixed(0)).padStart(9);
      const amount = String(Math.round(item.amount).toFixed(0)).padStart(10);
      cmds.push(BOLD_ON);
      cmds.push(`              ${qty}  ${price}  ${amount}\n`);
      cmds.push(BOLD_OFF);
      if (item.notes) {
        cmds.push(`   * ${item.notes}\n`);
      }
    });
  }

  cmds.push(separator("-"));

  cmds.push(BOLD_ON);
  cmds.push(`Sub Total :${String(Math.round(data.subtotal).toFixed(0)).padStart(LINE_NORMAL - 12)}\n`);
  cmds.push(BOLD_OFF);

  if (data.tax && data.tax.total > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`CGST :${String(Math.round(data.tax.cgst).toFixed(0)).padStart(LINE_NORMAL - 7)}\n`);
    cmds.push(`SGST :${String(Math.round(data.tax.sgst).toFixed(0)).padStart(LINE_NORMAL - 7)}\n`);
    cmds.push(BOLD_OFF);
  }

  if (data.serviceCharge && data.serviceCharge.amount > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`(+) Service Charge ${Math.round(data.serviceCharge.percent).toFixed(0)}% :${String(Math.round(data.serviceCharge.amount).toFixed(0)).padStart(LINE_NORMAL - 28)}\n`);
    cmds.push(BOLD_OFF);
  }

  if (data.discount && data.discount.percent > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`(-) Discount ${Math.round(data.discount.percent).toFixed(0)}% :${String(Math.round(data.discount.amount).toFixed(0)).padStart(LINE_NORMAL - 22)}\n`);
    cmds.push(BOLD_OFF);
  }

  cmds.push(separator("-"));

  if (data.roundOff && data.roundOff !== 0) {
    cmds.push(BOLD_ON);
    const roLabel = data.roundOff > 0 ? 'Round Off' : 'Round Off';
    const roValue = (data.roundOff > 0 ? '+' : '') + data.roundOff.toFixed(2);
    cmds.push(`${roLabel} :${String(roValue).padStart(LINE_NORMAL - roLabel.length - 3)}\n`);
    cmds.push(BOLD_OFF);
  }

  cmds.push(SIZE_HEIGHT);
  cmds.push(BOLD_ON);
  const gtLabel = 'Grand Total';
  const gtValue = Math.round(data.grandTotal).toFixed(0);
  const gtGap = Math.max(1, LINE_NORMAL - gtLabel.length - gtValue.length);
  cmds.push(gtLabel + ' '.repeat(gtGap) + gtValue + '\n');
  cmds.push(BOLD_OFF);
  cmds.push(SIZE_NORMAL);

  cmds.push(BOLD_ON);
  cmds.push(`Items / Qty : ${data.itemCount || 0}/${data.qtyCount || 0}\n`);
  cmds.push(BOLD_OFF);

  const secTag = (data.sectionTag || '').toLowerCase();
  const secName = (data.section || '').toLowerCase();
  const hallName = (secTag === 'venue-family-restaurant' || secName.includes('family restaurant') || secName.includes('main hall'))
    ? 'DINE IN'
    : (secTag === 'venue-restaurant-parcel' || secName.includes('parcel'))
        ? 'PARCEL(FAMILY RESTAURANT)'
        : (data.section ? data.section.toUpperCase() : 'DINE IN');

  cmds.push(separator("-"));
  cmds.push(`Hall : ${hallName}\n`);
  cmds.push('* *\n');
  cmds.push('\n');
  cmds.push(BOLD_ON);
  cmds.push(hallName);
  cmds.push(BOLD_OFF);
  cmds.push('\n');

  if (data.isCancelled) {
    cmds.push(separator("-"));
    cmds.push(CENTER);
    cmds.push(BOLD_ON);
    cmds.push(SIZE_2X);
    cmds.push('** CANCELLED **\n');
    cmds.push(SIZE_NORMAL);
    cmds.push(BOLD_OFF);
    cmds.push(separator("-"));
  }

  if (data.isReprint) {
    cmds.push(separator("-"));
    cmds.push(CENTER);
    cmds.push(BOLD_ON);
    cmds.push(SIZE_2X);
    cmds.push('** REPRINT **\n');
    cmds.push(SIZE_NORMAL);
    cmds.push(BOLD_OFF);
    cmds.push(separator("-"));
  }

  cmds.push(CENTER);
  cmds.push('Thank You, Please Visit again\n');
  cmds.push('\n\n\n');
  cmds.push(CUT);

  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}

export function renderBill(input: BillPrintInput): RenderedOutput {
  const { tableNumber, items, restaurant, sectionTag } = input;

  const receiptHeader = restaurant?.receiptHeader || restaurant?.name || 'RESTAURANT';
  const secTag = (sectionTag || '').toLowerCase();
  const venueLabel = secTag === 'venue-family-restaurant' || secTag === 'venue-restaurant-parcel'
    ? receiptHeader
    : (secTag.startsWith('venue-bar-') ? 'BAR ORDER' : receiptHeader);

  const cmds: string[] = [
    INIT,
    CENTER,
    BOLD_ON,
    `${venueLabel}\n`,
    BOLD_OFF,
    SIZE_NORMAL,
  ];

  if (restaurant?.receiptSubHeader) cmds.push(CENTER, `${restaurant.receiptSubHeader}\n`);
  if (restaurant?.address) cmds.push(CENTER, `${restaurant.address}\n`);
  if (restaurant?.phone) cmds.push(CENTER, `Phone: ${restaurant.phone}\n`);
  if (restaurant?.gstin) cmds.push(CENTER, `GSTIN: ${restaurant.gstin}\n`);

  cmds.push(
    SIZE_2X,
    BOLD_ON,
    'BILL RECEIPT\n',
    BOLD_OFF,
    SIZE_NORMAL,
    separator(),
  );

  if (input.billNumber) {
    cmds.push(LEFT, BOLD_ON, `Bill No : ${input.billNumber}\n`, BOLD_OFF);
  }

  cmds.push(
    LEFT,
    `Table : ${tableNumber}\n`,
    `Date  : ${new Date().toLocaleString('en-IN')}\n`,
    separator(),
    BOLD_ON,
    pad('ITEM', 24) + pad('QTY', 6) + 'AMT'.padStart(12) + '\n',
    BOLD_OFF,
    separator(),
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

  const gstExemptFood = foodItems.filter((i) => i.gstEnabled === false).reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const gstExemptLiquor = liquorItems.filter((i) => i.gstEnabled === false).reduce((s, i) => s + Number(i.price || 0) * (i.quantity || 1), 0);
  const gstExemptTotal = gstExemptFood + gstExemptLiquor;

  const discPercent = Number(input.discountPercent || 0);
  const discountAmount = discPercent > 0
    ? Math.round(totalSubtotal * (discPercent / 100) * 100) / 100
    : 0;

  const discountedSubtotal = Math.max(0, totalSubtotal - discountAmount);
  const gstExemptAfterDiscount = Math.max(0, gstExemptTotal - (discountAmount > 0 && totalSubtotal > 0 ? discountAmount * (gstExemptTotal / totalSubtotal) : 0));
  const taxableAmount = Math.max(0, discountedSubtotal - gstExemptAfterDiscount);

  const effectiveRate = getEffectiveGstRate(input.gstRate, input.gstCategory, input.gstRegistered);
  const { cgst, sgst, tax } = getGstBreakdownWithRate(taxableAmount, effectiveRate, !!input.pricesIncludeGst);

  const scPercent = Number(input.serviceChargePercent || 0);
  const serviceChargeAmount = scPercent > 0
    ? Math.round((discountedSubtotal + tax) * (scPercent / 100) * 100) / 100
    : 0;

  const total = Math.round(Math.max(0, discountedSubtotal + tax + serviceChargeAmount) * 100) / 100;

  cmds.push(
    separator(),
    padRight('Subtotal', 'Rs.' + totalSubtotal.toFixed(2)) + '\n',
  );

  if (tax > 0) {
    cmds.push(padRight('CGST', 'Rs.' + cgst.toFixed(2)) + '\n');
    cmds.push(padRight('SGST', 'Rs.' + sgst.toFixed(2)) + '\n');
  }

  if (serviceChargeAmount > 0) {
    cmds.push(padRight(`Service Charge ${scPercent}%`, 'Rs.' + serviceChargeAmount.toFixed(2)) + '\n');
  }

  if (discPercent > 0 && discountAmount > 0) {
    cmds.push(BOLD_ON);
    cmds.push(`(-) Discount ${Math.round(discPercent).toFixed(0)}% :${String(Math.round(discountAmount).toFixed(0)).padStart(LINE_NORMAL - 22)}\n`);
    cmds.push(BOLD_OFF);
  }

  cmds.push(
    separator('='),
    BOLD_ON,
    padRight('TOTAL', 'Rs.' + total.toFixed(2)) + '\n',
    BOLD_OFF,
    separator(),
    CENTER,
    'Thank you! Visit again.\n',
    '\n',
    `Powered by ${restaurant?.name || 'Softshape'}\n`,
    '\n\n\n',
    CUT,
  );

  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}
