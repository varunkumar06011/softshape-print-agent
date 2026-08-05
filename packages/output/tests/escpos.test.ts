import { describe, it, expect } from 'vitest';
import {
  renderFoodKOT,
  renderLiquorKOT,
  renderCancelKOT,
  renderTableSwap,
  renderFinalBill,
  renderBill,
  renderExpenditure,
  renderXReport,
  renderReceipt,
  render,
} from '../src/index';
import type { OrderData, BillData, BillPrintInput, CancelKotPrintInput, TableSwapPrintInput, ExpenditurePrintData, XReportData } from '../src/index';

// ── Test data ─────────────────────────────────────────────────────────────────

const TEST_ITEMS = [
  { name: 'Paneer Butter Masala', quantity: 1, price: 240, type: 'food' as const },
  { name: 'Butter Naan', quantity: 2, price: 40, type: 'food' as const },
  { name: 'Kingfisher Beer', quantity: 1, price: 180, type: 'liquor' as const },
];

const TEST_ORDER: OrderData = {
  tableNumber: 'T5',
  orderId: 'ORD-ABC123',
  items: TEST_ITEMS,
  restaurantName: 'Test Restaurant',
  kotId: 'KOT-01',
  captainName: 'Ravi',
  orderByRole: 'CAPTAIN',
  sectionName: 'Main Hall',
  sectionTag: 'bar',
};

const TEST_RESTAURANT = {
  name: 'Test Restaurant',
  receiptHeader: 'TEST RESTAURANT',
  receiptSubHeader: null,
  address: null,
  phone: null,
  gstin: '27ABCDE1234F1Z5',
};

// ── KOT tests ─────────────────────────────────────────────────────────────────

describe('renderFoodKOT', () => {
  it('produces a single raw block with ESC/POS data', () => {
    const result = renderFoodKOT(TEST_ORDER);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('raw');
    expect(result.blocks[0].format).toBe('plain');
    expect(result.rendererVersion).toBe(1);
    expect(result.format).toBe('escpos');
  });

  it('contains header, KOT number, table, and items', () => {
    const data = renderFoodKOT(TEST_ORDER).blocks[0].data;
    expect(data).toContain('TEST RESTAURANT');
    expect(data).toContain('KOT No : KOT-01');
    expect(data).toContain('Table : 5');
    expect(data).toContain('PANEER BUTTER MASALA');
    expect(data).toContain('BUTTER NAAN');
    expect(data).toContain('Kitchen Order Ticket');
  });

  it('excludes liquor items from food KOT', () => {
    const data = renderFoodKOT(TEST_ORDER).blocks[0].data;
    expect(data).not.toContain('KINGFISHER');
  });

  it('returns empty blocks when no food items', () => {
    const liquorOnly: OrderData = { ...TEST_ORDER, items: [{ name: 'Beer', quantity: 1, price: 180, type: 'liquor' }] };
    expect(renderFoodKOT(liquorOnly).blocks).toHaveLength(0);
  });

  it('strips B/T prefix from table number for non-venue sections', () => {
    const data = renderFoodKOT({ ...TEST_ORDER, tableNumber: 'B3', sectionTag: 'bar' }).blocks[0].data;
    expect(data).toContain('Table : 3');
  });

  it('keeps table label as-is for venue sections', () => {
    const data = renderFoodKOT({ ...TEST_ORDER, tableNumber: 'A1', sectionTag: 'venue-family-restaurant' }).blocks[0].data;
    expect(data).toContain('Table : A1');
  });
});

describe('renderLiquorKOT', () => {
  it('contains liquor items and bar order ticket', () => {
    const data = renderLiquorKOT(TEST_ORDER).blocks[0].data;
    expect(data).toContain('KINGFISHER BEER');
    expect(data).toContain('Bar Order Ticket');
  });

  it('excludes food items from liquor KOT', () => {
    const data = renderLiquorKOT(TEST_ORDER).blocks[0].data;
    expect(data).not.toContain('PANEER');
  });

  it('returns empty blocks when no liquor items', () => {
    const foodOnly: OrderData = { ...TEST_ORDER, items: [{ name: 'Rice', quantity: 1, price: 100, type: 'food' }] };
    expect(renderLiquorKOT(foodOnly).blocks).toHaveLength(0);
  });
});

