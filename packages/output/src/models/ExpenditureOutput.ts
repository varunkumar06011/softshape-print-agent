export interface ExpenditurePrintRestaurant {
  name?: string;
  receiptHeader?: string | null;
  receiptSubHeader?: string | null;
  address?: string | null;
  phone?: string | null;
  gstin?: string | null;
}

export interface ExpenditurePrintData {
  expenditureNo: number;
  expenditureDate: string;
  paidToType: string;
  paidToName: string;
  amount: number;
  narration?: string | null;
  approvedByName?: string | null;
  createdByName?: string | null;
  status: string;
  restaurant?: ExpenditurePrintRestaurant;
}
