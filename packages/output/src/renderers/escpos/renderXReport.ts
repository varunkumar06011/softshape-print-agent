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
  const tipsAmount = Number(data.tipsAmount || 0);
  const tipsPaidAmount = Number(data.tipsPaidAmount || 0);

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
  cmds.push(padRight('  Cash Collected ', 'Rs.' + Number(data.cashAmount || 0).toFixed(2)));
  cmds.push('\n');
  cmds.push(padRight('  Card Collected ', 'Rs.' + Number(data.cardAmount || 0).toFixed(2)));
  cmds.push('\n');
  cmds.push(padRight('  UPI Collected  ', 'Rs.' + Number(data.upiAmount || 0).toFixed(2)));
  cmds.push('\n');
  cmds.push(padRight('  Other Collected', 'Rs.' + Number(data.otherAmount || 0).toFixed(2)));
  cmds.push('\n');
  cmds.push(separator('-'));

  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle('1. SALES SUMMARY'), BOLD_OFF, '\n', xrBorder(), '\n');
  cmds.push(xrRow('Cash Collected', xrCurrency(data.cashAmount || 0)), '\n');
  cmds.push(xrRow('Card Collected', xrCurrency(data.cardAmount || 0)), '\n');
  cmds.push(xrRow('UPI Collected', xrCurrency(data.upiAmount || 0)), '\n');
  cmds.push(xrRow('Other Collected', xrCurrency(data.otherAmount || 0)), '\n');
  cmds.push(xrBorder(), '\n');
  cmds.push(BOLD_ON, xrRow('TOTAL SALES', xrCurrency(data.totalSales)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  // Tips section — only print if tips were collected.
  if (tipsAmount > 0) {
    cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle('2. TIPS COLLECTED'), BOLD_OFF, '\n', xrBorder(), '\n');
    cmds.push(xrRow('Cash Tips', xrCurrency(data.cashTipsAmount || 0)), '\n');
    cmds.push(xrRow('Card Tips', xrCurrency(data.cardTipsAmount || 0)), '\n');
    cmds.push(xrRow('UPI Tips', xrCurrency(data.upiTipsAmount || 0)), '\n');
    cmds.push(xrRow('Other Tips', xrCurrency(data.otherTipsAmount || 0)), '\n');
    cmds.push(xrBorder(), '\n');
    cmds.push(BOLD_ON, xrRow('TOTAL TIPS', xrCurrency(tipsAmount)), BOLD_OFF, '\n');
    cmds.push(xrBorder(), '\n');
    cmds.push(BOLD_ON, xrRow('TIPS PAID (FROM CASH)', xrCurrency(tipsPaidAmount)), BOLD_OFF, '\n');
    cmds.push(xrBorder(), '\n');
  }

  const expSectionNum = tipsAmount > 0 ? '3' : '2';
  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle(`${expSectionNum}. EXPENDITURE BREAKDOWN`), BOLD_OFF, '\n', xrBorder(), '\n');
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

  const cashSectionNum = tipsAmount > 0 ? '4' : '3';
  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle(`${cashSectionNum}. EXPECTED CASH`), BOLD_OFF, '\n', xrBorder(), '\n');
  const cashExp = data.cashExpenditures != null ? data.cashExpenditures : data.expenditureAmount;
  cmds.push(xrRow('Cash Collected (A)   ', xrCurrency(data.cashAmount || 0)), '\n');
  cmds.push(xrRow('Cash Expenditure (B) ', xrCurrency(cashExp)), '\n');
  if (tipsPaidAmount > 0) {
    cmds.push(xrRow('Tips Paid (C)        ', xrCurrency(tipsPaidAmount)), '\n');
    cmds.push(xrBorder(), '\n');
    cmds.push(BOLD_ON, xrRow('EXPECTED CASH (A-B-C)', xrCurrency(data.finalAmount)), BOLD_OFF, '\n');
  } else {
    cmds.push(xrBorder(), '\n');
    cmds.push(BOLD_ON, xrRow('EXPECTED CASH (A-B)', xrCurrency(data.finalAmount)), BOLD_OFF, '\n');
  }
  cmds.push(xrBorder(), '\n');

  const denomSectionNum = tipsAmount > 0 ? '5' : '4';
  cmds.push(xrBorder(), '\n', BOLD_ON, xrTitle(`${denomSectionNum}. CASH DENOMINATION BREAKDOWN`), BOLD_OFF, '\n', xrBorder(), '\n');
  data.denominations.forEach((d) => {
    if (d.count > 0) {
      const amount = d.value * d.count;
      cmds.push(xrRow(`${d.label} x ${d.count}`, 'Rs.' + amount.toFixed(2)), '\n');
    }
  });
  cmds.push(xrBorder(), '\n');
  cmds.push(BOLD_ON, xrRow('TOTAL CASH COUNTED', xrCurrency(data.cashFromNotes)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  // Variance: cash counted vs expected cash
  const variance = data.variance != null ? data.variance : (data.cashFromNotes - data.finalAmount);
  const varianceLabel = variance >= 0 ? 'OVER' : 'SHORT';
  const varianceAbs = Math.abs(variance);
  cmds.push(BOLD_ON, xrRow(`VARIANCE (${varianceLabel})`, xrCurrency(varianceAbs)), BOLD_OFF, '\n');
  cmds.push(xrBorder(), '\n');

  cmds.push(CENTER, '*** End of Report ***\n');
  cmds.push('\n\n\n');
  cmds.push(CUT);
  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}