// ── Bill tests ────────────────────────────────────────────────────────────────

describe('renderFinalBill', () => {
  const billData: BillData = {
    billNumber: '23/07/26-042',
    date: '23/07/2026',
    time: '08:30 PM',
    tableNumber: 'T5',
    captain: 'Ravi',
    items: [
      { name: 'Paneer Butter Masala', quantity: 1, price: 240, amount: 240, menuType: 'FOOD' },
      { name: 'Butter Naan', quantity: 2, price: 40, amount: 80, menuType: 'FOOD' },
      { name: 'Kingfisher Beer', quantity: 1, price: 180, amount: 180, menuType: 'LIQUOR' },
    ],
    subtotal: 500,
    tax: { cgst: 12.5, sgst: 12.5, total: 25 },
    grandTotal: 525,
    section: 'Main Hall',
    itemCount: 3,
    qtyCount: 4,
    restaurant: TEST_RESTAURANT,
  };

  it('produces a single raw block', () => {
    const result = renderFinalBill(billData);
    expect(result.blocks).toHaveLength(1);
    expect(result.rendererVersion).toBe(1);
  });

  it('contains venue name, bill number, table, items, and totals', () => {
    const data = renderFinalBill(billData).blocks[0].data;
    expect(data).toContain('TEST RESTAURANT');
    expect(data).toContain('Bill No : 23/07/26-042');
    expect(data).toContain('Table: 5');
    expect(data).toContain('PANEER BUTTER MASALA');
    expect(data).toContain('Sub Total');
    expect(data).toContain('Grand Total');
    expect(data).toContain('525');
  });

  it('renders cancelled stamp when isCancelled is true', () => {
    const data = renderFinalBill({ ...billData, isCancelled: true }).blocks[0].data;
    expect(data).toContain('CANCELLED BILL');
    expect(data).toContain('** CANCELLED **');
  });

  it('renders reprint stamp when isReprint is true', () => {
    const data = renderFinalBill({ ...billData, isReprint: true }).blocks[0].data;
    expect(data).toContain('REPRINT BILL');
    expect(data).toContain('** REPRINT **');
  });

  it('renders GST breakdown when tax.total > 0', () => {
    const data = renderFinalBill(billData).blocks[0].data;
    expect(data).toContain('CGST');
    expect(data).toContain('SGST');
  });

  it('omits GST when tax.total is 0', () => {
    const data = renderFinalBill({ ...billData, tax: { cgst: 0, sgst: 0, total: 0 } }).blocks[0].data;
    expect(data).not.toMatch(/CGST\s*:/);
  });
});

describe('renderBill (simple bill)', () => {
  const billInput: BillPrintInput = {
    tableNumber: 'T5',
    items: [
      { name: 'Paneer Butter Masala', quantity: 1, price: 240, menuType: 'FOOD' },
      { name: 'Kingfisher Beer', quantity: 1, price: 180, menuType: 'LIQUOR' },
    ],
    totalAmount: 420,
    restaurant: TEST_RESTAURANT,
    sectionTag: null,
    gstCategory: 'NON_AC',
    gstRate: null,
    gstRegistered: true,
    pricesIncludeGst: false,
  };

  it('produces a single raw block', () => {
    const result = renderBill(billInput);
    expect(result.blocks).toHaveLength(1);
  });

  it('contains BILL RECEIPT header, items, subtotal, and total', () => {
    const data = renderBill(billInput).blocks[0].data;
    expect(data).toContain('BILL RECEIPT');
    expect(data).toContain('Paneer Butter Masala');
    expect(data).toContain('Subtotal');
    expect(data).toContain('TOTAL');
    expect(data).toContain('Rs.');
  });

  it('renders GST breakdown when tax > 0', () => {
    const data = renderBill(billInput).blocks[0].data;
    expect(data).toContain('CGST');
    expect(data).toContain('SGST');
  });

  it('renders discount line when discountPercent > 0', () => {
    const data = renderBill({ ...billInput, discountPercent: 10 }).blocks[0].data;
    expect(data).toContain('(-) Discount 10%');
  });

  it('renders service charge line when serviceChargePercent > 0', () => {
    const data = renderBill({ ...billInput, serviceChargePercent: 5 }).blocks[0].data;
    expect(data).toContain('Service Charge 5%');
  });
});

