import { describe, it, expect } from 'vitest';
import { renderBill, renderFinalBill } from '../src/index';
import type { BillPrintInput, BillData } from '../src/index';

const TEST_ITEMS = [
  { name: 'Paneer Butter Masala', quantity: 1, price: 240, menuType: 'FOOD' as const },
  { name: 'Butter Naan', quantity: 2, price: 40, menuType: 'FOOD' as const },
  { name: 'Kingfisher Beer', quantity: 1, price: 180, menuType: 'LIQUOR' as const },
];

const TEST_RESTAURANT = {
  name: 'Test Restaurant',
  receiptHeader: 'TEST RESTAURANT',
  receiptSubHeader: null,
  address: null,
  phone: null,
  gstin: '27ABCDE1234F1Z5',
};

const BASE_INPUT: BillPrintInput = {
  tableNumber: 'T5',
  items: TEST_ITEMS,
  totalAmount: 500,
  restaurant: TEST_RESTAURANT,
  sectionTag: null,
  gstCategory: 'NON_AC',
  gstRate: null,
  gstRegistered: true,
  pricesIncludeGst: false,
};

function parseBillAmounts(data: string) {
  return {
    subtotal: parseFloat(data.match(/Subtotal\s+Rs\.([\d.]+)/)?.[1] || '0'),
    cgst: parseFloat(data.match(/CGST\s+Rs\.([\d.]+)/)?.[1] || '0'),
    sgst: parseFloat(data.match(/SGST\s+Rs\.([\d.]+)/)?.[1] || '0'),
    serviceCharge: parseFloat(data.match(/Service Charge\s+\d+%\s+Rs\.([\d.]+)/)?.[1] || '0'),
    discount: parseInt(data.match(/\(-\) Discount\s+\d+%\s*:\s*(\d+)/)?.[1] || '0', 10),
    total: parseFloat(data.match(/TOTAL\s+Rs\.([\d.]+)/)?.[1] || '0'),
  };
}

describe('renderBill GST parity', () => {
  it('GST only (no discount, no service charge)', () => {
    const result = parseBillAmounts(renderBill(BASE_INPUT).blocks[0].data);
    expect(result.subtotal).toBe(500);
    expect(result.cgst).toBeCloseTo(12.5, 2);
    expect(result.sgst).toBeCloseTo(12.5, 2);
    expect(result.serviceCharge).toBe(0);
    expect(result.discount).toBe(0);
    expect(result.total).toBeCloseTo(525, 2);
  });

  it('GST + 10% discount', () => {
    const result = parseBillAmounts(renderBill({ ...BASE_INPUT, discountPercent: 10 }).blocks[0].data);
    expect(result.discount).toBe(50);
    expect(result.total).toBeCloseTo(472.5, 2);
  });

  it('GST + 5% service charge', () => {
    const result = parseBillAmounts(renderBill({ ...BASE_INPUT, serviceChargePercent: 5 }).blocks[0].data);
    expect(result.serviceCharge).toBeCloseTo(26.25, 2);
    expect(result.total).toBeCloseTo(551.25, 2);
  });

  it('GST + 5% service charge + 10% discount', () => {
    const result = parseBillAmounts(renderBill({ ...BASE_INPUT, discountPercent: 10, serviceChargePercent: 5 }).blocks[0].data);
    expect(result.discount).toBe(50);
    expect(result.serviceCharge).toBeCloseTo(23.63, 2);
  });

  it('AC GST rate (18%)', () => {
    const result = parseBillAmounts(renderBill({ ...BASE_INPUT, gstCategory: 'AC' }).blocks[0].data);
    expect(result.cgst).toBeCloseTo(45, 2);
    expect(result.sgst).toBeCloseTo(45, 2);
  });

  it('custom GST rate (12%)', () => {
    const result = parseBillAmounts(renderBill({ ...BASE_INPUT, gstRate: 12 }).blocks[0].data);
    expect(result.cgst).toBeCloseTo(30, 2);
    expect(result.sgst).toBeCloseTo(30, 2);
  });

  it('GST-unregistered (no tax)', () => {
    const result = parseBillAmounts(renderBill({ ...BASE_INPUT, gstRegistered: false, discountPercent: 10 }).blocks[0].data);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
    expect(result.discount).toBe(50);
  });
});

