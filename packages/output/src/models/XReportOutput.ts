export interface XReportDenomination {
  label: string;
  value: number;
  count: number;
}

export interface XReportExpenditureRow {
  paidToName: string;
  paidToType: string;
  category?: string | null;
  narration?: string | null;
  approvedByName?: string | null;
  amount: number;
}

export interface XReportData {
  restaurantName?: string;
  reportDate: string;
  cashierName?: string;
  totalSales: number;
  cardAmount: number;
  cashAmount: number;
  upiAmount?: number;
  otherAmount?: number;
  tipsAmount?: number;
  cashTipsAmount?: number;
  cardTipsAmount?: number;
  upiTipsAmount?: number;
  otherTipsAmount?: number;
  tipsPaidAmount?: number;
  expenditureAmount: number;
  cashExpenditures?: number;
  finalAmount: number;
  variance?: number;
  expenditures?: XReportExpenditureRow[];
  denominations: Array<{ label: string; value: number; count: number }>;
  cashFromNotes: number;
}