// ── Cancel KOT tests ──────────────────────────────────────────────────────────

describe('renderCancelKOT', () => {
  const cancelInput: CancelKotPrintInput = {
    tableNumber: 'T5',
    cancelledBy: 'Ravi',
    timestamp: '2026-07-23T15:00:00Z',
    items: [
      { name: 'Paneer Butter Masala', quantity: 1, menuType: 'FOOD' },
      { name: 'Butter Naan', quantity: 2, menuType: 'FOOD' },
    ],
    sectionName: 'Main Hall',
    sectionTag: 'bar',
    restaurant: TEST_RESTAURANT,
  };

  it('produces a single raw block', () => {
    const result = renderCancelKOT(cancelInput);
    expect(result.blocks).toHaveLength(1);
  });

  it('contains CANCEL ORDER header, table, items, and CANCELLED stamp', () => {
    const data = renderCancelKOT(cancelInput).blocks[0].data;
    expect(data).toContain('TEST RESTAURANT');
    expect(data).toContain('CANCEL ORDER');
    expect(data).toContain('Table : 5');
    expect(data).toContain('PANEER BUTTER MASALA');
    expect(data).toContain('CANCELLED');
    expect(data).toContain('Cancel Order Ticket');
  });

  it('renders single item differently from multiple items', () => {
    const singleItem = renderCancelKOT({ ...cancelInput, items: [{ name: 'Rice', quantity: 1 }] }).blocks[0].data;
    expect(singleItem).toContain('Type  : Food Item');
  });

  it('shows Bar Item type for BAR menuType', () => {
    const barItem = renderCancelKOT({ ...cancelInput, items: [{ name: 'Beer', quantity: 1, menuType: 'BAR' }] }).blocks[0].data;
    expect(barItem).toContain('Type  : Bar Item');
  });
});

// ── Table Swap tests ──────────────────────────────────────────────────────────

describe('renderTableSwap', () => {
  const swapInput: TableSwapPrintInput = {
    fromTableNumber: 'T5',
    toTableNumber: 'T10',
    swappedBy: 'Ravi',
    timestamp: '2026-07-23T15:00:00Z',
  };

  it('produces a single raw block', () => {
    const result = renderTableSwap(swapInput);
    expect(result.blocks).toHaveLength(1);
  });

  it('contains TABLE MOVED header, from/to tables, and staff name', () => {
    const data = renderTableSwap(swapInput).blocks[0].data;
    expect(data).toContain('TABLE MOVED');
    expect(data).toContain('From  : Table T5');
    expect(data).toContain('To    : Table T10');
    expect(data).toContain('By    : Ravi');
    expect(data).toContain('Session transferred');
  });
});

// ── Expenditure tests ─────────────────────────────────────────────────────────

describe('renderExpenditure', () => {
  const expData: ExpenditurePrintData = {
    expenditureNo: 1,
    expenditureDate: '2026-07-06',
    paidToType: 'STAFF',
    paidToName: 'Raja behar',
    amount: 500,
    narration: 'Test advance',
    approvedByName: 'Admin User',
    status: 'UNVERIFIED',
    restaurant: { name: 'Test Restaurant' },
  };

  it('produces a single raw block', () => {
    const result = renderExpenditure(expData);
    expect(result.blocks).toHaveLength(1);
  });

  it('contains expenditure details and amount in words', () => {
    const data = renderExpenditure(expData).blocks[0].data;
    expect(data).toContain('CASH EXPENDITURE');
    expect(data).toContain('Exp No     : 1');
    expect(data).toContain('Paid To    : Raja behar');
    expect(data).toContain('Approved By: Admin User');
    expect(data).toContain('Five Hundred Rupees Only');
  });

  it('omits approvedBy line when no approver', () => {
    const data = renderExpenditure({ ...expData, approvedByName: undefined }).blocks[0].data;
    expect(data).not.toContain('Approved By:');
  });
});

