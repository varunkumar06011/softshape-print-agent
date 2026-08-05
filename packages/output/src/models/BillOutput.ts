export interface BillPrintRestaurant {
  name?: string;
  receiptHeader?: string | null;
  receiptSubHeader?: string | null;
  address?: string | null;
  phone?: string | null;
  gstin?: string | null;
}

export interface BillData {
  billNumber: string;
  date: string;
  time: string;
  kotNumbers?: string[];
  tableNumber: string;
  captain: string;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    amount: number;
    menuType: "FOOD" | "LIQUOR";
    notes?: string | null;
  }>;
  subtotal: number;
  discount?: { percent: number; amount: number };
  serviceCharge?: { percent: number; amount: number };
  tax: { cgst: number; sgst: number; total: number };
  grandTotal: number;
  roundOff?: number;
  section: string;
  sectionTag?: string;
  itemCount: number;
  qtyCount: number;
  gstIn?: string;
  restaurant?: BillPrintRestaurant;
  isCancelled?: boolean;
  isReprint?: boolean;
}

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
