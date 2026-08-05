import type { CancelKotPrintInput } from "../../models/CancelOutput";
import type { RenderedOutput } from "../../models/RenderedOutput";
import { RENDERER_VERSION } from "./constants";
import {
  INIT, CENTER, LEFT, BOLD_ON, BOLD_OFF,
  SIZE_2X, SIZE_2X_TALL, SIZE_NORMAL, SIZE_HEIGHT, CUT, FONT_A,
} from "./constants";
import { separator } from "./helpers";

export function renderCancelKOT(input: CancelKotPrintInput): RenderedOutput {
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
        ? 'FAMILY RESTAURANT'
        : 'RESTAURANT');

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
    INIT,
    CENTER,
    BOLD_ON,
    `${headerName}\n`,
    BOLD_OFF,
    `CANCEL ORDER\n`,
    separator('-'),
    BOLD_ON,
    SIZE_2X,
    `Table : ${tableDisplay}\n`,
    SIZE_NORMAL,
    BOLD_OFF,
    `Time  : ${timeStr}\n`,
    `By    : ${cancelledBy || 'Staff'}\n`,
    separator('-'),
  ];

  if (isSingle) {
    if (firstItem) {
      const itemLine = `${firstItem.quantity}    ${firstItem.name.toUpperCase()}  CANCELLED`;
      cmds.push(
        LEFT,
        FONT_A,
        SIZE_HEIGHT,
        BOLD_ON,
        itemLine + '\n',
        BOLD_OFF,
        SIZE_NORMAL,
        `Type  : ${itemType}\n`,
      );
    }
  } else {
    cmds.push(
      SIZE_HEIGHT,
      BOLD_ON,
      "Qty  Item\n",
      BOLD_OFF,
      SIZE_NORMAL,
      separator('-'),
    );
    allItems.forEach((item) => {
      const itemLine = `${item.quantity}    ${item.name.toUpperCase()}  CANCELLED`;
      cmds.push(
        LEFT,
        FONT_A,
        SIZE_HEIGHT,
        BOLD_ON,
        itemLine + '\n',
        BOLD_OFF,
        SIZE_NORMAL,
      );
    });
  }

  cmds.push(
    separator('-'),
    CENTER,
    BOLD_ON,
    SIZE_2X,
    `Hall Name : ${hallName}\n`,
    SIZE_NORMAL,
    BOLD_OFF,
    separator('-'),
    CENTER,
    "--- Cancel Order Ticket ---\n",
    LEFT,
    separator('-'),
    SIZE_2X_TALL,
    BOLD_ON,
    '** CANCELLED **\n',
    BOLD_OFF,
    SIZE_NORMAL,
    '\n\n\n',
    CUT,
  );

  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}
