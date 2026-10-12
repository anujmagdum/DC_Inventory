import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { ExtractedInvoice, InboundOrderTracking } from '../types';

interface FetchPurchaseInvoicesModalProps {
  isOpen: boolean;
  onClose: () => void;
  existingOrders: InboundOrderTracking[];
  onImportInvoices: (newOrders: InboundOrderTracking[]) => void;
  currentUser?: any;
}

export const FetchPurchaseInvoicesModal: React.FC<FetchPurchaseInvoicesModalProps> = ({
  isOpen,
  onClose,
  existingOrders,
  onImportInvoices,
  currentUser,
}) => {
  const [invoices, setInvoices] = useState<ExtractedInvoice[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [pageOffset, setPageOffset] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [filterUnlinkedOnly, setFilterUnlinkedOnly] = useState<boolean>(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isImporting, setIsImporting] = useState<boolean>(false);

  const PAGE_SIZE = 10;

  // Build a lookup set of invoice numbers and IDs already present in Inbound Tracking
  const linkedInvoiceLookup = useMemo(() => {
    const set = new Set<string>();
    existingOrders.forEach(order => {
      if (order.invoice_number) set.add(order.invoice_number.trim().toLowerCase());
      if (order.invoice_id) set.add(order.invoice_id.trim().toLowerCase());
      if (order.transport_number) set.add(order.transport_number.trim().toLowerCase());
      if (order.notes) {
        // Match any invoice number pattern inside notes
        const match = order.notes.match(/Inv #([A-Za-z0-9_-]+)/i);
        if (match && match[1]) set.add(match[1].trim().toLowerCase());
      }
    });
    return set;
  }, [existingOrders]);

  const isInvoiceLinked = (inv: ExtractedInvoice): boolean => {
    const invNum = inv.invoice_metadata?.invoice_number?.trim().toLowerCase();
    const invId = inv.id?.trim().toLowerCase();
    if (invNum && linkedInvoiceLookup.has(invNum)) return true;
    if (invId && linkedInvoiceLookup.has(invId)) return true;
    return false;
  };

  // Fetch purchase invoices with pagination
  const fetchInvoicesPage = async (offset: number, isInitial = false) => {
    if (isInitial) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }

    try {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, source_type, document_type, invoice_metadata, receiver_details, issuer_details, supplier_details, items, totals, created_at, requires_review')
        .eq('source_type', 'purchase')
        .eq('requires_review', false)
        .in('document_type', ['invoice', 'generated_invoice', 'receipt', 'other', 'delivery_challan'])
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error('Error fetching purchase invoices:', error);
        return;
      }

      const fetchedList = (data || []) as ExtractedInvoice[];

      if (fetchedList.length < PAGE_SIZE) {
        setHasMore(false);
      } else {
        setHasMore(true);
      }

      if (isInitial) {
        setInvoices(fetchedList);
      } else {
        setInvoices(prev => {
          // Avoid duplicates by ID
          const existingIds = new Set(prev.map(i => i.id));
          const newEntries = fetchedList.filter(i => !existingIds.has(i.id));
          return [...prev, ...newEntries];
        });
      }
      setPageOffset(offset + fetchedList.length);
    } catch (err) {
      console.error('Unexpected error loading invoices:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  // Reset and load when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIds(new Set());
      setSearchTerm('');
      setPageOffset(0);
      setHasMore(true);
      fetchInvoicesPage(0, true);
    }
  }, [isOpen]);

  // Load next 10 items
  const handleLoadMore = () => {
    if (!loadingMore && hasMore) {
      fetchInvoicesPage(pageOffset, false);
    }
  };

  // Client-side filtered list
  const filteredInvoices = useMemo(() => {
    return invoices.filter(inv => {
      const isLinked = isInvoiceLinked(inv);
      if (filterUnlinkedOnly && isLinked) {
        return false;
      }

      if (!searchTerm.trim()) return true;
      const term = searchTerm.toLowerCase();

      const invNum = inv.invoice_metadata?.invoice_number?.toLowerCase() || '';
      const vendor = (inv.issuer_details?.name || inv.supplier_details?.name || '').toLowerCase();
      const poNum = inv.invoice_metadata?.purchase_order_number?.toLowerCase() || '';
      const itemMatch = inv.items?.some(i => i.description?.toLowerCase().includes(term));

      return invNum.includes(term) || vendor.includes(term) || poNum.includes(term) || !!itemMatch;
    });
  }, [invoices, searchTerm, filterUnlinkedOnly, linkedInvoiceLookup]);

  // Checkbox toggles
  const handleToggleSelect = (invId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(invId)) {
        next.delete(invId);
      } else {
        next.add(invId);
      }
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    const importableInvoices = filteredInvoices.filter(inv => !isInvoiceLinked(inv));
    const allSelected = importableInvoices.length > 0 && importableInvoices.every(inv => selectedIds.has(inv.id as string));

    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      const newSet = new Set(selectedIds);
      importableInvoices.forEach(inv => {
        if (inv.id) newSet.add(inv.id);
      });
      setSelectedIds(newSet);
    }
  };

  // Perform import
  const handleExecuteImport = () => {
    if (selectedIds.size === 0) return;
    setIsImporting(true);

    const selectedInvoices = invoices.filter(inv => inv.id && selectedIds.has(inv.id));

    const newInboundOrders: InboundOrderTracking[] = selectedInvoices.map(inv => {
      const invNum = inv.invoice_metadata?.invoice_number || 'N/A';
      const vendorName = inv.issuer_details?.name || inv.supplier_details?.name || 'Vendor';
      const orderDate = inv.invoice_metadata?.invoice_date || new Date().toISOString().split('T')[0];
      const poNum = inv.invoice_metadata?.purchase_order_number || '';

      // Item summary & quantity calculation
      const items = inv.items || [];
      let itemSummary = 'General Inbound Material';
      let totalQty = 0;
      let commonUom = 'pcs';

      if (items.length > 0) {
        totalQty = items.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0);
        commonUom = items[0].item_type || 'pcs';

        if (items.length === 1) {
          itemSummary = items[0].description || 'Materials';
        } else {
          itemSummary = `${items[0].description} (+${items.length - 1} other item${items.length > 2 ? 's' : ''})`;
        }
      }

      const grandTotal = inv.totals?.grand_total || 0;
      const formattedTotal = grandTotal.toLocaleString('en-IN');

      return {
        id: `inb_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        order_date: orderDate,
        item_name: itemSummary,
        supplier_name: vendorName,
        transport_number: inv.invoice_metadata?.ewaybill_number || invNum,
        quantity: totalQty > 0 ? totalQty : undefined,
        uom: commonUom,
        is_ordered: true,
        is_received: false,
        is_invoice_recorded: true, // Auto-marked since pulled from Finance Invoices
        notes: `Inv #${invNum} ${poNum ? `| PO: ${poNum} ` : ''}| ₹${formattedTotal}`,
        timestamp: Date.now(),
        created_by: currentUser?.name || currentUser?.username || 'Staff',
        invoice_number: invNum,
        invoice_id: inv.id,
        po_number: poNum,
      };
    });

    onImportInvoices(newInboundOrders);
    setIsImporting(false);
    onClose();
  };

  if (!isOpen) return null;

  const selectableInvoices = filteredInvoices.filter(inv => !isInvoiceLinked(inv));
  const isAllSelected = selectableInvoices.length > 0 && selectableInvoices.every(inv => selectedIds.has(inv.id as string));
  const totalUnlinkedCount = invoices.filter(inv => !isInvoiceLinked(inv)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
      <div className="bg-white w-full max-w-4xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 bg-gradient-to-r from-slate-900 to-slate-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-300 text-lg">
              🔄
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-white tracking-wide">
                Import Purchase Invoices to Inbound Tracking
              </h2>
              <p className="text-[11px] sm:text-xs text-slate-300">
                Connect vendor invoices from Finance into the factory receipt & logistics workflow.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white flex items-center justify-center transition-colors text-base"
            title="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Search, Filter & Quick Options */}
        <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
          {/* Search Box */}
          <div className="relative flex-1">
            <span className="absolute left-3 top-2.5 text-slate-400 text-xs">🔍</span>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search by Invoice #, Vendor name, or PO Reference..."
              className="w-full pl-8 pr-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-medium focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all shadow-2xs"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 text-xs font-bold"
              >
                ✕
              </button>
            )}
          </div>

          {/* Filter options */}
          <div className="flex items-center gap-3 justify-between sm:justify-end">
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-semibold text-slate-700">
              <input
                type="checkbox"
                checked={filterUnlinkedOnly}
                onChange={e => setFilterUnlinkedOnly(e.target.checked)}
                className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300 cursor-pointer"
              />
              <span>Unlinked only</span>
              <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-indigo-100 text-indigo-700 font-bold">
                {totalUnlinkedCount}
              </span>
            </label>
          </div>
        </div>

        {/* Table Content Area */}
        <div className="flex-1 overflow-y-auto min-h-[300px]">
          {loading ? (
            /* Skeleton Loading State */
            <div className="p-5 space-y-3 animate-pulse">
              <div className="h-9 bg-slate-200 rounded-lg w-full"></div>
              {[...Array(6)].map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-3 px-2 border-b border-slate-100">
                  <div className="w-5 h-5 bg-slate-200 rounded"></div>
                  <div className="h-4 bg-slate-200 rounded w-24"></div>
                  <div className="h-4 bg-slate-200 rounded w-44"></div>
                  <div className="h-4 bg-slate-200 rounded w-28"></div>
                  <div className="h-4 bg-slate-200 rounded w-32"></div>
                  <div className="h-4 bg-slate-200 rounded w-20 ml-auto"></div>
                </div>
              ))}
            </div>
          ) : filteredInvoices.length === 0 ? (
            /* Empty States */
            <div className="py-16 px-4 text-center">
              {invoices.length > 0 && totalUnlinkedCount === 0 && filterUnlinkedOnly ? (
                <div className="max-w-md mx-auto space-y-2">
                  <span className="text-4xl block">🎉</span>
                  <h3 className="text-sm font-bold text-slate-800">
                    All purchase invoices are currently linked.
                  </h3>
                  <p className="text-xs text-slate-500">
                    All open purchase invoices from Finance have already been imported into Factory Inbound Tracking.
                  </p>
                  <button
                    onClick={() => setFilterUnlinkedOnly(false)}
                    className="mt-2 text-xs font-bold text-indigo-600 hover:text-indigo-800 underline"
                  >
                    View previously linked invoices
                  </button>
                </div>
              ) : (
                <div className="max-w-md mx-auto space-y-2">
                  <span className="text-4xl block">🔍</span>
                  <h3 className="text-sm font-bold text-slate-800">No matching purchase invoices found</h3>
                  <p className="text-xs text-slate-500">
                    {searchTerm
                      ? `No invoices match "${searchTerm}". Try adjusting your search query.`
                      : 'No purchase invoices available in Finance records.'}
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Loaded Table */
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100/80 sticky top-0 border-b border-slate-200 z-10 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th className="py-2.5 px-3 w-10 text-center">
                      <input
                        type="checkbox"
                        checked={isAllSelected}
                        onChange={handleToggleSelectAll}
                        disabled={selectableInvoices.length === 0}
                        className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300 cursor-pointer disabled:opacity-40"
                        title="Select All Unlinked"
                      />
                    </th>
                    <th className="py-2.5 px-3 min-w-[130px]">Invoice #</th>
                    <th className="py-2.5 px-3 min-w-[180px]">Vendor Name</th>
                    <th className="py-2.5 px-3 min-w-[110px]">Issue Date</th>
                    <th className="py-2.5 px-3 min-w-[200px]">Item Summary & Qty</th>
                    <th className="py-2.5 px-3 min-w-[110px] text-right">Total Amount</th>
                    <th className="py-2.5 px-3 min-w-[100px] text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredInvoices.map(inv => {
                    const isLinked = isInvoiceLinked(inv);
                    const invId = inv.id as string;
                    const isSelected = selectedIds.has(invId);
                    const invNum = inv.invoice_metadata?.invoice_number || 'N/A';
                    const vendor = inv.issuer_details?.name || inv.supplier_details?.name || 'Vendor';
                    const dateStr = inv.invoice_metadata?.invoice_date
                      ? new Date(inv.invoice_metadata.invoice_date + 'T00:00:00').toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })
                      : '—';
                    const poRef = inv.invoice_metadata?.purchase_order_number;

                    const items = inv.items || [];
                    const totalQty = items.reduce((acc, curr) => acc + (Number(curr.quantity) || 0), 0);
                    const itemDesc = items.length > 0 ? items[0].description : 'Materials';
                    const grandTotal = inv.totals?.grand_total || 0;

                    return (
                      <tr
                        key={invId}
                        onClick={() => {
                          if (!isLinked) handleToggleSelect(invId);
                        }}
                        className={`transition-colors cursor-pointer select-none ${
                          isLinked
                            ? 'bg-slate-50/60 opacity-60 cursor-not-allowed'
                            : isSelected
                            ? 'bg-indigo-50/80 hover:bg-indigo-100/70'
                            : 'hover:bg-slate-50/80'
                        }`}
                      >
                        {/* Checkbox */}
                        <td className="py-2.5 px-3 text-center" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={isLinked}
                            onChange={() => handleToggleSelect(invId)}
                            className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300 cursor-pointer disabled:cursor-not-allowed"
                          />
                        </td>

                        {/* Invoice # & PO */}
                        <td className="py-2.5 px-3 font-semibold text-slate-900">
                          <div className="font-mono font-bold text-slate-800">{invNum}</div>
                          {poRef && (
                            <span className="text-[10px] text-slate-400 font-mono">PO: {poRef}</span>
                          )}
                        </td>

                        {/* Vendor Name */}
                        <td className="py-2.5 px-3 font-semibold text-slate-800">
                          <div className="truncate max-w-[220px]" title={vendor}>
                            {vendor}
                          </div>
                        </td>

                        {/* Issue Date */}
                        <td className="py-2.5 px-3 whitespace-nowrap text-slate-600 font-medium">
                          {dateStr}
                        </td>

                        {/* Item Summary / Quantity */}
                        <td className="py-2.5 px-3 text-slate-700">
                          <div className="truncate max-w-[240px] font-medium" title={itemDesc}>
                            {itemDesc}
                            {items.length > 1 && (
                              <span className="text-[10px] text-indigo-600 font-bold ml-1">
                                (+{items.length - 1} more)
                              </span>
                            )}
                          </div>
                          {totalQty > 0 && (
                            <div className="text-[10px] text-slate-500 font-mono">
                              Total Qty: <strong>{totalQty} {items[0]?.item_type || 'pcs'}</strong>
                            </div>
                          )}
                        </td>

                        {/* Total Amount */}
                        <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                          ₹{grandTotal.toLocaleString('en-IN')}
                        </td>

                        {/* Status */}
                        <td className="py-2.5 px-3 text-center">
                          {isLinked ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200 text-slate-700">
                              ✓ Linked
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                              Ready
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Load More Pagination */}
          {!loading && hasMore && (
            <div className="p-3 bg-slate-50 border-t border-slate-100 flex justify-center">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="px-4 py-1.5 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-xl border border-slate-300 shadow-2xs transition-all flex items-center gap-2 disabled:opacity-60 cursor-pointer"
              >
                {loadingMore ? (
                  <>
                    <span className="animate-spin text-xs">⏳</span>
                    <span>Loading next 10 invoices...</span>
                  </>
                ) : (
                  <>
                    <span>⬇ Load Next 10 Invoices</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Action Controls Footer */}
        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500 font-medium">
            {selectedIds.size > 0 ? (
              <span className="text-indigo-700 font-bold">
                ✓ {selectedIds.size} invoice{selectedIds.size > 1 ? 's' : ''} selected for import
              </span>
            ) : (
              <span>Select purchase invoices to import into Factory Inbound Tracking</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isImporting}
              className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition-colors shadow-2xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              disabled={selectedIds.size === 0 || isImporting}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-bold text-xs rounded-xl shadow-md transition-all flex items-center gap-1.5 disabled:cursor-not-allowed cursor-pointer"
            >
              {isImporting ? (
                <span>Importing...</span>
              ) : (
                <span>Import Selected ({selectedIds.size})</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
