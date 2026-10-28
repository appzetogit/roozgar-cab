import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Car, CheckCircle2, ChevronRight, FileText, Search, XCircle } from 'lucide-react';
import { adminService } from '../../services/adminService';

const TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

const BADGE = {
  pending: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  approved: 'bg-green-50 text-green-700 border-green-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
};

const resolveUrl = (u) =>
  !u ? '' : (/^(https?:|data:)/.test(u) ? u : `${globalThis.__LEGACY_BACKEND_ORIGIN__ || ''}${u}`);

const formatDate = (value) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const DriverVehicleRequests = () => {
  const [status, setStatus] = useState('pending');
  const [searchTerm, setSearchTerm] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [paginator, setPaginator] = useState({ current_page: 1, last_page: 1, total: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  // Debounce search and reset to first page.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchTerm.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const fetchRequests = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await adminService.getDriverVehicleRequests({ status, search, page, limit: 50 });
      if (response?.success) {
        setRows(response.data?.results || []);
        setPendingCount(response.data?.pendingCount || 0);
        setPaginator(response.data?.paginator || { current_page: 1, last_page: 1, total: 0 });
      } else {
        setError(response?.message || 'Unable to load vehicle requests');
      }
    } catch (e) {
      setError(e?.message || 'Unable to load vehicle requests');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search, page]);

  const run = async (call, okMsg) => {
    setIsSubmitting(true);
    try {
      const response = await call();
      if (response?.success) {
        toast.success(okMsg);
        fetchRequests();
        return true;
      }
      toast.error(response?.message || 'Action failed');
    } catch (e) {
      toast.error(e?.message || 'Action failed');
      fetchRequests();
    } finally {
      setIsSubmitting(false);
    }
    return false;
  };

  const handleApprove = (item) => {
    if (!window.confirm(`Approve ${item.vehicleNumber || 'this vehicle'} for ${item.driver?.name || 'this driver'}?`)) return;
    run(() => adminService.approveDriverVehicleRequest(item.id), 'Vehicle request approved');
  };

  const handleReject = async () => {
    const ok = await run(() => adminService.rejectDriverVehicleRequest(rejecting.id, reason.trim()), 'Vehicle request rejected');
    if (ok) { setRejecting(null); setReason(''); }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-3 lg:p-4 font-sans text-gray-900 space-y-4">
      <div>
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-0.5">
          <span>Driver Management</span>
          <ChevronRight size={10} />
          <span className="text-gray-700 font-medium">Vehicle Requests</span>
        </div>
        <h1 className="text-base font-bold text-gray-900">Driver vehicle requests</h1>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">{error}</div>
      ) : null}

      <div className="bg-white rounded-lg border border-gray-200 p-3 space-y-3">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-50 rounded-lg text-yellow-600"><Car size={18} /></div>
            <div>
              <h2 className="text-sm font-bold text-gray-900">Vehicle requests</h2>
              <p className="text-xs text-gray-500">{pendingCount} pending requests</p>
            </div>
          </div>
          <div className="relative w-full md:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              type="text"
              placeholder="Search by driver name, mobile or vehicle number"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-white border border-gray-200 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:border-yellow-400 transition-colors"
            />
          </div>
        </div>
        <div className="flex gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => { setStatus(t.key); setPage(1); }}
              className={`px-3 py-1 rounded-md text-xs font-semibold border transition-colors ${status === t.key ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse whitespace-nowrap">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2">Driver</th>
                <th className="px-3 py-2">Requested vehicle</th>
                <th className="px-3 py-2">Photo</th>
                <th className="px-3 py-2">Documents</th>
                <th className="px-3 py-2">Requested at</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs text-gray-700">
              {isLoading ? (
                <tr>
                  <td colSpan="7" className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-8 h-8 border-4 border-gray-100 border-t-black rounded-full animate-spin"></div>
                      <p className="text-[12px] font-black text-gray-400 uppercase tracking-widest">Loading vehicle requests...</p>
                    </div>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Car size={32} className="text-gray-300 mb-2" />
                      <p className="text-sm font-bold text-gray-900">No vehicle requests</p>
                      <p className="text-xs text-gray-500">New requests will automatically appear here.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2">
                      <p className="text-xs font-medium text-gray-900">{item.driver?.name || 'Unknown'}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{item.driver?.phone || 'N/A'}</p>
                      {item.driver ? (
                        <p className="text-[10px] text-gray-400">has {item.driver.vehicleCount || 0} vehicle{item.driver.vehicleCount === 1 ? '' : 's'}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {item.vehicleIconUrl ? (
                          <img src={resolveUrl(item.vehicleIconUrl)} alt="" className="w-7 h-7 object-contain" />
                        ) : null}
                        <div>
                          <p className="text-xs font-medium text-gray-900">{item.vehicleTypeName || item.vehicleType || 'N/A'}</p>
                          <p className="text-[10px] text-gray-500">{[item.vehicleMake, item.vehicleModel].filter(Boolean).join(' ') || 'N/A'}</p>
                          <p className="text-[10px] text-gray-500">
                            <span className="font-mono font-semibold">{item.vehicleNumber || 'N/A'}</span>
                            {item.vehicleColor ? ` · ${item.vehicleColor}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {item.vehicleImage ? (
                        <a href={resolveUrl(item.vehicleImage)} target="_blank" rel="noreferrer">
                          <img src={resolveUrl(item.vehicleImage)} alt="Vehicle" className="w-12 h-9 object-cover rounded border border-gray-200" />
                        </a>
                      ) : <span className="text-[10px] text-gray-400">No photo</span>}
                    </td>
                    <td className="px-3 py-2">
                      {Object.keys(item.documents || {}).length === 0 ? (
                        <span className="text-[10px] text-gray-400">None</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {Object.entries(item.documents).map(([name, url]) => (
                            <a key={name} href={resolveUrl(url)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] font-semibold text-blue-600 hover:underline">
                              <FileText size={11} /> {name}
                            </a>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-gray-500">{formatDate(item.createdAt)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold capitalize ${BADGE[item.status] || BADGE.pending}`}>{item.status}</span>
                      {item.status === 'rejected' && item.rejectionReason ? (
                        <p className="text-[10px] text-gray-500 mt-0.5 max-w-[160px] truncate" title={item.rejectionReason}>{item.rejectionReason}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {item.status === 'pending' ? (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            disabled={isSubmitting}
                            onClick={() => handleApprove(item)}
                            className="px-2.5 py-1 bg-green-50 text-green-700 rounded-md text-[10px] font-semibold hover:bg-green-100 transition-colors border border-green-200 disabled:opacity-50 flex items-center gap-1"
                          >
                            <CheckCircle2 size={12} /> Approve
                          </button>
                          <button
                            disabled={isSubmitting}
                            onClick={() => { setRejecting(item); setReason(''); }}
                            className="px-2.5 py-1 bg-red-50 text-red-700 rounded-md text-[10px] font-semibold hover:bg-red-100 transition-colors border border-red-200 disabled:opacity-50 flex items-center gap-1"
                          >
                            <XCircle size={12} /> Reject
                          </button>
                        </div>
                      ) : <span className="text-[10px] text-gray-400">{formatDate(item.reviewedAt)}</span>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="p-3 bg-gray-50/50 border-t border-gray-100 flex items-center justify-between text-sm">
          <p className="text-[11px] text-gray-500">
            {paginator.total} request{paginator.total === 1 ? '' : 's'} · page {paginator.current_page} of {paginator.last_page || 1}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1.5 border border-gray-200 rounded-md text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= (paginator.last_page || 1) || isLoading}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 border border-gray-200 rounded-md text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {rejecting ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4 space-y-3">
            <h3 className="text-sm font-bold text-gray-900">
              Reject {rejecting.vehicleNumber || 'vehicle'} for {rejecting.driver?.name || 'driver'}
            </h3>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (optional)"
              className="w-full border border-gray-200 rounded-md p-2 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(null)}
                className="px-3 py-1.5 border border-gray-200 rounded-md text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleReject}
                className="px-3 py-1.5 bg-red-600 text-white rounded-md text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                Reject request
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default DriverVehicleRequests;