// ── X Report tests ────────────────────────────────────────────────────────────

describe('renderXReport', () => {
  const xReportData: XReportData = {
    restaurantName: 'Test Restaurant',
    reportDate: '23/07/2026',
    cashierName: 'Ravi',
    totalSales: 5000,
    cardAmount: 2000,
    cashAmount: 3000,
    expenditureAmount: 500,
    finalAmount: 2500,
    expenditures: [
      { paidToName: 'Staff A', paidToType: 'STAFF', amount: 300 },
      { paidToName: 'Kitchen B', paidToType: 'KITCHEN', amount: 200 },
    ],
    denominations: [
      { label: 'Rs.2000', value: 2000, count: 1 },
      { label: 'Rs.500', value: 500, count: 1 },
    ],
    cashFromNotes: 2500,
  };

  it('produces a single raw block', () => {
    const result = renderXReport(xReportData);
    expect(result.blocks).toHaveLength(1);
  });

  it('contains X REPORT header, sections, and totals', () => {
    const data = renderXReport(xReportData).blocks[0].data;
    expect(data).toContain('X REPORT');
    expect(data).toContain('TEST RESTAURANT');
    expect(data).toContain('1. SALES SUMMARY');
    expect(data).toContain('2. EXPENDITURE BREAKDOWN');
    expect(data).toContain('3. CASH BALANCE');
    expect(data).toContain('4. CASH DENOMINATION BREAKDOWN');
    expect(data).toContain('TOTAL SALES');
    expect(data).toContain('CASH BALANCE');
    expect(data).toContain('End of Report');
  });
});

// ── Receipt tests ─────────────────────────────────────────────────────────────

describe('renderReceipt', () => {
  it('produces a receipt with food and liquor sections', () => {
    const result = renderReceipt(TEST_ORDER, { cgst: 12.5, sgst: 12.5, total: 25 });
    expect(result.blocks).toHaveLength(1);
    const data = result.blocks[0].data;
    expect(data).toContain('Test Restaurant');
    expect(data).toContain('FOOD');
    expect(data).toContain('LIQUOR');
    expect(data).toContain('Food Subtota');
    expect(data).toContain('Liquor Subto');
    expect(data).toContain('CGST');
    expect(data).toContain('SGST');
    expect(data).toContain('TOTAL');
  });
});

// ── Registry tests ────────────────────────────────────────────────────────────

describe('renderer registry', () => {
  it('resolves all registered intent types', () => {
    expect(render('PRINT_KOT', TEST_ORDER as any)).not.toBeNull();
    expect(render('PRINT_LIQUOR_KOT', TEST_ORDER as any)).not.toBeNull();
    expect(render('PRINT_BILL', {} as any)).not.toBeNull();
    expect(render('PRINT_CANCEL_KOT', {} as any)).not.toBeNull();
    expect(render('PRINT_TABLE_SWAP', {} as any)).not.toBeNull();
    expect(render('PRINT_X_REPORT', {
      restaurantName: 'Test',
      reportDate: '23/07/2026',
      totalSales: 1000, cardAmount: 500, cashAmount: 500,
      expenditureAmount: 100, finalAmount: 400,
      denominations: [{ label: 'Rs.500', value: 500, count: 1 }],
      cashFromNotes: 500,
    } as any)).not.toBeNull();
    expect(render('PRINT_EXPENDITURE', {
      expenditureNo: 1, expenditureDate: '23/07/2026',
      paidToType: 'STAFF', paidToName: 'Test', amount: 100, status: 'UNVERIFIED',
    } as any)).not.toBeNull();
    expect(render('PRINT_RECEIPT', { ...TEST_ORDER, tax: { cgst: 0, sgst: 0, total: 0 } } as any)).not.toBeNull();
  });

  it('returns null for unregistered intent', () => {
    expect(render('REPRINT_KOT' as any, {})).toBeNull();
  });
});