describe('renderFinalBill vs renderBill parity', () => {
  function makeBillData(opts: {
    subtotal: number;
    discount?: { percent: number; amount: number };
    serviceCharge?: { percent: number; amount: number };
    tax: { cgst: number; sgst: number; total: number };
    grandTotal: number;
  }): BillData {
    return {
      billNumber: 'TEST-001',
      date: '12/07/2026',
      time: '09:30 PM',
      tableNumber: 'T1',
      captain: 'Test',
      items: TEST_ITEMS.map((i) => ({
        name: i.name, quantity: i.quantity, price: i.price, amount: i.price * i.quantity, menuType: i.menuType,
      })),
      subtotal: opts.subtotal,
      discount: opts.discount,
      serviceCharge: opts.serviceCharge,
      tax: opts.tax,
      grandTotal: opts.grandTotal,
      section: 'Main Hall',
      itemCount: TEST_ITEMS.length,
      qtyCount: TEST_ITEMS.reduce((s, i) => s + i.quantity, 0),
    };
  }

  it('GST + 5% service charge + 10% discount — totals match (rounded)', () => {
    const totalSubtotal = 500;
    const discountAmount = Math.round(totalSubtotal * 0.1 * 100) / 100;
    const discountedSubtotal = Math.max(0, totalSubtotal - discountAmount);
    const tax = Math.round(discountedSubtotal * 0.05 * 100) / 100;
    const cgst = Math.round(tax / 2 * 100) / 100;
    const sgst = Math.round(tax / 2 * 100) / 100;
    const serviceChargeAmount = Math.round((discountedSubtotal + tax) * 0.05 * 100) / 100;
    const total = Math.round(Math.max(0, discountedSubtotal + tax + serviceChargeAmount) * 100) / 100;

    const billInput: BillPrintInput = {
      items: TEST_ITEMS.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price, menuType: i.menuType })),
      tableNumber: 'T1',
      totalAmount: totalSubtotal,
      restaurantName: 'Test Restaurant',
      gstRate: 5,
      gstRegistered: true,
      pricesIncludeGst: false,
      discountPercent: 10,
      serviceChargePercent: 5,
    } as any;

    const finalBillData = makeBillData({
      subtotal: Math.round(totalSubtotal),
      discount: { percent: 10, amount: Math.round(discountAmount) },
      serviceCharge: { percent: 5, amount: Math.round(serviceChargeAmount) },
      tax: { cgst, sgst, total: tax },
      grandTotal: total,
    });

    const billResult = parseBillAmounts(renderBill(billInput).blocks[0].data);
    const finalBillData2 = renderFinalBill(finalBillData).blocks[0].data;
    const finalSubtotal = parseInt(finalBillData2.match(/Sub Total\s*:\s*(\d+)/)?.[1] || '0');
    const finalTotal = parseInt(finalBillData2.match(/Grand Total\s+(\d+)/)?.[1] || '0');
    const finalSc = parseInt(finalBillData2.match(/Service Charge\s*(\d+)%\s*:\s*(\d+)/)?.[2] || '0');
    const finalDisc = parseInt(finalBillData2.match(/Discount\s*(\d+)%\s*:\s*(\d+)/)?.[2] || '0');

    expect(finalSc).toBe(Math.round(billResult.serviceCharge));
    expect(finalDisc).toBe(Math.round(billResult.discount));
    expect(finalTotal).toBe(Math.round(billResult.total));
    expect(finalSubtotal).toBe(Math.round(billResult.subtotal));
  });
});
