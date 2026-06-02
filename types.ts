export interface InventoryBatch {
  id: string; // uniquely identifies this batch instance in the warehouse
  sku: string;
  name: string;
  lot: string;
  expiryDate: string; // Format: YYYY-MM-DD
  quantity: number;
  createdAt: string;
  sstRequired?: boolean; // Whether SST testing is required for safety
  sstPassed?: boolean;   // Whether local SST test has passed/completed successfully
  sstCompletedDate?: string; // Date SST was completed
}

export interface InventoryItem {
  sku: string;
  name: string;
  totalQuantity: number;
  batches: InventoryBatch[];
}

export interface MovementLog {
  id: string;
  timestamp: string;
  type: 'STOCK_IN' | 'STOCK_OUT' | 'STOCK_OUT_OVERRIDE' | 'WASTE';
  sku: string;
  name: string;
  lot: string;
  expiryDate: string;
  quantity: number;
  notes?: string;
}

export interface QRLabelData {
  sku: string;
  name: string;
  lot: string;
  exp: string; // YYYY-MM-DD
  type: 'FEFO_LABEL';
  labelId?: string; // Unique ID to track individual item label checkouts: batchId-item-1, etc.
  itemIndex?: number;
  totalItems?: number;
}

export interface ProductProfile {
  sku: string;
  name: string;
  brand?: string;
  safetyStock: number;
  sstRequired: boolean;
  unitsPerBox?: number;
}
