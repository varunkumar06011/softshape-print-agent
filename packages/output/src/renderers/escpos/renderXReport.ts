import type { XReportData } from "../../models/XReportOutput";
import type { RenderedOutput } from "../../models/RenderedOutput";
import { RENDERER_VERSION } from "./constants";
import {
  INIT, CENTER, LEFT, BOLD_ON, BOLD_OFF,
  SIZE_2X, SIZE_NORMAL, CUT,
} from "./constants";
import { separator, padRight, shortExpenditureType } from "./helpers";

export function renderXReport(data: XReportData): RenderedOutput {
  const cmds: string[] = [];
  const expenditures = data.expenditures || [];

  cmds.push(INIT);
  cmds.push(CENTER, BOLD_ON, SIZE_2X, 'X REPORT\n', BOLD_OFF, SIZE_NORMAL);
  if (data.restaurantName) {
    cmds.push(CENTER, BOLD_ON, `${data.restaurantName.toUpperCase()}\n`, BOLD_OFF);
  }
  cmds.push(CENTER, `Date: ${data.reportDate}\n`);
  if (data.cashierName) {
    cmds.push(CENTER, `Cashier: ${data.cashierName}\n`);
  }
  cmds.push(separator('-'));
  cmds.push(LEFT);

  const XR_W = 40;
  const xrBorder = () => '+' + '-'.repeat(XR_W) + '+';
  const xrTitle = (title: string) => '|' + title.padEnd(XR_W) + '|';
  const padRightLocal = (left: string | number, right: string | number, width: number) => {
    const leftStr = String(left).slice(0, width - String(right).length - 1);
    return leftStr.padEnd(width - String(right).length) + right;
  };
  const xrRow = (label: string, value: string) => '|' + padRightLocal(label, value, XR_W) + '|';
  const xrLine = (text: string) => '|' + text.padEnd(XR_W) + '|';
  const xrCurrency = (n: number) => 'Rs.' + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);

  cmds.push(LEFT, BOLD_ON, padRight('Total Sale', 'Rs.' + Number(data.totalSales).toFixed(2)), BOLD_OFF);
  cmds.push('\n');
  cmds.push(padRight('  Card ', 'Rs.' + Number(data.cardAmount).toFixed(2)));
  cmds.push('\n');
  cmds.push(separator('-'));

  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle('1. SALES SUMMARY'), BOLD_OFF, '\n', xrBorder(), '\n');
  cmds.push(xrRow('Card Sales', xrCurrency(data.cardAmount)), '\n');
  cmds.push(xrBorder(), '\n');
  cmds.push(BOLD_ON, xrRow('TOTAL SALES', xrCurrency(data.totalSales)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle('2. EXPENDITURE BREAKDOWN'), BOLD_OFF, '\n', xrBorder(), '\n');
  if (expenditures.length > 0) {
    expenditures.forEach((v) => {
      const name = (v.paidToName || '').slice(0, 14).padEnd(14);
      const type = shortExpenditureType(v.category || v.paidToType).padEnd(6);
      const amt = ('Rs.' + Number(v.amount).toFixed(2)).padStart(XR_W - 14 - 6);
      cmds.push('|' + name + type + amt + '|', '\n');
      const parts: string[] = [];
      if (v.narration) parts.push(v.narration);
      if (v.approvedByName) parts.push('Appvd: ' + v.approvedByName);
      if (parts.length > 0) {
        const joined = parts.join(' - ');
        const maxContent = 39;
        const text = joined.length > maxContent ? joined.slice(0, maxContent - 3) + '...' : joined;
        cmds.push(xrLine(' ' + text), '\n');
      }
      cmds.push(xrBorder(), '\n');
    });
  }
  cmds.push(BOLD_ON, xrRow('TOTAL EXPENDITURE', xrCurrency(data.expenditureAmount)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle('3. CASH BALANCE'), BOLD_OFF, '\n', xrBorder(), '\n');
  cmds.push(xrRow('Total Sales (A)       ', xrCurrency(data.totalSales)), '\n');
  cmds.push(xrRow('Card Payments (B)   ', xrCurrency(data.cardAmount || 0)), '\n');
  cmds.push(xrRow('Total Expenditure (C)', xrCurrency(data.expenditureAmount)), '\n');
  cmds.push(xrBorder(), '\n');
  cmds.push(BOLD_ON, xrRow('CASH BALANCE (A-B-C)', xrCurrency(data.finalAmount)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle('4. CASH DENOMINATION BREAKDOWN'), BOLD_OFF, '\n', xrBorder(), '\n');
  data.denominations.forEach((d) => {
    if (d.count > 0) {
      const amount = d.value * d.count;
      cmds.push(xrRow(`${d.label} x ${d.count}`, 'Rs.' + amount.toFixed(2)), '\n');
    }
  });
  cmds.push(xrBorder(), '\n');
  cmds.push(BOLD_ON, xrRow('TOTAL CASH COUNTED', xrCurrency(data.cashFromNotes)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  cmds.push(CENTER, '*** End of Report ***\n');
  cmds.push('\n\n\n');
  cmds.push(CUT);
  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}
