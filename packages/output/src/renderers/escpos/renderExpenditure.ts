import type { ExpenditurePrintData } from "../../models/ExpenditureOutput";
import type { RenderedOutput } from "../../models/RenderedOutput";
import { RENDERER_VERSION } from "./constants";
import {
  INIT, CENTER, LEFT, BOLD_ON, BOLD_OFF,
  SIZE_2X, SIZE_NORMAL, CUT,
} from "./constants";
import { separator, padRight, numberToWords } from "./helpers";

export function renderExpenditure(data: ExpenditurePrintData): RenderedOutput {
  const cmds: string[] = [
    INIT,
    CENTER,
    BOLD_ON,
    SIZE_2X,
    `${(data.restaurant?.receiptHeader || data.restaurant?.name || 'RESTAURANT').toUpperCase()}\n`,
    BOLD_OFF,
    SIZE_NORMAL,
  ];

  if (data.restaurant?.receiptSubHeader) {
    cmds.push(CENTER, `${data.restaurant.receiptSubHeader}\n`);
  }
  if (data.restaurant?.address) {
    cmds.push(CENTER, `${data.restaurant.address}\n`);
  }
  if (data.restaurant?.phone) {
    cmds.push(CENTER, `Phone: ${data.restaurant.phone}\n`);
  }
  if (data.restaurant?.gstin) {
    cmds.push(CENTER, `GSTIN: ${data.restaurant.gstin}\n`);
  }

  cmds.push(
    separator(),
    SIZE_2X,
    BOLD_ON,
    CENTER,
    'CASH EXPENDITURE\n',
    BOLD_OFF,
    SIZE_NORMAL,
    separator(),
    LEFT,
    `Exp No     : ${data.expenditureNo}\n`,
    `Date       : ${data.expenditureDate}\n`,
    separator(),
    BOLD_ON,
    `Paid To    : ${data.paidToName}\n`,
    BOLD_OFF,
    `Type       : ${data.paidToType}\n`,
  );

  if (data.narration) {
    cmds.push(`Narration  : ${data.narration}\n`);
  }

  if (data.approvedByName) {
    cmds.push(BOLD_ON, `Approved By: ${data.approvedByName}\n`, BOLD_OFF);
  }

  cmds.push(
    separator(),
    BOLD_ON,
    padRight('Amount', 'Rs.' + data.amount.toFixed(2)),
    '\n',
    BOLD_OFF,
    separator(),
    LEFT,
    'Amount in Words:\n',
    BOLD_ON,
    `${numberToWords(data.amount)}\n`,
    BOLD_OFF,
    separator(),
    CENTER,
    `Status: ${data.status}\n`,
    separator(),
    '\n',
    'Signature: ________________\n',
    '\n\n\n',
    CUT,
  );

  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}
