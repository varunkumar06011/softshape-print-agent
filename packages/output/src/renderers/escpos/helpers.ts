import { LINE_NORMAL, LINE_WIDTH } from "./constants";

export function separator(ch = "-"): string {
  return ch.repeat(LINE_NORMAL) + "\n";
}

export function pad(str: string | number, len: number): string {
  return String(str).padEnd(len);
}

export function padRight(left: string | number, right: string | number, width = LINE_NORMAL): string {
  const leftStr = String(left).slice(0, width - String(right).length - 1);
  return leftStr.padEnd(width - String(right).length) + right;
}

export function formatItemLine(label: string, valueStr: string, width = LINE_NORMAL): string {
  const available = width - valueStr.length;
  return label.substring(0, available).padEnd(available) + valueStr + "\n";
}

export function formatTxnDisplayId(txnDate?: string, txnNumber?: number): string {
  if (!txnDate || !txnNumber) return "";
  const [year, month, day] = txnDate.split("-");
  const datePart = `${day}/${month}/${year.slice(-2)}`;
  const seqPart = String(txnNumber).padStart(3, "0");
  return `${datePart}-${seqPart}`;
}

export function formatNow(): { date: string; time: string } {
  const now = new Date();
  const date = now.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  const time = now.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
  return { date, time };
}

export function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 3) + "..." : text;
}

export function getEffectiveGstRate(
  gstRate: number | null | undefined,
  gstCategory: string | null | undefined,
  gstRegistered: boolean | null | undefined,
): number {
  if (gstRegistered === false) return 0;
  if (gstRate != null && gstRate > 0) return gstRate;
  const category = (gstCategory || 'NON_AC').toUpperCase();
  return category === 'AC' ? 18 : 5;
}

export function getGstBreakdownWithRate(
  taxableAmount: number,
  ratePercent: number,
  _pricesIncludeGst?: boolean,
): { cgst: number; sgst: number; tax: number; baseAmount: number } {
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

export function numberToWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
    'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function twoDigits(n: number): string {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  }

  function threeDigits(n: number): string {
    const h = Math.floor(n / 100);
    const r = n % 100;
    let str = '';
    if (h > 0) str += ones[h] + ' Hundred';
    if (r > 0) str += (h > 0 ? ' ' : '') + twoDigits(r);
    return str;
  }

  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);

  function indianWords(n: number): string {
    if (n === 0) return 'Zero';
    let result = '';
    const crore = Math.floor(n / 10000000);
    n %= 10000000;
    const lakh = Math.floor(n / 100000);
    n %= 100000;
    const thousand = Math.floor(n / 1000);
    n %= 1000;
    const remainder = n;

    if (crore > 0) result += threeDigits(crore) + ' Crore ';
    if (lakh > 0) result += twoDigits(lakh) + ' Lakh ';
    if (thousand > 0) result += twoDigits(thousand) + ' Thousand ';
    if (remainder > 0) result += threeDigits(remainder);
    return result.trim();
  }

  let words = indianWords(rupees) + ' Rupees';
  if (paise > 0) {
    words += ' and ' + twoDigits(paise) + ' Paise';
  }
  words += ' Only';
  return words;
}

export function shortExpenditureType(categoryOrType?: string | null): string {
  const t = (categoryOrType || '').toUpperCase();
  if (t === 'STAFF') return 'STAFF';
  if (t === 'KITCHEN') return 'KTCH';
  if (t === 'MISCELLANEOUS' || t === 'OTHER') return 'MISC';
  return t.slice(0, 6);
}
