import type { BillPrintRestaurant } from "./BillOutput";

export interface CancelKotItem {
  name: string;
  quantity: number;
  menuType?: string;
}

export interface CancelKotPrintInput {
  tableNumber: string | number;
  cancelledBy: string;
  timestamp: string;
  items: CancelKotItem[];
  sectionName?: string;
  sectionTag?: string | null;
  restaurant?: BillPrintRestaurant;
}
