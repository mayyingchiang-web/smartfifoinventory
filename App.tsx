import React, { useState, useEffect, FormEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Package, 
  ArrowDownRight, 
  ArrowUpRight, 
  LayoutDashboard, 
  PlusCircle, 
  MinusCircle, 
  FileText, 
  Printer,
  X,
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  Info,
  Database,
  Camera,
  Search
} from 'lucide-react';

import { InventoryBatch, MovementLog, QRLabelData, ProductProfile } from './types';
import { INITIAL_BATCHES } from './initialData';
import ProductProfiles from './components/ProductProfiles';
import { validateFEFOStockOut, computeInventoryLevels, getExpiryStatus } from './utils/fefo';

import QRScanner from './components/QRScanner';
import QRGenerator from './components/QRGenerator';
import StockDashboard from './components/StockDashboard';
import MovementLogs from './components/MovementLogs';
import CustomDialog from './components/CustomDialog';

import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, onSnapshot, doc, deleteDoc, getDocFromServer, DocumentReference, setDoc as firebaseSetDoc } from 'firebase/firestore';
import { db, auth, googleProvider, handleFirestoreError, OperationType } from './firebase';

export default function App() {
  // 1. Core Auth States
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Custom setDoc shadowing to support local guest simulator fallback when Google auth is unconfigured or errors
  const setDoc = async (docRef: DocumentReference, data: any) => {
    if (user && user.uid === 'mock-operator-uid') {
      const pathParts = docRef.path.split('/');
      const collectionName = pathParts[0] as 'batches' | 'logs' | 'productProfiles';
      const docId = pathParts[1];

      if (collectionName === 'batches') {
        setBatches(prev => {
          const idx = prev.findIndex(b => b.id === docId);
          let next;
          if (idx > -1) {
            next = [...prev];
            next[idx] = data;
          } else {
            next = [...prev, data];
          }
          localStorage.setItem('FEFO_INVENTORY_BATCHES', JSON.stringify(next));
          return next;
        });
      } else if (collectionName === 'logs') {
        setLogs(prev => {
          const idx = prev.findIndex(l => l.id === docId);
          let next;
          if (idx > -1) {
            next = [...prev];
            next[idx] = data;
          } else {
            next = [data, ...prev];
          }
          next.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          localStorage.setItem('FEFO_INVENTORY_LOGS', JSON.stringify(next));
          return next;
        });
      } else if (collectionName === 'productProfiles') {
        setProductProfiles(prev => {
          const idx = prev.findIndex(p => p.sku === docId);
          let next;
          if (idx > -1) {
            next = [...prev];
            next[idx] = data;
          } else {
            next = [...prev, data];
          }
          localStorage.setItem('FEFO_PRODUCT_PROFILES', JSON.stringify(next));
          return next;
        });
      }
    } else {
      await firebaseSetDoc(docRef, data);
    }
  };

  // 2. Real-time synchronised medical database arrays
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [logs, setLogs] = useState<MovementLog[]>([]);
  const [productProfiles, setProductProfiles] = useState<ProductProfile[]>([]);
  
  const [activeTab, setActiveTab] = useState<'DASHBOARD' | 'STOCK_IN' | 'STOCK_OUT' | 'LOGS' | 'PRODUCTS'>('DASHBOARD');

  // Monitor authentications
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Database Seed routine for fresh deployments
  const seedFirestore = async () => {
    try {
      const customSafetyLimits: Record<string, number> = {
        'K-MPIP-3130': 3,
        'K-HPIP-2130': 3,
        'HEPA-FILTER': 2,
        'PHP-38014': 5,
        'CN200115': 4
      };

      const guessUnitsPerBox = (sku: string, name: string): number => {
        const upperSku = sku.toUpperCase();
        const upperName = name.toUpperCase();
        if (upperSku.startsWith('K-') || upperName.includes('PIPETTE')) return 10;
        if (upperSku.includes('HEPA') || upperName.includes('FILTER')) return 5;
        if (upperSku.startsWith('PHP') || upperName.includes('PAPER')) return 100;
        if (upperSku.startsWith('CN200') || upperName.includes('BOTTLE')) return 12;
        if (upperSku.startsWith('354') || upperName.includes('CONTAINER')) return 50;
        return 10;
      };

      const guessBrand = (sku: string, name: string): string => {
        const upperSku = sku.toUpperCase();
        const upperName = name.toUpperCase();
        if (upperSku.startsWith('K-') || upperName.includes('ICSI') || upperName.includes('PIPETTE')) return 'Vitrolife';
        if (upperSku.startsWith('300') || upperName.includes('TIP') || upperName.includes('PIP')) return 'Eppendorf';
        if (upperSku.startsWith('150') || upperName.includes('DISH') || upperName.includes('PLATE')) return 'Falcon';
        if (upperSku.startsWith('352') || upperSku.startsWith('353') || upperSku.startsWith('354') || upperName.includes('TUBE') || upperName.includes('BOTTLE') || upperName.includes('CONTAINER')) return 'BD Falcon';
        if (upperSku.includes('HEPA') || upperName.includes('FILTER')) return 'Air Science';
        if (upperSku.includes('G267') || upperName.includes('FLEXIPET')) return 'Cook Medical';
        return 'Cook Medical';
      };

      const defaultProfiles: ProductProfile[] = [];
      const seenSkus = new Set<string>();
      INITIAL_BATCHES.forEach(batch => {
        const skuUpper = batch.sku.toUpperCase();
        if (!seenSkus.has(skuUpper)) {
          seenSkus.add(skuUpper);
          defaultProfiles.push({
            sku: batch.sku,
            name: batch.name,
            brand: guessBrand(batch.sku, batch.name),
            safetyStock: customSafetyLimits[skuUpper] !== undefined ? customSafetyLimits[skuUpper] : 5,
            sstRequired: !!batch.sstRequired,
            unitsPerBox: guessUnitsPerBox(batch.sku, batch.name)
          });
        }
      });

      // Seeding in parallel sequences
      for (const p of defaultProfiles) {
        await setDoc(doc(db, 'productProfiles', p.sku), p);
      }
      for (const b of INITIAL_BATCHES) {
        await setDoc(doc(db, 'batches', b.id), b);
      }

      const seedLogs: MovementLog[] = [
        {
          id: 'log-seed-sci-1',
          timestamp: new Date('2025-11-23T09:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'PHP-38014',
          name: 'pH paper',
          lot: '38014',
          expiryDate: '2028-02-29',
          quantity: 1,
          notes: 'Received in Andrology lab by GT. Condition: Room Temperature.'
        },
        {
          id: 'log-seed-sci-2',
          timestamp: new Date('2025-04-22T10:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 1,
          notes: 'Initial single unit filter receipt.'
        },
        {
          id: 'log-seed-sci-3',
          timestamp: new Date('2025-04-22T15:00:00Z').toISOString(),
          type: 'STOCK_OUT',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 1,
          notes: 'Standard stock out dispatch by GT.'
        },
        {
          id: 'log-seed-sci-4',
          timestamp: new Date('2025-05-07T09:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 6,
          notes: 'Bulk stock receipt of 6 units.'
        },
        {
          id: 'log-seed-sci-5',
          timestamp: new Date('2025-05-21T11:30:00Z').toISOString(),
          type: 'STOCK_OUT',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 2,
          notes: 'Dispatched to Cleanroom by GT under Standard Operating Procedures.'
        },
        {
          id: 'log-seed-sci-6',
          timestamp: new Date('2026-01-09T09:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'CN200115',
          name: 'CN200115 - Sterilized Bottle Assembly',
          lot: 'G012057',
          expiryDate: '2028-08-09',
          quantity: 6,
          notes: 'Received in Lab Office by MC. Packaging Integrity: Good.'
        }
      ];

      for (const l of seedLogs) {
        await setDoc(doc(db, 'logs', l.id), l);
      }
    } catch (err) {
      console.error('Failure seeding cloud metadata tables.', err);
    }
  };

  // Real-time listener hooks
  useEffect(() => {
    if (!user) return;

    if (user.uid === 'mock-operator-uid') {
      // Offline Guest Sandbox: Read from localStorage or use initial seed data
      const defaultProfiles: ProductProfile[] = [];
      const seenSkus = new Set<string>();
      const customSafetyLimits: Record<string, number> = {
        'K-MPIP-3130': 3,
        'K-HPIP-2130': 3,
        'HEPA-FILTER': 2,
        'PHP-38014': 5,
        'CN200115': 4
      };
      const guessUnitsPerBox = (sku: string, name: string): number => {
        const upperSku = sku.toUpperCase();
        const upperName = name.toUpperCase();
        if (upperSku.startsWith('K-') || upperName.includes('PIPETTE')) return 10;
        if (upperSku.includes('HEPA') || upperName.includes('FILTER')) return 5;
        if (upperSku.startsWith('PHP') || upperName.includes('PAPER')) return 100;
        if (upperSku.startsWith('CN200') || upperName.includes('BOTTLE')) return 12;
        if (upperSku.startsWith('354') || upperName.includes('CONTAINER')) return 50;
        return 10;
      };
      const guessBrand = (sku: string, name: string): string => {
        const upperSku = sku.toUpperCase();
        const upperName = name.toUpperCase();
        if (upperSku.startsWith('K-') || upperName.includes('ICSI') || upperName.includes('PIPETTE')) return 'Vitrolife';
        if (upperSku.startsWith('300') || upperName.includes('TIP') || upperName.includes('PIP')) return 'Eppendorf';
        if (upperSku.startsWith('150') || upperName.includes('DISH') || upperName.includes('PLATE')) return 'Falcon';
        if (upperSku.startsWith('352') || upperSku.startsWith('353') || upperSku.startsWith('354') || upperName.includes('TUBE') || upperName.includes('BOTTLE') || upperName.includes('CONTAINER')) return 'BD Falcon';
        if (upperSku.includes('HEPA') || upperName.includes('FILTER')) return 'Air Science';
        if (upperSku.includes('G267') || upperName.includes('FLEXIPET')) return 'Cook Medical';
        return 'Cook Medical';
      };

      INITIAL_BATCHES.forEach(batch => {
        const skuUpper = batch.sku.toUpperCase();
        if (!seenSkus.has(skuUpper)) {
          seenSkus.add(skuUpper);
          defaultProfiles.push({
            sku: batch.sku,
            name: batch.name,
            brand: guessBrand(batch.sku, batch.name),
            safetyStock: customSafetyLimits[skuUpper] !== undefined ? customSafetyLimits[skuUpper] : 5,
            sstRequired: !!batch.sstRequired,
            unitsPerBox: guessUnitsPerBox(batch.sku, batch.name)
          });
        }
      });

      const localProfiles = localStorage.getItem('FEFO_PRODUCT_PROFILES');
      let finalProfiles = defaultProfiles;
      if (localProfiles) {
        try {
          const parsed = JSON.parse(localProfiles);
          if (Array.isArray(parsed) && parsed.length > 0) {
            finalProfiles = parsed;
          }
        } catch (e) {
          console.error(e);
        }
      }
      setProductProfiles(finalProfiles);

      const localBatches = localStorage.getItem('FEFO_INVENTORY_BATCHES');
      let finalBatches = INITIAL_BATCHES;
      if (localBatches) {
        try {
          const parsed = JSON.parse(localBatches);
          if (Array.isArray(parsed) && parsed.length > 0) {
            finalBatches = parsed;
          }
        } catch (e) {
          console.error(e);
        }
      }
      setBatches(finalBatches);

      const localLogs = localStorage.getItem('FEFO_INVENTORY_LOGS');
      let finalLogs = [
        {
          id: 'log-seed-sci-1',
          timestamp: new Date('2025-11-23T09:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'PHP-38014',
          name: 'pH paper',
          lot: '38014',
          expiryDate: '2028-02-29',
          quantity: 1,
          notes: 'Received in Andrology lab by GT. Condition: Room Temperature.'
        },
        {
          id: 'log-seed-sci-2',
          timestamp: new Date('2025-04-22T10:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 1,
          notes: 'Initial single unit filter receipt.'
        },
        {
          id: 'log-seed-sci-3',
          timestamp: new Date('2025-04-22T15:00:00Z').toISOString(),
          type: 'STOCK_OUT',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 1,
          notes: 'Standard stock out dispatch by GT.'
        },
        {
          id: 'log-seed-sci-4',
          timestamp: new Date('2025-05-07T09:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 6,
          notes: 'Bulk stock receipt of 6 units.'
        },
        {
          id: 'log-seed-sci-5',
          timestamp: new Date('2025-05-21T11:30:00Z').toISOString(),
          type: 'STOCK_OUT',
          sku: 'HEPA-FILTER',
          name: 'HEPA Inline Filter',
          lot: '2023/06ES001',
          expiryDate: '2028-06-01',
          quantity: 2,
          notes: 'Dispatched to Cleanroom by GT under Standard Operating Procedures.'
        },
        {
          id: 'log-seed-sci-6',
          timestamp: new Date('2026-01-09T09:00:00Z').toISOString(),
          type: 'STOCK_IN',
          sku: 'CN200115',
          name: 'CN200115 - Sterilized Bottle Assembly',
          lot: 'G012057',
          expiryDate: '2028-08-09',
          quantity: 6,
          notes: 'Received in Lab Office by MC. Packaging Integrity: Good.'
        }
      ] as MovementLog[];
      if (localLogs) {
        try {
          const parsed = JSON.parse(localLogs);
          if (Array.isArray(parsed) && parsed.length > 0) {
            finalLogs = parsed;
          }
        } catch (e) {
          console.error(e);
        }
      }
      finalLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setLogs(finalLogs);
      return;
    }

    // Call getFromServer to test the connection per critical constraint
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    // 1. Listen for profiles
    const unsubProfiles = onSnapshot(collection(db, 'productProfiles'), (snapshot) => {
      if (snapshot.empty) {
        seedFirestore();
        return;
      }
      const list: ProductProfile[] = [];
      snapshot.forEach(docSnap => {
        list.push(docSnap.data() as ProductProfile);
      });
      setProductProfiles(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'productProfiles');
    });

    // 2. Listen for batches
    const unsubBatches = onSnapshot(collection(db, 'batches'), (snapshot) => {
      const list: InventoryBatch[] = [];
      snapshot.forEach(docSnap => {
        list.push(docSnap.data() as InventoryBatch);
      });
      setBatches(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'batches');
    });

    // 3. Listen for logs
    const unsubLogs = onSnapshot(collection(db, 'logs'), (snapshot) => {
      const list: MovementLog[] = [];
      snapshot.forEach(docSnap => {
        list.push(docSnap.data() as MovementLog);
      });
      // Sort logs desc
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setLogs(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'logs');
    });

    return () => {
      unsubProfiles();
      unsubBatches();
      unsubLogs();
    };
  }, [user]);

  // Sync safetyStocks locally of the registered profiles
  useEffect(() => {
    setSafetyStocks(prev => {
      let changed = false;
      const updated = { ...prev };
      productProfiles.forEach(p => {
        if (updated[p.sku] === undefined) {
          updated[p.sku] = p.safetyStock;
          changed = true;
        }
      });
      return changed ? updated : prev;
    });
  }, [productProfiles]);

  const handleQuickStockIn = (sku: string) => {
    const profile = productProfiles.find(p => p.sku === sku);
    setScannedInResult({
      sku: sku,
      name: profile ? profile.name : '',
      lot: '',
      expiryDate: '',
      quantity: 1,
      isRawBarcode: true,
      sstRequired: profile ? profile.sstRequired : false,
      sstPassed: false
    });
    setActiveTab('STOCK_IN');
  };

  const handleAddProfile = async (profile: ProductProfile, initialBatch?: { lot: string; expiryDate: string; quantity: number }) => {
    try {
      await setDoc(doc(db, 'productProfiles', profile.sku), profile);
      showToast(`Registered profile for product: ${profile.name}`);

      // Commit initial batch if specified!
      if (initialBatch) {
        const { lot, expiryDate, quantity } = initialBatch;
        
        // Find if batch exists
        const matchingBatch = !preventMerge ? batches.find(
          b => b.sku.toUpperCase() === profile.sku.toUpperCase() &&
               b.lot.toUpperCase() === lot.toUpperCase() &&
               b.expiryDate === expiryDate
        ) : null;

        if (matchingBatch) {
          await setDoc(doc(db, 'batches', matchingBatch.id), {
            ...matchingBatch,
            quantity: matchingBatch.quantity + quantity
          });
        } else {
          const batchId = `batch-${Math.random().toString(36).substr(2, 9)}`;
          const freshBatch: InventoryBatch = {
            id: batchId,
            sku: profile.sku,
            name: profile.name,
            lot: lot.toUpperCase(),
            expiryDate,
            quantity,
            createdAt: new Date().toISOString(),
            sstRequired: profile.sstRequired,
            sstPassed: false // initial stock starts pending biological safety checks!
          };
          await setDoc(doc(db, 'batches', batchId), freshBatch);
        }

        const logId = `log-${Math.random().toString(36).substr(2, 9)}`;
        const newLog: MovementLog = {
          id: logId,
          timestamp: new Date().toISOString(),
          type: 'STOCK_IN',
          sku: profile.sku,
          name: profile.name,
          lot: lot.toUpperCase(),
          expiryDate,
          quantity,
          notes: `Pre-registration initial batch stock-in.` + (profile.sstRequired ? " [SST Required]" : "")
        };
        await setDoc(doc(db, 'logs', logId), newLog);
        showToast(`Stocked initial Lot ${lot} of ${profile.name}!`);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `productProfiles/${profile.sku}`);
    }
  };

  const handleUpdateProfile = async (sku: string, updatedFields: Partial<ProductProfile>) => {
    try {
      const profile = productProfiles.find(p => p.sku === sku);
      if (!profile) return;

      const updatedProfile = { ...profile, ...updatedFields };
      await setDoc(doc(db, 'productProfiles', sku), updatedProfile);

      // If Name changes, let's also update the name inside all existing batches
      if (updatedFields.name) {
        const matchingBatches = batches.filter(b => b.sku.toUpperCase() === sku.toUpperCase());
        for (const b of matchingBatches) {
          await setDoc(doc(db, 'batches', b.id), { ...b, name: updatedFields.name });
        }
      }
      
      showToast(`Updated profile configurations for SKU: ${sku}`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `productProfiles/${sku}`);
    }
  };
  
  // Scanned item flow tracking
  const INITIAL_STOCK_IN_STATE = {
    sku: '',
    name: '',
    lot: '',
    expiryDate: '',
    quantity: 1,
    isRawBarcode: true,
    sstRequired: false,
    sstPassed: false
  };

  const [scannedInResult, setScannedInResult] = useState<{
    sku: string;
    name: string;
    lot: string;
    expiryDate: string;
    quantity: number;
    isRawBarcode: boolean;
    sstRequired?: boolean;
    sstPassed?: boolean;
  }>(INITIAL_STOCK_IN_STATE);

  const [scannedOutResult, setScannedOutResult] = useState<{
    sku: string;
    name: string;
    lot: string;
    expiryDate: string;
    quantity: number;
    isRawBarcode: boolean;
    labelId?: string;
    itemIndex?: number;
    totalItems?: number;
  } | null>(null);

  // Track specific individual label IDs that have already been stocked out (dispatched)
  const [dispatchedLabels, setDispatchedLabels] = useState<string[]>(() => {
    const stored = localStorage.getItem('FEFO_DISPATCHED_LABELS');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.error("Failed to parse dispatched labels.");
      }
    }
    return [];
  });

  useEffect(() => {
    localStorage.setItem('FEFO_DISPATCHED_LABELS', JSON.stringify(dispatchedLabels));
  }, [dispatchedLabels]);

  // FEFO warning overlay stage state
  const [fefoViolation, setFefoViolation] = useState<{
    violation: boolean;
    scannedLot: string;
    scannedExpiry: string;
    earliestLot: string;
    earliestExpiry: string;
    earliestQty: number;
  } | null>(null);

  // General inline notification alerts success
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'warn' } | null>(null);
  const [showStockInScanner, setShowStockInScanner] = useState<boolean>(false);
  const [cameraMode, setCameraMode] = useState<'qr' | 'ocr'>('ocr');
  const [registrySearchQuery, setRegistrySearchQuery] = useState("");
  const [isRegistryDropdownOpen, setIsRegistryDropdownOpen] = useState(false);
  const [lastSyncedSku, setLastSyncedSku] = useState("");
  const [isAnalyzingLabel, setIsAnalyzingLabel] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrWebcamActive, setOcrWebcamActive] = useState(true);
  const [ocrStatusText, setOcrStatusText] = useState("");
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);

  // Advanced inventory tracking: Standalone packages (prevent merging identical lot numbers)
  const [preventMerge, setPreventMerge] = useState<boolean>(() => {
    return localStorage.getItem('FEFO_PREVENT_MERGE') === 'true';
  });

  // Track safety stock thresholds per product SKU
  const [safetyStocks, setSafetyStocks] = useState<Record<string, number>>(() => {
    const stored = localStorage.getItem('FEFO_SAFETY_STOCKS');
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.error("Failed to parse safety stocks.");
      }
    }
    return {
      'PHP-38014': 5,
      'HEPA-FILTER': 2,
      'CN200115': 3,
    };
  });

  useEffect(() => {
    localStorage.setItem('FEFO_SAFETY_STOCKS', JSON.stringify(safetyStocks));
  }, [safetyStocks]);

  // Custom high-fidelity dialog modal state (replacing blocked windows components)
  const [dialog, setDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'alert' | 'confirm' | 'prompt';
    value: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: (val?: string) => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'alert',
    value: '',
    onConfirm: () => {}
  });

  // Persist option settings
  useEffect(() => {
    localStorage.setItem('FEFO_PREVENT_MERGE', String(preventMerge));
  }, [preventMerge]);

  // Dialogue helper triggers
  const triggerCustomAlert = (title: string, message: string, onConfirm?: () => void) => {
    setDialog({
      isOpen: true,
      title,
      message,
      type: 'alert',
      value: '',
      confirmText: 'Dismiss',
      onConfirm: () => {
        setDialog(prev => ({ ...prev, isOpen: false }));
        if (onConfirm) onConfirm();
      },
      onCancel: () => setDialog(prev => ({ ...prev, isOpen: false }))
    });
  };

  const triggerCustomConfirm = (
    title: string,
    message: string,
    confirmTextContent: string,
    onConfirmAction: () => void,
    onCancelAction?: () => void
  ) => {
    setDialog({
      isOpen: true,
      title,
      message,
      type: 'confirm',
      value: '',
      confirmText: confirmTextContent,
      cancelText: 'Cancel',
      onConfirm: () => {
        setDialog(prev => ({ ...prev, isOpen: false }));
        onConfirmAction();
      },
      onCancel: () => {
        setDialog(prev => ({ ...prev, isOpen: false }));
        if (onCancelAction) onCancelAction();
      }
    });
  };

  const triggerCustomPrompt = (
    title: string,
    message: string,
    placeholderText: string,
    confirmTextContent: string,
    onConfirmAction: (input: string) => void,
    onCancelAction?: () => void
  ) => {
    setDialog({
      isOpen: true,
      title,
      message,
      type: 'prompt',
      value: '',
      placeholder: placeholderText,
      confirmText: confirmTextContent,
      cancelText: 'Cancel',
      onConfirm: () => {
        setDialog(prev => {
          onConfirmAction(prev.value);
          return { ...prev, isOpen: false };
        });
      },
      onCancel: () => {
        setDialog(prev => ({ ...prev, isOpen: false }));
        if (onCancelAction) onCancelAction();
      }
    });
  };

  // Startup Check: Automatically write-off expired items in Firestore and prevent their usage!
  useEffect(() => {
    if (!user || batches.length === 0) return;
    
    // Only run this auto-write-off check once per login session
    const sessionsCheckedKey = `FEFO_EXPIRED_CHECKED_${user.uid}`;
    if (sessionStorage.getItem(sessionsCheckedKey)) return;
    sessionStorage.setItem(sessionsCheckedKey, 'true');

    const todayStr = '2026-06-01';
    const expiredToAutoStockOut = batches.filter(b => b.quantity > 0 && b.expiryDate && b.expiryDate < todayStr);

    if (expiredToAutoStockOut.length > 0) {
      const processDisposals = async () => {
        try {
          for (const b of expiredToAutoStockOut) {
            // Write-off in Firestore
            await setDoc(doc(db, 'batches', b.id), { ...b, quantity: 0 });

            // Generate stock-out log
            const logId = `auto-expired-${Math.random().toString(36).substr(2, 9)}`;
            const autoLog: MovementLog = {
              id: logId,
              timestamp: new Date().toISOString(),
              type: 'WASTE',
              sku: b.sku,
              name: b.name,
              lot: b.lot,
              expiryDate: b.expiryDate,
              quantity: b.quantity,
              notes: `SOP-AUTO-DISPOSE: Automatically stocked out and written-off due to clinical expiry (Expired on ${b.expiryDate}).`
            };
            await setDoc(doc(db, 'logs', logId), autoLog);
          }

          triggerCustomAlert(
            "⚠️ Automatic Expiry Write-Off Active",
            `System detected ${expiredToAutoStockOut.length} active batch(es) that have passed their clinical expiry date. They have been automatically stocked out (withdrawn as waste) in the cloud database and blocked from operational use according to safety standard operating procedures.`
          );
        } catch (err) {
          console.error("Failed to run active auto-writeoff block on firestore:", err);
        }
      };

      processDisposals();
    }
  }, [user, batches]);

  // Sync search textbox query with external scanned products / form resets
  useEffect(() => {
    if (scannedInResult && scannedInResult.sku !== lastSyncedSku) {
      setLastSyncedSku(scannedInResult.sku);
      if (scannedInResult.sku) {
        const found = productProfiles.find(p => p.sku.toUpperCase() === scannedInResult.sku.toUpperCase());
        setRegistrySearchQuery(found ? `[${found.sku}] ${found.name}` : scannedInResult.sku);
      } else {
        setRegistrySearchQuery("");
      }
    }
  }, [scannedInResult?.sku, productProfiles, lastSyncedSku]);

  // Webcam side-effects for Gemini OCR vision
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    if (showStockInScanner && cameraMode === 'ocr' && ocrWebcamActive) {
      navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
      })
      .then(str => {
        activeStream = str;
        setWebcamStream(str);
        if (videoRef.current) {
          videoRef.current.srcObject = str;
        }
        setOcrError(null);
      })
      .catch(err => {
        console.error("Webcam access error:", err);
        setOcrError("Unable to access your camera. Please check permissions, start the camera feed, or drag and drop / upload a photo of the label below.");
      });
    } else {
      if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        setWebcamStream(null);
      }
    }
    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [showStockInScanner, cameraMode, ocrWebcamActive]);

  const analyzeImageForOcr = async (base64Image: string) => {
    setIsAnalyzingLabel(true);
    setOcrStatusText("Gemini is reading text fields & extracting Lot/Expiry...");
    setOcrError(null);
    try {
      const response = await fetch('/api/extract-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to process image using server-side Gemini Vision OCR.");
      }

      const result = await response.json();
      if (!result.lot && !result.expiryDate) {
        setOcrError("Gemini analyzed this image but could not identify a distinct Lot Number or Expiry date. Please try another angle, ensure text is legible, or enter manually.");
        showToast("Extracted empty results. Check image clarity.", "warn");
      } else {
        setScannedInResult(prev => ({
          ...prev,
          lot: result.lot || prev.lot,
          expiryDate: result.expiryDate || prev.expiryDate,
        }));
        showToast(`Gemini extracted Lot: ${result.lot || '(Not found)'} | Expiry: ${result.expiryDate || '(Not found)'}`, "success");
        setShowStockInScanner(false); // Auto close scanner on success!
      }
    } catch (err: any) {
      console.error(err);
      setOcrError(err.message || "An unexpected error occurred during visual AI processing.");
      showToast("OCR analysis failed.", "warn");
    } finally {
      setIsAnalyzingLabel(false);
    }
  };

  const snapAndAnalyze = () => {
    if (!videoRef.current) return;
    try {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        analyzeImageForOcr(dataUrl);
      }
    } catch (err: any) {
      console.error(err);
      setOcrError("Failed to snap picture: " + err.message);
    }
  };

  const handleLabelImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        analyzeImageForOcr(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  // Utility to show temporary toast actions on cellphone screen
  const showToast = (message: string, type: 'success' | 'warn' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // HANDLER: Capture Lot & Expiry QR label and prepare Stock In
  const handleStockInScan = (decodedText: string) => {
    try {
      const trimmed = decodedText.trim();
      
      // 1. Check if it's a JSON string (could be our printed label format)
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const parsed = JSON.parse(trimmed);
        const skuVal = (parsed.sku || '').toUpperCase();
        const profile = productProfiles.find(p => p.sku === skuVal);
        
        setScannedInResult(prev => ({
          ...prev,
          sku: skuVal || prev.sku,
          name: profile ? profile.name : (parsed.name || prev.name),
          lot: parsed.lot || parsed.LOT || parsed.batch || prev.lot,
          expiryDate: parsed.exp || parsed.expiry || parsed.expiryDate || prev.expiryDate,
          isRawBarcode: false,
          sstRequired: profile ? profile.sstRequired : (parsed.sstRequired !== undefined ? !!parsed.sstRequired : prev.sstRequired),
          sstPassed: false
        }));
        
        showToast(`Parsed printed label: Lot ${parsed.lot || ''}`, "success");
        return;
      }
      
      // 2. See if plain text contains structured Lot and Expiry patterns
      // Support patterns like: "LOT: A321 EXP: 2028-11-20" or "LOT-K512 EXP: 2027/12/31"
      const expDateRegex = /\b(202\d[-/][01]\d[-/][0-3]\d)\b/;
      const lotRegex = /\b(?:LOT|BATCH|LOT-ID)[:\-\s]*([A-Z0-9_\-]+)\b/i;
      
      let matchedLot = '';
      let matchedExp = '';
      
      const lotMatch = trimmed.match(lotRegex);
      if (lotMatch && lotMatch[1]) {
        matchedLot = lotMatch[1].toUpperCase();
      }
      
      const expMatch = trimmed.match(expDateRegex);
      if (expMatch && expMatch[1]) {
        // Convert any slashes to dashes for the date input
        matchedExp = expMatch[1].replace(/\//g, '-');
      }
      
      if (matchedLot || matchedExp) {
        setScannedInResult(prev => ({
          ...prev,
          lot: matchedLot || prev.lot,
          expiryDate: matchedExp || prev.expiryDate,
          isRawBarcode: false
        }));
        showToast(`Captured via camera: ${matchedLot ? `Lot ${matchedLot}` : ''} ${matchedExp ? `Exp ${matchedExp}` : ''}`.trim(), "success");
        return;
      }
      
      // 3. Fallback: If it's a raw string, we treat the entire scanned text as the Lot / Batch ID
      if (trimmed.length > 2) {
        setScannedInResult(prev => ({
          ...prev,
          lot: trimmed.toUpperCase(),
          isRawBarcode: false
        }));
        showToast(`Captured Lot ID: ${trimmed.toUpperCase()}`, "success");
      }
    } catch (e) {
      console.error("Scanner parsing error:", e);
      showToast("Could not parse scan, stored raw text as Lot.", "warn");
      setScannedInResult(prev => ({
        ...prev,
        lot: decodedText.toUpperCase(),
        isRawBarcode: false
      }));
    }
  };

  // COMMIT: Finalize Stock In action
  const commitStockIn = (e: FormEvent) => {
    e.preventDefault();
    if (!scannedInResult) return;

    const { sku, name, lot, expiryDate, quantity, sstRequired, sstPassed } = scannedInResult;

    if (!sku || !name || !lot || !expiryDate || quantity <= 0) {
      triggerCustomAlert("Missing Fields", "Please make sure to supply SKU, Product Name, Lot ID, and Expiry Date with quality > 0.");
      return;
    }

    const doCommit = async (reqSst: boolean, passedSst: boolean) => {
      try {
        // Check if EXACT batch (same SKU + Lot + Expiry) already exists, if so merge quantity (unless preventMerge is selected)
        const existingBatch = !preventMerge ? batches.find(
          b => b.sku.toUpperCase() === sku.toUpperCase() &&
               b.lot.toUpperCase() === lot.toUpperCase() &&
               b.expiryDate === expiryDate
        ) : null;

        if (existingBatch) {
          const updatedBatch = {
            ...existingBatch,
            quantity: existingBatch.quantity + quantity,
            sstRequired: reqSst,
            sstPassed: passedSst
          };
          await setDoc(doc(db, 'batches', existingBatch.id), updatedBatch);
        } else {
          const batchId = `batch-${Math.random().toString(36).substr(2, 9)}`;
          const freshBatch: InventoryBatch = {
            id: batchId,
            sku: sku.toUpperCase(),
            name,
            lot: lot.toUpperCase(),
            expiryDate,
            quantity,
            createdAt: new Date().toISOString(),
            sstRequired: reqSst,
            sstPassed: passedSst
          };
          await setDoc(doc(db, 'batches', batchId), freshBatch);
        }

        // Write movement log
        const logId = `log-${Math.random().toString(36).substr(2, 9)}`;
        const newLog: MovementLog = {
          id: logId,
          timestamp: new Date().toISOString(),
          type: 'STOCK_IN',
          sku: sku.toUpperCase(),
          name,
          lot: lot.toUpperCase(),
          expiryDate,
          quantity,
          notes: (preventMerge 
            ? "Scanned and stocked as distinct tracked package container."
            : "Scanned and stocked into warehouse batch.") + (reqSst ? " [SST Safety Testing Required]" : "")
        };
        await setDoc(doc(db, 'logs', logId), newLog);

        setScannedInResult(INITIAL_STOCK_IN_STATE);
        showToast(`Successfully stocked in +${quantity} boxes of ${name}!`);
        setActiveTab('DASHBOARD');
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'batches');
      }
    };

    // Prompt if this is the first time keying in this item (SKU is brand new)
    const profile = productProfiles.find(p => p.sku === sku.toUpperCase());
    const isNewSku = !batches.some(b => b.sku.toUpperCase() === sku.toUpperCase());

    if (profile) {
      // Profile exists! Use set settings automatically without prompting!
      if (profile.sstRequired) {
        doCommit(true, sstPassed || false);
      } else {
        doCommit(false, false);
      }
    } else if (isNewSku) {
      triggerCustomConfirm(
        "🧪 SST Requirements Check",
        `This is a brand new product (${sku}: ${name}) being registered for the first time. Does this product require Sperm Survival or Suitability Testing (SST) before dispatch?`,
        "Yes, Require SST",
        () => {
          // If SST is required, ask if the current batch has already passed
          triggerCustomConfirm(
            "🧪 Initial SST Result",
            `Has this initial batch (Lot ${lot}) already passed the SST laboratory testing?`,
            "Yes, Already Passed",
            () => {
              doCommit(true, true);
            },
            () => {
              doCommit(true, false); // Pending
            }
          );
        },
        () => {
          doCommit(false, false); // SST Not Required
        }
      );
    } else {
      doCommit(sstRequired || false, sstPassed || false);
    }
  };

  // HANDLER: Scan item barcode/QR label to Stock Out
  const handleStockOutScan = (decodedText: string) => {
    try {
      // Method A: User scans our custom Smart QR Label
      if (decodedText.startsWith('{') && decodedText.endsWith('}')) {
        const parsed = JSON.parse(decodedText) as QRLabelData;
        if (parsed.type === 'FEFO_LABEL') {
          // EXPIRED ITEM DEFENSE HARD BLOCK:
          if (parsed.exp && parsed.exp < '2026-06-01') {
            triggerCustomAlert(
              "🚫 CRITICAL SAFETY BLOCK: EXPIRED ITEM",
              `⚠️ DO NOT USE IT! This item (SKU: ${parsed.sku}, Lot: ${parsed.lot}) expired on ${parsed.exp}!\n\nStandard Operating Procedure (SOP) strictly bans the dispatch or clinical patient use of expired items. System has automatically zeroed and written off this batch.`
            );
            return;
          }

          // 1. DUPLICATE CHECKOUT DEFENSE:
          if (parsed.labelId && dispatchedLabels.includes(parsed.labelId)) {
            triggerCustomAlert(
              "⚠️ Duplicate Scan Accident Blocked",
              `SECURITY SAFEGUARD ACTIVE:\n\nThis physical sticker label (Lot ${parsed.lot}, Sticker #${parsed.itemIndex || 1} of ${parsed.totalItems || 1}) has already been checked out / dispatched!\n\nPlease find an unused physical item sticker to prevent a duplicate stock-out error.`
            );
            return;
          }

          // Check if product even has stock before processing FEFO rules
          const totalStockOfSku = batches
            .filter(b => b.sku.toUpperCase() === parsed.sku.toUpperCase())
            .reduce((sum, b) => sum + b.quantity, 0);

          if (totalStockOfSku <= 0) {
            triggerCustomAlert("No Active Inventory", `There are currently 0 active boxes of SKU ${parsed.sku} available in the warehouse!`);
            return;
          }

          // Evaluate FEFO rules
          const check = validateFEFOStockOut(batches, parsed.sku, parsed.lot, parsed.exp);

          if (!check.isValid && check.earliestBatchInfo) {
            // FEFO core rule violation!
            // Warn the user immediately with full details
            triggerCustomAlert(
              "🚫 FEFO DEVIATION DETECTED & BLOCKED",
              `⚠️ DISPATCH RESTRICTED!\n\nThe scanned item (Lot: ${parsed.lot}, Expiry: ${parsed.exp}) does not have the closest expiration date in stock.\n\nYou are strictly required to use Lot: ${check.earliestBatchInfo.lot} which expires on ${check.earliestBatchInfo.expiryDate} (${check.earliestBatchInfo.quantity} boxes remaining).\n\nTransaction blocked to comply with clinical quality rules.`
            );

            setFefoViolation({
              violation: true,
              scannedExpiry: parsed.exp,
              scannedLot: parsed.lot,
              earliestExpiry: check.earliestBatchInfo.expiryDate,
              earliestLot: check.earliestBatchInfo.lot,
              earliestQty: check.earliestBatchInfo.quantity
            });

            setScannedOutResult({
              sku: parsed.sku,
              name: parsed.name,
              lot: parsed.lot,
              expiryDate: parsed.exp,
              quantity: 1,
              isRawBarcode: false,
              labelId: parsed.labelId,
              itemIndex: parsed.itemIndex,
              totalItems: parsed.totalItems
            });
            return;
          }

          // Safe FEFO stock out or single remaining batch
          setScannedOutResult({
            sku: parsed.sku,
            name: parsed.name,
            lot: parsed.lot,
            expiryDate: parsed.exp,
            quantity: 1,
            isRawBarcode: false,
            labelId: parsed.labelId,
            itemIndex: parsed.itemIndex,
            totalItems: parsed.totalItems
          });
          return;
        }
      }

      // Method B: Raw manufacture barcode scanned during Stock Out
      const skuInput = decodedText.trim().toUpperCase();
      const itemsOfSku = batches.filter(b => b.sku.toUpperCase() === skuInput && b.quantity > 0);

      if (itemsOfSku.length === 0) {
        triggerCustomAlert("Product Not Found", `Product SKU "${skuInput}" was not located or has no boxes remaining in active stock.`);
        return;
      }

      // Sort existing active batches by expiry to suggest the absolute first one to draw down!
      const sortedByExpiry = [...itemsOfSku].sort(
        (a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime()
      );
      
      const idealBatch = sortedByExpiry[0];

      if (idealBatch.expiryDate && idealBatch.expiryDate < '2026-06-01') {
        triggerCustomAlert(
          "🚫 CRITICAL SAFETY BLOCK: EXPIRED ITEM",
          `⚠️ DO NOT USE IT! The oldest available boxes in active stock belong to expired Lot ${idealBatch.lot} (Exp: ${idealBatch.expiryDate}).\n\nClinical patient use of expired stock is strictly prohibited.`
        );
        return;
      }

      setScannedOutResult({
        sku: skuInput,
        name: idealBatch.name,
        lot: idealBatch.lot,
        expiryDate: idealBatch.expiryDate,
        quantity: 1,
        isRawBarcode: true
      });

      showToast(`Selected oldest Lot ${idealBatch.lot} (Exp: ${idealBatch.expiryDate}) automatic by FEFO.`, "success");
    } catch (e) {
      triggerCustomAlert("Scan Action Failed", "Invalid or unrecognized code format during scan-out dispatch.");
    }
  };

  // COMMIT: Finalize Stock Out action
  const commitStockOut = async (isOverriding: boolean = false, overrideReason: string = '') => {
    if (!scannedOutResult) return;

    const { sku, lot, quantity, name, expiryDate } = scannedOutResult;

    // EXPIRED ITEM DEFENSE HARD BLOCK:
    if (expiryDate && expiryDate < '2026-06-01') {
      triggerCustomAlert(
        "🚫 CRITICAL SAFETY BLOCK: EXPIRED ITEM",
        `⚠️ DO NOT USE IT! This item has expired on ${expiryDate}!\n\nStandard Operating Procedure (SOP) strictly bans the dispatch, use, or patient allocation of expired clinical items.`
      );
      return;
    }

    // STRICT FEFO DEVIATION HARD BLOCK:
    const fefoCheck = validateFEFOStockOut(batches, sku, lot, expiryDate || '');
    if (!fefoCheck.isValid && fefoCheck.earliestBatchInfo) {
      triggerCustomAlert(
        "🚫 DISPATCH BLOCKED: FEFO ROTATION VIOLATION",
        `⚠️ STRICT CLINICAL SAFEGUARD ACTIVE!\n\nYou must check out the batch with the closest expiry first!\n\nCorrect Lot to dispatch first: Lot ${fefoCheck.earliestBatchInfo.lot} (Exp: ${fefoCheck.earliestBatchInfo.expiryDate}).`
      );
      return;
    }

    // Locate the exact matching batch in the warehouse to deduct stock
    let matchingBatch = batches.find(
      b => b.sku.toUpperCase() === sku.toUpperCase() &&
           b.lot.toUpperCase() === lot.toUpperCase() &&
           b.expiryDate === expiryDate &&
           b.quantity >= quantity
    );

    if (!matchingBatch) {
      // Fallback: If same Lot, allow checkout from ANY batch instance of that exact same lot with sufficient quantity
      matchingBatch = batches.find(
        b => b.sku.toUpperCase() === sku.toUpperCase() &&
             b.lot.toUpperCase() === lot.toUpperCase() &&
             b.quantity >= quantity
      );
    }

    if (!matchingBatch) {
      // Fallback 2: Any matching lot batch with > 0 quantity
      matchingBatch = batches.find(
        b => b.sku.toUpperCase() === sku.toUpperCase() &&
             b.lot.toUpperCase() === lot.toUpperCase() &&
             b.quantity > 0
      );
    }

    if (!matchingBatch) {
      triggerCustomAlert("Batch Not Found", `System could not locate available active boxes of SKU ${sku} belonging to Lot ${lot}.`);
      return;
    }

    // SECURE SST SAFETY CHECK LOCK:
    if (matchingBatch.sstRequired && !matchingBatch.sstPassed && !isOverriding && !overrideReason.includes('SST_Bypass')) {
      triggerCustomPrompt(
        "🧪 SST Safety Lock Active",
        `This product (${name}, Lot ${lot}) requires Sperm Survival / Suitability Testing (SST) before dispatch. Currently, NO passed SST result is registered.\n\nTo bypass this safe laboratory lock, please enter the supervisor Paypass / Bypass Key:`,
        "Enter supervisor Paypass / Bypass key (e.g. SST-BYPASS-2026)",
        "Authorize & Dispatch",
        (bypassKey) => {
          if (bypassKey && (bypassKey.toUpperCase() === 'SST-BYPASS-2026' || bypassKey.toUpperCase() === 'SST-BYPASS' || bypassKey.toUpperCase() === 'PAYPASS' || bypassKey.toUpperCase() === 'SST-PAYPASS-2026')) {
            commitStockOut(true, `SST_Bypass: Authorized via Supervisor Paypass key override`);
          } else {
            triggerCustomAlert("Bypass Denied", "Incorrect or unauthorized Paypass key entered. This box remains locked in storage.");
          }
        }
      );
      return;
    }

    const availableQty = matchingBatch.quantity;
    if (quantity > availableQty) {
      triggerCustomAlert("Insufficient Stock", `The requested quantity (${quantity}) exceeds the available boxes in current batch Lot ${lot} (${availableQty} boxes).`);
      return;
    }

    try {
      // Apply Deduction
      const newQty = availableQty - quantity;
      await setDoc(doc(db, 'batches', matchingBatch.id), {
        ...matchingBatch,
        quantity: newQty
      });

      if (scannedOutResult.labelId) {
        setDispatchedLabels(prev => [...prev, scannedOutResult.labelId!]);
      }

      // Save corresponding log
      const notesStr = (scannedOutResult.labelId ? `[Sticker #${scannedOutResult.itemIndex} of ${scannedOutResult.totalItems}] ` : '') + (overrideReason.startsWith('SST_Bypass')
        ? `🚨 SST Locked Dispatch: ${overrideReason}`
        : isOverriding 
          ? `🚨 FEFO Override Commit: ${overrideReason || "User proceeded with later expiration lot"}. Earliest lot was ${fefoViolation?.earliestLot} expiring on ${fefoViolation?.earliestExpiry}.`
          : `FEFO compliant stock out from batch Lot ${lot}.`);

      const logId = `log-${Math.random().toString(36).substr(2, 9)}`;
      const newLog: MovementLog = {
        id: logId,
        timestamp: new Date().toISOString(),
        type: (isOverriding || overrideReason.startsWith('SST_Bypass')) ? 'STOCK_OUT_OVERRIDE' : 'STOCK_OUT',
        sku: sku.toUpperCase(),
        name,
        lot: lot.toUpperCase(),
        expiryDate,
        quantity,
        notes: notesStr
      };
      await setDoc(doc(db, 'logs', logId), newLog);

      // Cleanup scanning stages
      setScannedOutResult(null);
      setFefoViolation(null);
      showToast(`Stock out confirmed for ${quantity} boxes of Lot ${lot}!`);
      setActiveTab('DASHBOARD');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `batches/${matchingBatch.id}`);
    }
  };

  // HANDLER: Instant waste out disposal of expired item
  const handleDisposeBatch = (batchId: string) => {
    const targetBatch = batches.find(b => b.id === batchId);
    if (!targetBatch) return;

    triggerCustomConfirm(
      "Confirm Waste & Disposal",
      `Are you sure you want to write off and dispose of Lot ${targetBatch.lot} (${targetBatch.quantity} boxes) of ${targetBatch.name}? This action will permanently zero out this item batch and record a compliance waste audit entry.`,
      "Yes, Write Off Batch",
      async () => {
        try {
          // Deduct quantity of specific lot to 0
          await setDoc(doc(db, 'batches', batchId), {
            ...targetBatch,
            quantity: 0
          });

          // Write movement log as Waste
          const logId = `log-${Math.random().toString(36).substr(2, 9)}`;
          const newLog: MovementLog = {
            id: logId,
            timestamp: new Date().toISOString(),
            type: 'WASTE',
            sku: targetBatch.sku,
            name: targetBatch.name,
            lot: targetBatch.lot,
            expiryDate: targetBatch.expiryDate,
            quantity: targetBatch.quantity,
            notes: `Batch Lot ${targetBatch.lot} disposed of due to critical shelf expiration.`
          };
          await setDoc(doc(db, 'logs', logId), newLog);

          showToast(`Disposed and logged expired Lot ${targetBatch.lot} successfully!`, "warn");
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `batches/${batchId}`);
        }
      }
    );
  };

  // Reset demo logs - locked down to comply with immutable security specs
  const handleClearLogs = () => {
    showToast("Audit records are compliance-secured & immutable.", "warn");
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center font-sans" id="sec-clinical-auth-loading">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin"></div>
          <p className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest">Verifying Clinical Token...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center font-sans p-4 selection:bg-blue-900 selection:text-white" id="sec-operator-auth-container">
        <div className="w-full max-w-md bg-slate-800 border border-slate-700/80 p-8 rounded-2xl shadow-2xl relative overflow-hidden flex flex-col items-center">
          {/* Subtle light effect top */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-blue-500 to-transparent" />
          
          <div className="bg-slate-950 text-blue-400 p-4 rounded-2xl shadow-inner mb-6 border border-slate-800 animate-pulse">
            <Package className="w-10 h-10" />
          </div>

          <h1 className="text-xl font-extrabold text-white text-center uppercase tracking-wider mb-2 font-sans">
            SMART FEFO PORTAL
          </h1>
          <p className="text-xs text-blue-400 font-mono font-bold tracking-widest uppercase mb-6">
            Clinical IVF Inventory System
          </p>

          <div className="w-full bg-slate-950/60 p-4 border border-slate-700/40 rounded-xl mb-6 text-[11px] text-slate-400 leading-relaxed text-center font-medium">
            🧬 Secure restricted environment for embryologists & lab practitioners. Access logs clinical movement history and FEFO compliance records under ISO 9001 quality rules.
          </div>

          {authError && (
            <div className="w-full bg-rose-950/40 border border-rose-900/60 p-3.5 rounded-xl text-rose-300 text-[11px] mb-5 text-center leading-relaxed">
              <span className="font-bold block mb-1 text-xs text-rose-400">⚠️ Sign-In Verification Fail</span>
              <p className="font-mono text-[10px] bg-black/30 p-2 rounded-md mb-1.5 break-all max-h-16 overflow-y-auto">{authError}</p>
              <span className="block text-slate-400 text-[9px]">
                Authorized domains might not be registered yet. Let's load the sandbox instead!
              </span>
            </div>
          )}

          <button
            id="google-operator-login-btn"
            onClick={async () => {
              try {
                setAuthError(null);
                const { signInWithPopup } = await import('firebase/auth');
                const { auth, googleProvider } = await import('./firebase');
                await signInWithPopup(auth, googleProvider);
              } catch (err: any) {
                console.error("Sign-in verification failed: ", err);
                setAuthError(err?.message || String(err));
              }
            }}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm py-3 p-6 rounded-xl transition-all shadow-md hover:shadow-blue-500/20 shadow-blue-600/10 flex items-center justify-center gap-3 active:scale-98 cursor-pointer"
          >
            {/* Google Vector Icon */}
            <svg className="w-5 h-5 fill-current text-white flex-shrink-0" viewBox="0 0 24 24">
              <path d="M12.24 10.285V13.4h6.86c-.277 1.56-1.602 4.585-6.86 4.585-4.54 0-8.24-3.76-8.24-8.385s3.7-8.385 8.24-8.385c2.58 0 4.307 1.095 5.298 2.045l2.465-2.37C18.435 1.21 15.62 0 12.24 0 5.58 0 0 5.37 0 12s5.58 12 12.24 12c6.96 0 11.57-4.89 11.57-11.79 0-.795-.085-1.4-.195-1.925H12.24z"/>
            </svg>
            <span>Operator Sign-In with Google</span>
          </button>

          <div className="flex items-center my-4 w-full">
            <div className="flex-1 border-t border-slate-700/60"></div>
            <span className="px-3 text-[9px] text-slate-500 font-bold uppercase tracking-widest font-mono">OR</span>
            <div className="flex-1 border-t border-slate-700/60"></div>
          </div>

          <button
            id="guest-operator-login-btn"
            onClick={() => {
              setUser({
                uid: 'mock-operator-uid',
                displayName: 'Guest Embryologist (Demo GP)',
                email: 'guest.embryologist@ivf-lab.org',
                emailVerified: true
              } as any);
              showToast("Logged into Guest Offline Sandbox Mode.", "success");
            }}
            className="w-full bg-slate-700/50 hover:bg-slate-700 hover:text-white border border-slate-600/50 text-slate-300 font-bold text-xs py-2.5 px-6 rounded-xl transition-all shadow-sm flex items-center justify-center gap-1.5 active:scale-98 cursor-pointer"
          >
            <span>🔬 Enter as Demo Guest Operator</span>
          </button>

          <div className="mt-8 flex items-center gap-1 text-[10px] text-slate-500 font-bold font-mono uppercase tracking-widest">
            <span>🔐</span>
            <span>Zero-Trust Database Encryption Active</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 flex flex-col font-sans selection:bg-blue-100">
      
      {/* Dynamic Toast Notification Panel */}
      <AnimatePresence>
        {toast && (
          <motion.div 
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className={`fixed top-4 left-1/2 transform -translate-x-1/2 z-50 text-center text-xs font-semibold px-4 py-3 rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.1)] flex items-center justify-between gap-3 border ${
              toast.type === 'warn' 
                ? 'bg-rose-50 text-rose-800 border-rose-200' 
                : 'bg-slate-900 text-slate-100 border-slate-800'
            }`}
          >
            {toast.type === 'warn' ? <AlertTriangle className="w-4 h-4 text-rose-600" /> : <CheckCircle className="w-4 h-4 text-blue-400" />}
            <span className="tracking-tight">{toast.message}</span>
            <button onClick={() => setToast(null)} className="text-slate-400 hover:text-slate-100 transition-colors ml-1 p-0.5">
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Custom Dialogue Popup Layer */}
      <CustomDialog
        isOpen={dialog.isOpen}
        title={dialog.title}
        message={dialog.message}
        type={dialog.type}
        value={dialog.value}
        onChangeValue={(val) => setDialog(prev => ({ ...prev, value: val }))}
        placeholder={dialog.placeholder}
        confirmText={dialog.confirmText}
        cancelText={dialog.cancelText}
        onConfirm={() => dialog.onConfirm(dialog.value)}
        onCancel={() => {
          if (dialog.onCancel) {
            dialog.onCancel();
          } else {
            setDialog(prev => ({ ...prev, isOpen: false }));
          }
        }}
      />

      {/* Main Responsive Layout Wrapper */}
      <div className="max-w-4xl mx-auto w-full px-4 flex-1 flex flex-col pb-24 pt-4">
        
        {/* Mobile Header Banner */}
        <header className="flex justify-between items-center bg-white border border-slate-200/80 p-4 rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.05)] mb-4">
          <div className="flex items-center gap-3">
            <div className="bg-slate-900 text-blue-400 p-2.5 rounded-lg shadow-sm">
              <Package className="w-5 h-5 animate-spin-slow" />
            </div>
            <div>
              <h1 className="text-sm font-extrabold text-slate-900 uppercase tracking-wider leading-none">SMART FEFO</h1>
              <span className="text-[10px] text-blue-600 font-bold font-mono tracking-wide">Lab Inventory (Cloud)</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end hidden sm:flex">
              <span className="text-[10px] font-sans font-bold text-slate-700 leading-none">
                {user?.displayName || user?.email?.split('@')[0] || 'Operator'}
              </span>
              <span className="text-[8px] font-mono text-emerald-600 font-bold tracking-wide uppercase mt-0.5 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
                {user?.uid === 'mock-operator-uid' ? 'Offline Sandbox Mode' : 'Secure Cloud Active'}
              </span>
            </div>
            <button
              onClick={async () => {
                if (user?.uid === 'mock-operator-uid') {
                  setUser(null);
                  showToast("Clinical operator logged out.", "warn");
                } else {
                  const { signOut } = await import('firebase/auth');
                  const { auth } = await import('./firebase');
                  await signOut(auth);
                  setUser(null);
                  showToast("Clinical operator logged out.", "warn");
                }
              }}
              className="text-[10px] uppercase font-bold text-slate-500 hover:text-rose-600 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 flex items-center gap-1 cursor-pointer transition-all active:scale-95"
            >
              🔒 Sign Out
            </button>
          </div>
        </header>

        {/* Dynamic Screen Stage Router */}
        <main className="flex-1">
          {activeTab === 'DASHBOARD' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <div className="p-4 bg-blue-50/60 border border-blue-100 rounded-xl text-xs text-blue-900 flex items-start gap-3 shadow-xs">
                <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="leading-relaxed">
                  <span className="font-semibold">FEFO Operations Guide:</span> Generating dynamic QR codes onto stock packaging encodes batch expiry. Scanner checks other active lots to mandate FEFO (First-Expired, First-Out) compliance.
                </div>
              </div>

              <StockDashboard 
                batches={batches} 
                onDisposeBatch={handleDisposeBatch} 
                onUpdateBatch={(batchId, updatedFields) => {
                  setBatches(prev => prev.map(b => b.id === batchId ? { ...b, ...updatedFields } : b));
                  showToast("Batch properties updated successfully.");
                }}
                safetyStocks={safetyStocks}
                onUpdateSafetyStock={(sku, value) => {
                  setSafetyStocks(prev => ({ ...prev, [sku]: value }));
                  showToast(`Safety stock threshold for ${sku} updated.`);
                }}
                logs={logs}
                productProfiles={productProfiles}
              />
            </motion.div>
          )}

          {activeTab === 'STOCK_IN' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-sm max-w-md mx-auto">
                <div className="bg-slate-900 text-slate-100 px-5 py-4 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <PlusCircle className="w-5 h-5 text-blue-400" />
                    <h3 className="font-bold text-sm">Stock-In Capturer Form</h3>
                  </div>
                  <button 
                    type="button"
                    onClick={() => setScannedInResult(INITIAL_STOCK_IN_STATE)} 
                    className="text-slate-400 hover:text-white bg-slate-800 p-1.5 rounded-lg transition-colors"
                    title="Clear Form"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
 
                <form onSubmit={commitStockIn} className="p-5 space-y-4">
                  <div className="bg-blue-50 border border-blue-200 text-[11px] text-blue-800 p-3 rounded-xl flex items-start gap-2 leading-relaxed">
                    <PlusCircle className="w-4.5 h-4.5 text-blue-600 flex-shrink-0 mt-0.5" />
                    <span>
                      <strong>Manual Stock Entry:</strong> Enter the SKU ID, Name, LOT, and exact expiration data to generate or add to a batch.
                    </span>
                  </div>

                  <div className="relative">
                    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                      Product Template Registry (SKU & Name)
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-455">
                        <Search className="w-3.5 h-3.5" />
                      </div>
                      <input
                        type="text"
                        placeholder="Type SKU or Name to search..."
                        value={registrySearchQuery}
                        onChange={(e) => {
                          setRegistrySearchQuery(e.target.value);
                          setIsRegistryDropdownOpen(true);
                        }}
                        onFocus={() => setIsRegistryDropdownOpen(true)}
                        className="w-full text-xs border border-slate-200 pl-9 pr-8 p-2.5 rounded-lg font-semibold bg-white text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                        required
                      />
                      {registrySearchQuery && (
                        <button
                          type="button"
                          onClick={() => {
                            setScannedInResult(INITIAL_STOCK_IN_STATE);
                            setRegistrySearchQuery("");
                            setIsRegistryDropdownOpen(false);
                          }}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-650 cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {isRegistryDropdownOpen && (() => {
                      const rawQ = registrySearchQuery.toLowerCase();
                      const cleanQ = (rawQ.startsWith('[') && rawQ.includes(']')) ? '' : rawQ;
                      
                      const filtered = productProfiles.filter(p => 
                        p.sku.toLowerCase().includes(cleanQ) || p.name.toLowerCase().includes(cleanQ)
                      );

                      return (
                        <>
                          <div 
                            className="fixed inset-0 z-10" 
                            onClick={() => setIsRegistryDropdownOpen(false)} 
                          />
                          <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg py-1">
                            {filtered.length > 0 ? (
                              filtered.map((p) => (
                                <button
                                  key={p.sku}
                                  type="button"
                                  onClick={() => {
                                    setScannedInResult(prev => ({
                                      ...prev,
                                      sku: p.sku,
                                      name: p.name,
                                      sstRequired: p.sstRequired,
                                      sstPassed: false
                                    }));
                                    setRegistrySearchQuery(`[${p.sku}] ${p.name}`);
                                    setIsRegistryDropdownOpen(false);
                                  }}
                                  className={`w-full text-left px-4 py-2.5 text-xs transition-colors hover:bg-slate-50 flex flex-col gap-0.5 border-b border-slate-50 last:border-0 cursor-pointer ${
                                    scannedInResult.sku === p.sku ? 'bg-blue-50/70 border-l-2 border-l-blue-600 font-semibold' : ''
                                  }`}
                                >
                                  <span className="text-slate-800 font-bold">{p.name}</span>
                                  <span className="text-[10px] text-slate-455 font-mono">
                                    SKU: {p.sku} {p.sstRequired ? '• SOP Required' : ''}
                                  </span>
                                </button>
                              ))
                            ) : (
                              <div className="px-4 py-3 text-center">
                                <p className="text-[11px] text-slate-500">No template matches "{registrySearchQuery}"</p>
                                {registrySearchQuery.trim().length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const cleanSku = registrySearchQuery.trim().toUpperCase();
                                      setScannedInResult(prev => ({
                                        ...prev,
                                        sku: cleanSku,
                                        name: cleanSku,
                                        sstRequired: false,
                                        sstPassed: false
                                      }));
                                      setIsRegistryDropdownOpen(false);
                                    }}
                                    className="mt-3 text-[10px] text-blue-600 bg-blue-50 hover:bg-blue-100 font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer inline-block"
                                  >
                                    Use "{registrySearchQuery.trim()}" as Custom SKU
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </div>

                    {/* Camera Capture Option */}
                    <div className="bg-slate-50 border border-slate-200 p-3 rounded-lg space-y-3">
                      <button
                        type="button"
                        onClick={() => setShowStockInScanner(!showStockInScanner)}
                        className={`w-full py-2 px-3 text-[11px] font-bold rounded-lg flex items-center justify-center gap-2 transition-all border cursor-pointer ${showStockInScanner ? 'bg-cyan-600 hover:bg-cyan-700 text-white border-cyan-700' : 'bg-white hover:bg-slate-50 text-slate-800 border-slate-200 shadow-xs'}`}
                      >
                        <Camera className="w-3.5 h-3.5" />
                        {showStockInScanner ? 'Stop Camera/OCR Feed' : '📷 Capture Lot & Expiry via Camera'}
                      </button>
                      
                      {showStockInScanner && (
                        <div className="border border-slate-200 rounded-lg overflow-hidden bg-white p-3 space-y-3">
                          {/* Tab Navigation */}
                          <div className="flex border-b border-slate-100 pb-2">
                            <button
                              type="button"
                              onClick={() => setCameraMode('ocr')}
                              className={`flex-1 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b-2 transition-all ${cameraMode === 'ocr' ? 'border-purple-600 text-purple-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                            >
                              📸 Visual AI Text OCR
                            </button>
                            <button
                              type="button"
                              onClick={() => setCameraMode('qr')}
                              className={`flex-1 py-1 text-[10px] uppercase tracking-wider font-bold text-center border-b-2 transition-all ${cameraMode === 'qr' ? 'border-cyan-600 text-cyan-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
                            >
                              Scan Barcode/QR
                            </button>
                          </div>

                          {cameraMode === 'qr' ? (
                            <QRScanner 
                              title="Barcode/QR Reader"
                              subtitle="Align QR label / barcode containing Lot & Expiry to auto-fill"
                              isActive={showStockInScanner}
                              onScan={(decoded) => {
                                handleStockInScan(decoded);
                                setShowStockInScanner(false);
                              }}
                            />
                          ) : (
                            <div className="space-y-3">
                              <div className="text-center">
                                <h4 className="text-[11px] font-black text-purple-900 uppercase">Gemini Vision OCR</h4>
                                <p className="text-[10px] text-slate-400">Snap a clear photo of label text—no specific format required!</p>
                              </div>

                              {/* Webcam Preview or Static State */}
                              <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-slate-200 flex items-center justify-center">
                                {ocrWebcamActive && !ocrError ? (
                                  <video 
                                    ref={videoRef} 
                                    autoPlay 
                                    playsInline 
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="p-4 text-center text-slate-400 text-xs leading-relaxed max-w-xs">
                                    {ocrError || "Camera feed is currently paused. Click 'Start Camera' or select a photo directly below."}
                                  </div>
                                )}

                                {isAnalyzingLabel && (
                                  <div className="absolute inset-0 bg-white/95 flex flex-col items-center justify-center p-4 text-center z-10">
                                    <div className="relative w-10 h-10 flex items-center justify-center mb-3">
                                      <div className="absolute inset-0 border-4 border-purple-500/20 rounded-full"></div>
                                      <div className="absolute inset-0 border-4 border-purple-600 rounded-full border-t-transparent animate-spin"></div>
                                    </div>
                                    <p className="text-xs font-bold text-slate-800 uppercase tracking-wide">Analyzing Label Photo</p>
                                    <p className="text-[10px] text-purple-600 font-bold mt-1 animate-pulse">{ocrStatusText}</p>
                                    <p className="text-[9px] text-slate-450 mt-1">Extracting Lot & Expiry using Gemini 3.5...</p>
                                  </div>
                                )}
                              </div>

                              {/* Action Buttons */}
                              <div className="flex gap-2">
                                {ocrWebcamActive && !ocrError && (
                                  <button
                                    type="button"
                                    onClick={snapAndAnalyze}
                                    disabled={isAnalyzingLabel}
                                    className="flex-1 py-1.5 bg-purple-600 hover:bg-purple-700 text-white font-extrabold text-[10px] uppercase rounded-lg shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                  >
                                    <span>📸 Snap and Analyze</span>
                                  </button>
                                )}

                                <button
                                  type="button"
                                  onClick={() => setOcrWebcamActive(!ocrWebcamActive)}
                                  className="px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 font-bold text-[10px] uppercase rounded-lg transition-all cursor-pointer"
                                >
                                  {ocrWebcamActive ? "Stop Video" : "Start Video"}
                                </button>
                              </div>

                              {/* Upload alternative */}
                              <div className="border-t border-dashed border-slate-200 pt-3 flex flex-col items-center justify-center">
                                <span className="text-[9px] font-bold text-slate-400 uppercase mb-2">Or Upload Photo Instead</span>
                                <label className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg text-[10px] text-slate-700 font-bold cursor-pointer transition-all shadow-xs">
                                  <span>📁 Select File from Gallery</span>
                                  <input 
                                    type="file" 
                                    accept="image/*" 
                                    onChange={handleLabelImageUpload}
                                    className="hidden" 
                                  />
                                </label>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
 
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Lot / Batch ID</label>
                        <input 
                          type="text" 
                          value={scannedInResult.lot} 
                          onChange={(e) => setScannedInResult(prev => prev ? { ...prev, lot: e.target.value.toUpperCase() } : null)}
                          placeholder="e.g. LOT-A01"
                          className="w-full text-xs font-mono border border-slate-200 p-2.5 rounded-lg uppercase bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Expiry Date</label>
                        <input 
                          type="date" 
                          value={scannedInResult.expiryDate} 
                          onChange={(e) => setScannedInResult(prev => prev ? { ...prev, expiryDate: e.target.value } : null)}
                          className="w-full text-xs font-mono border border-slate-200 p-2.5 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                          required
                        />
                      </div>
                    </div>
 
                    {/* Stock quantity adjuster */}
                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Adjustment Quantity</label>
                      <div className="flex items-center gap-3">
                        <button 
                          type="button"
                          onClick={() => setScannedInResult(prev => prev ? { ...prev, quantity: Math.max(1, prev.quantity - 1) } : null)}
                          className="w-9 h-9 border border-slate-200 hover:border-slate-300 rounded-lg flex items-center justify-center font-bold text-slate-700 bg-slate-50"
                        >
                          -
                        </button>
                        <input 
                          type="number" 
                          value={scannedInResult.quantity}
                          min={1}
                          onChange={(e) => setScannedInResult(prev => prev ? { ...prev, quantity: parseInt(e.target.value) || 1 } : null)}
                          className="flex-1 text-center font-mono text-sm font-extrabold border border-slate-200 py-1.5 rounded-lg bg-white"
                          required
                        />
                        <button 
                          type="button"
                          onClick={() => setScannedInResult(prev => prev ? { ...prev, quantity: prev.quantity + 1 } : null)}
                          className="w-9 h-9 border border-slate-200 hover:border-slate-300 rounded-lg flex items-center justify-center font-bold text-slate-700 bg-slate-50"
                        >
                          +
                        </button>
                      </div>
                      
                      {(() => {
                        const profile = productProfiles.find(p => p.sku.toUpperCase() === scannedInResult.sku.toUpperCase());
                        const uPerBox = profile?.unitsPerBox || 10;
                        const itemsCount = scannedInResult.quantity * uPerBox;
                        return (
                          <p className="text-[10px] text-slate-500 font-bold mt-2 flex items-center gap-1.5 bg-slate-50 border border-slate-200 p-2 rounded-lg">
                            <span>📦</span>
                            <span>
                              Total Units: <strong className="text-slate-800">{itemsCount}</strong> individual item{itemsCount !== 1 ? 's' : ''} 
                              <span className="text-[9px] font-normal text-slate-400"> (at {uPerBox} items/box from registry)</span>
                            </span>
                          </p>
                        );
                      })()}
                    </div>
 
                    {/* Unique item tracking configuration */}
                    <div className="bg-slate-50 border border-slate-200/60 p-3 rounded-xl">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input 
                          type="checkbox"
                          id="prevent-merge-checkbox"
                          checked={preventMerge}
                          onChange={(e) => setPreventMerge(e.target.checked)}
                          className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900 w-4 h-4 cursor-pointer accent-slate-950"
                        />
                        <div className="flex-1 select-none">
                          <span className="block text-[11px] font-bold text-slate-800 leading-tight">
                            Track as Standalone Container
                          </span>
                          <span className="block text-[9px] text-slate-500 font-medium leading-normal mt-0.5">
                            Prevent merging this stock with existing batches of the same Lot number. Track exact package counts and timelines separately.
                          </span>
                        </div>
                      </label>
                    </div>

                    {/* SST Testing requirements during Stock In */}
                    <div className="bg-slate-50 border border-slate-200/60 p-3 rounded-xl space-y-3">
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={!!scannedInResult.sstRequired}
                          onChange={(e) => setScannedInResult(prev => prev ? { ...prev, sstRequired: e.target.checked } : null)}
                          className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900 w-4 h-4 cursor-pointer accent-slate-950"
                        />
                        <div className="flex-1 select-none">
                          <span className="block text-[11px] font-bold text-slate-800 leading-tight">
                            🧪 Require SST Safety Testing
                          </span>
                          <span className="block text-[9px] text-slate-500 font-medium leading-normal mt-0.5">
                            Flag this item batch as requiring successful Sperm Survival / Suitability Testing (SST) before check-out is authorized.
                          </span>
                        </div>
                      </label>

                      {scannedInResult.sstRequired && (
                        <div className="pl-7 border-l border-slate-200/80 space-y-1.5 select-none">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input 
                              type="checkbox"
                              checked={!!scannedInResult.sstPassed}
                              onChange={(e) => setScannedInResult(prev => prev ? { ...prev, sstPassed: e.target.checked } : null)}
                              className="rounded border-slate-300 text-slate-900 focus:ring-slate-900 w-3.5 h-3.5 cursor-pointer accent-slate-950"
                            />
                            <span className="text-[10px] font-bold text-slate-700">SST Test Result: Passed (Done)</span>
                          </label>
                          <p className="text-[9px] text-slate-450 font-medium leading-normal">
                            Check this if the SST laboratory test has already been completed with passing metrics.
                          </p>
                        </div>
                      )}
                    </div>
 
                    <button
                      type="submit"
                      className="w-full bg-slate-900 border border-slate-950 font-semibold py-2.5 rounded-lg text-xs text-white hover:bg-slate-800 transition-colors shadow-xs uppercase tracking-wider cursor-pointer mt-2"
                    >
                      Confirm Stock In
                    </button>
                  </form>
                </div>
            </motion.div>
          )}

          {activeTab === 'STOCK_OUT' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              {!scannedOutResult ? (
                <div className="space-y-4">
                  <div className="bg-blue-50/60 border border-blue-100 p-4 rounded-xl text-xs text-blue-900 leading-relaxed max-w-md mx-auto shadow-xs">
                    <p className="font-bold flex items-center gap-1.5 mb-1 text-[13px]">
                      <MinusCircle className="w-4.5 h-4.5 text-blue-600" />
                      Step 1: Scan Dispatch Barcode
                    </p>
                    <p>Align label or product barcode. The system checks other active lots to guarantee FEFO (First-Expired, First-Out) criteria are met.</p>
                  </div>
                  <QRScanner 
                    title="Camera: Stock-Out FEFO Checker"
                    subtitle="Scan printed QR labels/barcodes to trigger FEFO check"
                    isActive={activeTab === 'STOCK_OUT'}
                    onScan={handleStockOutScan}
                  />
                </div>
              ) : (
                <div className="bg-white border border-slate-200/80 rounded-xl overflow-hidden shadow-sm max-w-md mx-auto">
                  <div className="bg-slate-900 text-slate-100 px-5 py-4 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <MinusCircle className="w-5 h-5 text-rose-400" />
                      <h3 className="font-bold text-sm">Verify Stock-Out Dispatch</h3>
                    </div>
                    <button onClick={() => {
                      setScannedOutResult(null);
                      setFefoViolation(null);
                    }} className="text-slate-400 hover:text-white bg-slate-800 p-1.5 rounded-lg transition-colors">
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="p-5 space-y-4">
                    {/* FEFO VIOLATION MODAL ALERT */}
                    {fefoViolation && fefoViolation.violation && (
                      <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-rose-950 space-y-3 shadow-sm animate-[shake_0.5s_ease-in-out]">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-5 h-5 text-rose-700" />
                          <h4 className="font-extrabold text-sm uppercase tracking-wide">🚨 FEFO VIOLATION DETECTED</h4>
                        </div>
                        
                        <div className="text-xs leading-relaxed space-y-2">
                          <p>You scanned a later expiring batch than what is available in the warehouse!</p>
                          
                          <div className="bg-white border border-rose-200/60 p-3 rounded-lg space-y-2">
                            <p className="text-[11px] font-medium text-slate-800">
                              📋 <strong className="text-rose-800">Scanned Batch (Later):</strong> Lot <strong>{fefoViolation.scannedLot}</strong> expiring on <strong>{fefoViolation.scannedExpiry}</strong>
                            </p>
                            <p className="text-[11px] font-medium text-slate-800">
                              💡 <strong className="text-emerald-800">Correct Batch (Earliest):</strong> Lot <strong>{fefoViolation.earliestLot}</strong> expiring on <strong>{fefoViolation.earliestExpiry}</strong> ({fefoViolation.earliestQty} boxes remaining).
                            </p>
                          </div>
                          
                          <p className="text-[11px] font-bold text-rose-900 pt-1">
                            Rules state you MUST use the earliest expiring batch. Please abort this checkout and pull the oldest available expiry lot from storage.
                          </p>
                        </div>
                        
                        <div className="border-t border-rose-200/60 pt-3 flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setScannedOutResult(null);
                              setFefoViolation(null);
                              showToast("Aborted. Please pull the oldest expiry from warehouse shelf.", "warn");
                            }}
                            className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold py-2 px-3 rounded-lg text-center text-xs transition-colors shadow-xs cursor-pointer"
                          >
                            ❌ Abort and Go Get Older Lot
                          </button>
                          
                          <div className="text-[10px] text-rose-800 bg-rose-100/50 p-2.5 rounded-lg font-bold border border-rose-200/60 text-center uppercase tracking-wide">
                            🚫 DEVIATIONS BANNED: STRICT FEFO DISPATCH ENFORCED
                          </div>
                        </div>
                      </div>
                    )}

                    {!fefoViolation && (
                      <div className="bg-blue-50/60 border border-blue-100 text-blue-900 text-[11px] p-3 rounded-xl flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-blue-600 flex-shrink-0" />
                        <span><strong>FEFO Compliance Ok:</strong> This Lot is indeed the oldest available expiry for SKU {scannedOutResult.sku} in stock!</span>
                      </div>
                    )}

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Product SKU</label>
                      <input 
                        type="text" 
                        value={scannedOutResult.sku} 
                        readOnly 
                        className="w-full text-xs font-mono bg-slate-50 border border-slate-200 p-2.5 rounded-lg font-bold cursor-not-allowed uppercase text-slate-800"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Product Name</label>
                      <input 
                        type="text" 
                        value={scannedOutResult.name} 
                        readOnly 
                        className="w-full text-xs bg-slate-50 border border-slate-200 p-2.5 rounded-lg font-semibold cursor-not-allowed text-slate-800"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Lot Code</label>
                        <input 
                          type="text" 
                          value={scannedOutResult.lot} 
                          readOnly 
                          className="w-full text-xs font-mono bg-slate-50 border border-slate-200 p-2.5 rounded-lg font-semibold cursor-not-allowed uppercase text-slate-800"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Expiry Date</label>
                        <input 
                          type="text" 
                          value={scannedOutResult.expiryDate} 
                          readOnly 
                          className="w-full text-xs font-mono bg-slate-50 border border-slate-200 p-2.5 rounded-lg font-semibold cursor-not-allowed text-slate-800"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Dispatch Quantity</label>
                      <div className="flex items-center gap-3">
                        <button 
                          type="button"
                          onClick={() => setScannedOutResult(prev => prev ? { ...prev, quantity: Math.max(1, prev.quantity - 1) } : null)}
                          className="w-9 h-9 border border-slate-200 hover:border-slate-300 rounded-lg flex items-center justify-center font-bold text-slate-700 bg-slate-50"
                        >
                          -
                        </button>
                        <input 
                          type="number" 
                          value={scannedOutResult.quantity}
                          min={1}
                          onChange={(e) => setScannedOutResult(prev => prev ? { ...prev, quantity: parseInt(e.target.value) || 1 } : null)}
                          className="flex-1 text-center font-mono text-sm font-extrabold border border-slate-200 py-1.5 rounded-lg bg-white"
                          required
                        />
                        <button 
                          type="button"
                          onClick={() => setScannedOutResult(prev => prev ? { ...prev, quantity: prev.quantity + 1 } : null)}
                          className="w-9 h-9 border border-slate-200 hover:border-slate-300 rounded-lg flex items-center justify-center font-bold text-slate-700 bg-slate-50"
                        >
                          +
                        </button>
                      </div>

                      {(() => {
                        const profile = productProfiles.find(p => p.sku.toUpperCase() === scannedOutResult.sku.toUpperCase());
                        const uPerBox = profile?.unitsPerBox || 10;
                        const itemsCount = scannedOutResult.quantity * uPerBox;
                        return (
                          <p className="text-[10px] text-slate-500 font-bold mt-2 flex items-center gap-1.5 bg-slate-50 border border-slate-200 p-2 rounded-lg">
                            <span>📦</span>
                            <span>
                              Total Units: <strong className="text-slate-800">{itemsCount}</strong> individual item{itemsCount !== 1 ? 's' : ''} 
                              <span className="text-[9px] font-normal text-slate-400"> (at {uPerBox} items/box from registry)</span>
                            </span>
                          </p>
                        );
                      })()}
                    </div>

                    {!fefoViolation && (
                      <button
                        type="button"
                        onClick={() => commitStockOut(false)}
                        className="w-full bg-slate-900 border border-slate-950 font-semibold py-2.5 rounded-lg text-xs text-white hover:bg-slate-800 transition-colors shadow-xs uppercase tracking-wider cursor-pointer mt-2"
                      >
                        Confirm Stock Out
                      </button>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'LOGS' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <MovementLogs 
                logs={logs} 
                onClearLogs={handleClearLogs} 
              />
            </motion.div>
          )}

          {activeTab === 'PRODUCTS' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <ProductProfiles
                profiles={productProfiles}
                onAddProfile={handleAddProfile}
                onDeleteProfile={(sku) => {
                  setProductProfiles(prev => prev.filter(p => p.sku !== sku));
                  showToast(`Deleted product profile ${sku}`);
                }}
                onQuickStockIn={handleQuickStockIn}
                onUpdateProfile={handleUpdateProfile}
              />
            </motion.div>
          )}
        </main>
      </div>

      {/* Cellphone Bottom Tab bar (Primary navigation optimized for thumb reach) */}
      <footer className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-slate-200 shadow-[0_-5px_20px_rgba(0,0,0,0.03)] px-3 py-1.5 flex items-center justify-around z-40 max-w-lg mx-auto rounded-t-xl">
        {/* Dashboard Tab */}
        <button
          onClick={() => {
            setActiveTab('DASHBOARD');
            setScannedInResult(INITIAL_STOCK_IN_STATE);
            setScannedOutResult(null);
            setFefoViolation(null);
          }}
          className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-all cursor-pointer ${
            activeTab === 'DASHBOARD' ? 'text-blue-600 bg-blue-50/80 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <LayoutDashboard className="w-4.5 h-4.5" />
          <span className="text-[10px]">Dashboard</span>
        </button>

        {/* Stock-in Tab */}
        <button
          onClick={() => {
            setActiveTab('STOCK_IN');
            setScannedInResult(INITIAL_STOCK_IN_STATE);
            setScannedOutResult(null);
            setFefoViolation(null);
          }}
          className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-all cursor-pointer ${
            activeTab === 'STOCK_IN' ? 'text-blue-600 bg-blue-50/80 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <PlusCircle className="w-4.5 h-4.5 text-blue-600" />
          <span className="text-[10px]">Stock In</span>
        </button>

        {/* Stock-out Tab */}
        <button
          onClick={() => {
            setActiveTab('STOCK_OUT');
            setScannedInResult(INITIAL_STOCK_IN_STATE);
            setScannedOutResult(null);
            setFefoViolation(null);
          }}
          className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-all cursor-pointer ${
            activeTab === 'STOCK_OUT' ? 'text-blue-600 bg-blue-50/80 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <MinusCircle className="w-4.5 h-4.5 text-rose-500" />
          <span className="text-[10px]">Stock Out</span>
        </button>

        {/* Products Tab */}
        <button
          onClick={() => {
            setActiveTab('PRODUCTS');
            setScannedInResult(INITIAL_STOCK_IN_STATE);
            setScannedOutResult(null);
            setFefoViolation(null);
          }}
          className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-all cursor-pointer ${
            activeTab === 'PRODUCTS' ? 'text-blue-600 bg-blue-50/80 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <Database className="w-4.5 h-4.5 text-indigo-500" />
          <span className="text-[10px]">Registry</span>
        </button>

        {/* Audit Tab */}
        <button
          onClick={() => {
            setActiveTab('LOGS');
            setScannedInResult(INITIAL_STOCK_IN_STATE);
            setScannedOutResult(null);
            setFefoViolation(null);
          }}
          className={`flex flex-col items-center gap-0.5 p-2 rounded-lg transition-all cursor-pointer ${
            activeTab === 'LOGS' ? 'text-blue-600 bg-blue-50/80 font-bold' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          <FileText className="w-4.5 h-4.5 text-slate-700" />
          <span className="text-[10px]">Audits</span>
        </button>
      </footer>

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-4px); }
          75% { transform: translateX(4px); }
        }
        .animate-spin-slow {
          animation: spin 8s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
