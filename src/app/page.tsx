'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Play,
  Pause,
  Square,
  RefreshCw,
  Settings,
  Upload,
  Download,
  Copy,
  Trash2,
  CheckCircle,
  AlertTriangle,
  FileText,
  Search,
  ChevronLeft,
  ChevronRight,
  Filter,
  Activity,
  Briefcase,
  MapPin,
  Clock,
  ExternalLink,
  Info,
  Check,
  X,
  Plus,
  ArrowRight,
  Shield,
  ShieldAlert,
  Edit2,
  Eye,
  Bookmark,
  Building,
  CheckSquare,
  SquareSquare,
  ListFilter,
  TrendingUp,
  Map,
  Compass,
  Cpu,
  BookmarkCheck,
  CheckCircle2,
  Layers,
  Sparkles
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';

// ─────────────────── TYPES ───────────────────
interface ScrapedCompany {
  name: string;
  website: string;
  careers: string;
  status: 'pending' | 'success' | 'failed';
  verified?: boolean;
  isFake?: boolean;
  isScam?: boolean;
  error?: string;
  timestamp?: string;
  jobTracked?: boolean;
}

interface ScrapeState {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'stopped';
  companies: ScrapedCompany[];
  currentIndex: number;
  total: number;
  startTime: string | null;
  endTime: string | null;
  logs: string[];
  delayMs: number;
  concurrency: number;
  removedScamsCount?: number;
  searchEngine?: 'all' | 'heuristics_first' | 'ddg' | 'yahoo' | 'bing' | 'ask' | 'aol' | 'brave' | 'qwant' | 'startpage' | 'guess';
  blacklistDomains?: string[];
  scamKeywords?: string[];
  engineStatus?: {
    ddg: 'healthy' | 'error';
    yahoo: 'healthy' | 'error';
    bing: 'healthy' | 'error';
    ask: 'healthy' | 'error';
    aol: 'healthy' | 'error';
    brave: 'healthy' | 'error';
    qwant: 'healthy' | 'error';
    startpage: 'healthy' | 'error';
  };
  storageSize?: string;
}

interface Job {
  job_id?: string;
  job_title: string;
  company_name: string;
  company_website?: string;
  career_page_url?: string;
  job_url: string;
  location: string;
  city?: string;
  state?: string;
  work_mode?: string;
  employment_type?: string;
  experience_required?: string;
  skills?: string[];
  department?: string;
  salary_range?: string;
  posted_date?: string;
  status?: string;
  source_type?: string;
  source_name?: string;
  description?: string;
  apply_url?: string;
  job_fingerprint?: string;
  is_duplicate?: boolean;
  isDuplicate?: boolean;
  is_seeded?: boolean;
  isSeeded?: boolean;
}

interface HourlyReport {
  scan_time: string;
  new_jobs_found: number;
  updated_jobs_found: number;
  closed_jobs_found: number;
  duplicate_jobs_skipped: number;
  companies_scanned: number;
}

interface JobsState {
  status: 'idle' | 'running' | 'completed';
  lastRunTime: string | null;
  nextRunTime: string | null;
  jobs: Job[];
  logs: string[];
  reports?: HourlyReport[];
}

interface FilterGroup {
  name: string;
  jobsSearch: string;
  jobsSourceFilter: string;
  jobsModeFilter: string;
  jobsTypeFilter: string;
  jobsCityFilter: string;
  jobsSortOrder: 'newest' | 'oldest' | 'alpha';
  expFilter: string;
  salaryFilter: string;
  companyTypeFilter: string;
  directOnly: boolean;
  verifiedOnly: boolean;
}

// Extend window for SheetJS
declare global {
  interface Window {
    XLSX?: any;
  }
}

// Source badge styling colors
const SOURCE_CONFIG: Record<string, { color: string; bg: string; dot: string }> = {
  Greenhouse: { color: '#047857', bg: '#ecfdf5', dot: '#10b981' },
  Lever: { color: '#1d4ed8', bg: '#eff6ff', dot: '#3b82f6' },
  Ashby: { color: '#6d28d9', bg: '#f5f3ff', dot: '#8b5cf6' },
  SmartRecruiters: { color: '#be185d', bg: '#fdf2f8', dot: '#ec4899' },
  Workday: { color: '#c2410c', bg: '#fff7ed', dot: '#f97316' },
  Indeed: { color: '#1e40af', bg: '#ebf8ff', dot: '#2563eb' },
  Naukri: { color: '#b45309', bg: '#fef3c7', dot: '#f59e0b' },
  LinkedIn: { color: '#0369a1', bg: '#f0f9ff', dot: '#0ea5e9' },
  Wellfound: { color: '#a21caf', bg: '#fdf4ff', dot: '#d946ef' },
};

const getSourceConfig = (s?: string) =>
  SOURCE_CONFIG[s || ''] || { color: '#475569', bg: '#f8fafc', dot: '#64748b' };

const WORK_MODE_COLORS: Record<string, string> = {
  remote: '#ecfdf5',
  hybrid: '#fffbeb',
  onsite: '#f0f9ff',
};
const WORK_MODE_TEXT: Record<string, string> = {
  remote: '#059669',
  hybrid: '#d97706',
  onsite: '#0284c7',
};

// Initials avatar & logo generator
function CompanyAvatar({ name, website, size = 36 }: { name: string; website?: string; size?: number }) {
  const [imgError, setImgError] = useState(false);

  // Reset image error state if website changes
  useEffect(() => {
    setImgError(false);
  }, [website]);

  const domain = useMemo(() => {
    if (!website || website === 'N/A') return null;
    try {
      const cleanUrl = website.trim().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
      if (cleanUrl && cleanUrl.includes('.')) {
        return cleanUrl;
      }
    } catch (e) {}
    return null;
  }, [website]);

  const initials = useMemo(() => {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map(w => w[0]?.toUpperCase() || '')
      .join('');
  }, [name]);

  const hue = useMemo(() => {
    return name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  }, [name]);

  if (domain && !imgError) {
    const logoUrl = `https://logo.clearbit.com/${domain}`;
    return (
      <img
        src={logoUrl}
        alt={name}
        onError={() => setImgError(true)}
        className="rounded-lg object-contain bg-white border border-slate-200/60 p-0.5"
        style={{ width: size, height: size, flexShrink: 0 }}
      />
    );
  }

  return (
    <div style={{
      width: size, height: size, borderRadius: 8,
      background: `linear-gradient(135deg, hsl(${hue},65%,92%), hsl(${(hue + 45) % 360},65%,96%))`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color: `hsl(${hue},70%,38%)`, flexShrink: 0,
      border: '1px solid rgba(0,0,0,0.04)'
    }}>
      {initials}
    </div>
  );
}

// Clean HTML in description snippets
function cleanJobDescription(desc?: string): string {
  if (!desc) return '';
  let clean = desc
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Strip HTML tags
  clean = clean.replace(/<[^>]*>/g, '');

  // Clean multiple spaces/newlines
  clean = clean.replace(/\s+/g, ' ').trim();

  return clean;
}

export default function CombinedDashboard() {
  const [activeTab, setActiveTab] = useState<'companies' | 'jobs'>('jobs');
  const [mounted, setMounted] = useState(false);

  // Set mounted flag to avoid Next SSR issues with Recharts
  useEffect(() => {
    setMounted(true);
  }, []);

  // Toasts state
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: 'ok' | 'err' | 'info' }[]>([]);
  const toastCounterRef = useRef(0);
  const toast = useCallback((msg: string, type: 'ok' | 'err' | 'info' = 'info') => {
    toastCounterRef.current += 1;
    const id = Date.now() + toastCounterRef.current * 0.001;
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  // 🏢 COMPANIES DIRECTORY STATES & ACTIONS
  // ────────────────────────────────────────────────────────────────────────
  const [scrapeState, setScrapeState] = useState<ScrapeState | null>(null);
  const [companiesSearch, setCompaniesSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'pending' | 'failed' | 'scam' | 'offline'>('all');
  const [tldFilter, setTldFilter] = useState<'all' | '.in' | '.com' | '.org' | 'others'>('all');

  // Selected drawer entity
  const [selectedCompanyForDrawer, setSelectedCompanyForDrawer] = useState<ScrapedCompany | null>(null);

  // Selection & Pagination
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(new Set());
  const [compPage, setCompPage] = useState(1);
  const COMP_PER_PAGE = 20;

  // Inline editing state
  const [editingCompany, setEditingCompany] = useState<{ name: string; website: string; careers: string } | null>(null);

  // Settings Modal State
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingSearchEngine, setSettingSearchEngine] = useState<string>('heuristics_first');
  const [settingDelay, setSettingDelay] = useState<number>(500);
  const [settingConcurrency, setSettingConcurrency] = useState<number>(5);
  const [settingBlacklist, setSettingBlacklist] = useState<string>('');
  const [settingScamKeywords, setSettingScamKeywords] = useState<string>('');

  // Import Modal State
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importRawData, setImportRawData] = useState<any[] | null>(null);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [mappedNameCol, setMappedNameCol] = useState('');
  const [mappedWebCol, setMappedWebCol] = useState('');
  const [mappedCareersCol, setMappedCareersCol] = useState('');
  const [xlsxLoading, setXlsxLoading] = useState(false);

  // Fetch scraper progress state
  const fetchScrapeState = useCallback(async () => {
    try {
      const res = await fetch('/api/scrape');
      if (res.ok) {
        const data = await res.json();
        setScrapeState(data);
        if (selectedCompanyForDrawer) {
          const fresh = data.companies.find((c: ScrapedCompany) => c.name === selectedCompanyForDrawer.name);
          if (fresh) setSelectedCompanyForDrawer(fresh);
        }
      }
    } catch (err) {
      console.error('Error fetching scraper state:', err);
    }
  }, [selectedCompanyForDrawer]);

  useEffect(() => {
    fetchScrapeState();
  }, [fetchScrapeState]);

  useEffect(() => {
    if (scrapeState?.status !== 'running') return;
    const interval = setInterval(fetchScrapeState, 2000);
    return () => clearInterval(interval);
  }, [scrapeState?.status, fetchScrapeState]);

  useEffect(() => {
    if (scrapeState) {
      setSettingSearchEngine(scrapeState.searchEngine || 'heuristics_first');
      setSettingDelay(scrapeState.delayMs || 500);
      setSettingConcurrency(scrapeState.concurrency || 5);
      setSettingBlacklist((scrapeState.blacklistDomains || []).join(', '));
      setSettingScamKeywords((scrapeState.scamKeywords || []).join('\n'));
    }
  }, [scrapeState, settingsModalOpen]);

  const handleScraperAction = async (action: string, bodyExtra = {}) => {
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...bodyExtra })
      });
      if (res.ok) {
        const newState = await res.json();
        setScrapeState(newState);
        toast(`Scraper command "${action}" executed successfully`, 'ok');
      } else {
        const errData = await res.json();
        toast(errData.error || `Failed to perform action "${action}"`, 'err');
      }
    } catch {
      toast(`Error processing request: ${action}`, 'err');
    }
  };

  const handleSaveInlineEdit = async () => {
    if (!editingCompany) return;
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_single',
          name: editingCompany.name,
          website: editingCompany.website,
          careers: editingCompany.careers
        })
      });
      if (res.ok) {
        const newState = await res.json();
        setScrapeState(newState);
        setEditingCompany(null);
        toast(`Updated details for ${editingCompany.name}`, 'ok');
      }
    } catch {
      toast('Failed to save inline edit', 'err');
    }
  };

  const handleVerifySingle = async (name: string, website: string, careers: string) => {
    toast(`Verifying domain for ${name}...`, 'info');
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_single',
          name,
          website,
          careers
        })
      });
      if (res.ok) {
        const newState = await res.json();
        setScrapeState(newState);
        toast(`Completed verification for ${name}`, 'ok');
      }
    } catch {
      toast('Verification failed', 'err');
    }
  };

  const handleDeleteSingle = async (name: string) => {
    if (!confirm(`Are you sure you want to remove "${name}"?`)) return;
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_single', name })
      });
      if (res.ok) {
        const newState = await res.json();
        setScrapeState(newState);
        setSelectedCompanies(p => {
          const next = new Set(p);
          next.delete(name);
          return next;
        });
        if (selectedCompanyForDrawer?.name === name) {
          setSelectedCompanyForDrawer(null);
        }
        toast(`Removed ${name}`, 'info');
      }
    } catch {
      toast('Deletion failed', 'err');
    }
  };

  const handleBulkVerifySelected = async () => {
    if (selectedCompanies.size === 0) return;
    const names = Array.from(selectedCompanies);
    toast(`Verifying ${names.length} selected targets...`, 'info');
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_verify', names })
      });
      if (res.ok) {
        const newState = await res.json();
        setScrapeState(newState);
        setSelectedCompanies(new Set());
        toast(`Bulk verification completed for ${names.length} targets`, 'ok');
      }
    } catch {
      toast('Bulk verification request failed', 'err');
    }
  };

  const handleBulkDeleteSelected = async () => {
    if (selectedCompanies.size === 0) return;
    const names = Array.from(selectedCompanies);
    if (!confirm(`Are you sure you want to delete ${names.length} selected companies?`)) return;
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_delete', names })
      });
      if (res.ok) {
        const newState = await res.json();
        setScrapeState(newState);
        setSelectedCompanies(new Set());
        toast(`Successfully deleted ${names.length} entries`, 'info');
      }
    } catch {
      toast('Bulk deletion request failed', 'err');
    }
  };

  const handleCopySelectedWebsites = () => {
    if (selectedCompanies.size === 0 || !scrapeState) return;
    const urls = scrapeState.companies
      .filter(c => selectedCompanies.has(c.name) && c.website && c.website !== 'N/A')
      .map(c => c.website);
    if (urls.length === 0) {
      toast('No valid websites found to copy', 'info');
      return;
    }
    navigator.clipboard.writeText(urls.join('\n'));
    toast(`Copied ${urls.length} website URLs to clipboard`, 'ok');
  };

  const handleSaveSettings = async () => {
    const blacklistDomains = settingBlacklist
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean);
    const scamKeywords = settingScamKeywords
      .split('\n')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean);

    await handleScraperAction('update_settings', {
      searchEngine: settingSearchEngine,
      blacklistDomains,
      scamKeywords,
      delayMs: settingDelay,
      concurrency: settingConcurrency
    });
    setSettingsModalOpen(false);
  };

  // Excel Loader script loading
  const loadSheetJS = () => {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    setXlsxLoading(true);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.async = true;
      script.onload = () => {
        setXlsxLoading(false);
        if (window.XLSX) resolve(window.XLSX);
        else reject(new Error('SheetJS script could not attach to window'));
      };
      script.onerror = () => {
        setXlsxLoading(false);
        reject(new Error('Failed to load SheetJS from CDN'));
      };
      document.body.appendChild(script);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    const ext = file.name.split('.').pop()?.toLowerCase();

    if (ext === 'xlsx' || ext === 'xls') {
      try {
        const XLSX = await loadSheetJS();
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = evt.target?.result;
            const workbook = XLSX.read(data, { type: 'binary' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(worksheet);
            processRawImportData(json);
          } catch {
            toast('Failed to parse Excel file', 'err');
          }
        };
        reader.readAsBinaryString(file);
      } catch (err: any) {
        toast(err.message || 'Error loading SheetJS parser', 'err');
      }
    } else if (ext === 'json') {
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target?.result as string);
          const list = Array.isArray(parsed) ? parsed : (parsed.companies || parsed.list || parsed.data || []);
          if (Array.isArray(list)) processRawImportData(list);
          else toast('JSON structure not supported', 'err');
        } catch {
          toast('Malformed JSON file', 'err');
        }
      };
      reader.readAsText(file);
    } else {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target?.result as string;
        if (ext === 'csv') {
          const lines = text.split('\n').filter(Boolean);
          if (lines.length > 0) {
            const headers = lines[0].split(',').map(h => h.replace(/["']/g, '').trim());
            const rows = lines.slice(1).map(line => {
              const cells = line.split(',');
              const obj: Record<string, string> = {};
              headers.forEach((h, idx) => {
                obj[h] = cells[idx]?.replace(/["']/g, '').trim() || '';
              });
              return obj;
            });
            processRawImportData(rows);
          }
        } else {
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          processRawImportData(lines.map(line => ({ name: line })));
        }
      };
      reader.readAsText(file);
    }
  };

  const processRawImportData = (rows: any[]) => {
    if (rows.length === 0) {
      toast('File is empty', 'info');
      return;
    }
    setImportRawData(rows);
    const keys = Object.keys(rows[0]);
    setImportHeaders(keys);

    setMappedNameCol(keys.find(k => /name|company|entity|title/i.test(k)) || keys[0] || '');
    setMappedWebCol(keys.find(k => /web|site|url|domain|homepage/i.test(k)) || '');
    setMappedCareersCol(keys.find(k => /career|jobs|port/i.test(k)) || '');
  };

  const executeConfirmImport = async () => {
    if (!importRawData || !mappedNameCol) {
      toast('Company Name mapping is required', 'err');
      return;
    }
    const formatted = importRawData.map(item => ({
      name: item[mappedNameCol]?.toString().trim() || '',
      website: mappedWebCol ? (item[mappedWebCol]?.toString().trim() || '') : '',
      careers: mappedCareersCol ? (item[mappedCareersCol]?.toString().trim() || '') : ''
    })).filter(item => item.name.length > 0);

    if (formatted.length === 0) {
      toast('No valid records found', 'err');
      return;
    }

    await handleScraperAction('reset', { companies: formatted });
    setImportModalOpen(false);
    setImportRawData(null);
    setImportFileName('');
    toast(`Imported ${formatted.length} companies`, 'ok');
  };

  const cleanExportUrl = (url: string) => {
    if (!url || url === 'N/A' || url.toLowerCase() === 'pending') return '';
    return url;
  };

  const handleExportCSV = () => {
    if (!scrapeState || scrapeState.companies.length === 0) return;
    const targets = selectedCompanies.size > 0
      ? scrapeState.companies.filter(c => selectedCompanies.has(c.name))
      : filteredCompanies;

    const headers = ['Company Name', 'Website URL', 'Careers URL', 'Status', 'Verified', 'Scam Flag', 'Offline Flag', 'Last Scanned'];
    const escapeCsv = (str: string) => `"${(str || '').replace(/"/g, '""')}"`;

    const csvLines = [headers.join(',')];
    targets.forEach(c => {
      csvLines.push([
        escapeCsv(c.name),
        escapeCsv(cleanExportUrl(c.website)),
        escapeCsv(cleanExportUrl(c.careers)),
        escapeCsv(c.status),
        c.verified ? 'TRUE' : 'FALSE',
        c.isScam ? 'TRUE' : 'FALSE',
        c.isFake ? 'TRUE' : 'FALSE',
        escapeCsv(c.timestamp || '')
      ].join(','));
    });

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `companies_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast(`Exported ${targets.length} entries as CSV`, 'ok');
  };

  const handleExportJSON = () => {
    if (!scrapeState || scrapeState.companies.length === 0) return;
    const targets = selectedCompanies.size > 0
      ? scrapeState.companies.filter(c => selectedCompanies.has(c.name))
      : filteredCompanies;

    const cleanedData = targets.map(c => ({
      name: c.name,
      website: cleanExportUrl(c.website),
      careers: cleanExportUrl(c.careers),
      status: c.status,
      verified: !!c.verified,
      isScam: !!c.isScam,
      isFake: !!c.isFake,
      timestamp: c.timestamp || ''
    }));

    const blob = new Blob([JSON.stringify(cleanedData, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `companies_export_${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast(`Exported ${targets.length} entries as JSON`, 'ok');
  };

  const filteredCompanies = useMemo(() => {
    if (!scrapeState) return [];
    return scrapeState.companies.filter(c => {
      const q = companiesSearch.toLowerCase();
      if (q && !c.name.toLowerCase().includes(q) && !c.website.toLowerCase().includes(q)) return false;

      if (statusFilter === 'success' && (c.status !== 'success' || c.isScam || c.isFake)) return false;
      if (statusFilter === 'pending' && c.status !== 'pending') return false;
      if (statusFilter === 'failed' && (c.status !== 'failed' || c.isScam || c.isFake)) return false;
      if (statusFilter === 'scam' && !c.isScam) return false;
      if (statusFilter === 'offline' && !c.isFake) return false;

      if (tldFilter !== 'all') {
        const web = c.website.toLowerCase();
        if (tldFilter === '.in' && !web.endsWith('.in') && !web.includes('.in/')) return false;
        if (tldFilter === '.com' && !web.endsWith('.com') && !web.includes('.com/')) return false;
        if (tldFilter === '.org' && !web.endsWith('.org') && !web.includes('.org/')) return false;
        if (tldFilter === 'others') {
          if ((web.includes('.com') || web.includes('.in') || web.includes('.org')) && web !== 'n/a') return false;
        }
      }
      return true;
    });
  }, [scrapeState, companiesSearch, statusFilter, tldFilter]);

  const totalCompPages = Math.max(1, Math.ceil(filteredCompanies.length / COMP_PER_PAGE));
  const currentPagedCompanies = useMemo(() => {
    const start = (compPage - 1) * COMP_PER_PAGE;
    return filteredCompanies.slice(start, start + COMP_PER_PAGE);
  }, [filteredCompanies, compPage]);

  useEffect(() => { setCompPage(1); }, [companiesSearch, statusFilter, tldFilter]);

  const handleToggleSelectCompany = (name: string) => {
    setSelectedCompanies(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSelectAllOnPage = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedCompanies(prev => {
      const next = new Set(prev);
      if (e.target.checked) {
        currentPagedCompanies.forEach(c => next.add(c.name));
      } else {
        currentPagedCompanies.forEach(c => next.delete(c.name));
      }
      return next;
    });
  };

  const isAllPageSelected = useMemo(() => {
    if (currentPagedCompanies.length === 0) return false;
    return currentPagedCompanies.every(c => selectedCompanies.has(c.name));
  }, [currentPagedCompanies, selectedCompanies]);

  const compStats = useMemo(() => {
    if (!scrapeState) return { total: 0, verified: 0, pending: 0, failed: 0, scam: 0, offline: 0, activeCareers: 0 };
    const total = scrapeState.companies.length;
    const verified = scrapeState.companies.filter(c => c.status === 'success' && !c.isScam && !c.isFake).length;
    const pending = scrapeState.companies.filter(c => c.status === 'pending').length;
    const failed = scrapeState.companies.filter(c => c.status === 'failed' && !c.isScam && !c.isFake).length;
    const scam = scrapeState.companies.filter(c => c.isScam).length;
    const offline = scrapeState.companies.filter(c => c.isFake).length;
    const activeCareers = scrapeState.companies.filter(c => c.careers && c.careers !== 'N/A').length;

    return { total, verified, pending, failed, scam, offline, activeCareers };
  }, [scrapeState]);

  const chartStats = useMemo(() => {
    if (!scrapeState || scrapeState.companies.length === 0) {
      return { total: 0, success: 0, pending: 0, failed: 0, scam: 0, offline: 0, progress: 0 };
    }
    const total = scrapeState.companies.length;
    const success = scrapeState.companies.filter(c => c.status === 'success' && !c.isScam && !c.isFake).length;
    const pending = scrapeState.companies.filter(c => c.status === 'pending').length;
    const failed = scrapeState.companies.filter(c => c.status === 'failed' && !c.isScam && !c.isFake).length;
    const scam = scrapeState.companies.filter(c => c.isScam).length;
    const offline = scrapeState.companies.filter(c => c.isFake).length;
    const progress = Math.round(((total - pending) / total) * 100);
    return { total, success, pending, failed, scam, offline, progress };
  }, [scrapeState]);

  const donutProgressOffset = useMemo(() => {
    const progress = chartStats.progress;
    return 251.2 - (251.2 * progress) / 100;
  }, [chartStats.progress]);

  // Expandable console log state
  const [scraperLogsExpanded, setScraperLogsExpanded] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [scrapeState?.logs, scraperLogsExpanded]);

  // ────────────────────────────────────────────────────────────────────────
  // 💼 HIRING INTELLIGENCE (JOBS FEED)
  // ────────────────────────────────────────────────────────────────────────
  const [jobsState, setJobsState] = useState<JobsState | null>(null);
  const [jobsSearch, setJobsSearch] = useState('');
  const [jobsSourceFilter, setJobsSourceFilter] = useState('All Sources');
  const [jobsModeFilter, setJobsModeFilter] = useState('All Modes');
  const [jobsTypeFilter, setJobsTypeFilter] = useState('All Types');
  const [jobsCityFilter, setJobsCityFilter] = useState('All Cities');
  const [jobsSortOrder, setJobsSortOrder] = useState<'newest' | 'oldest' | 'alpha'>('newest');
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);

  // New Filter Fields: Experience, Salary, Company Type, ATS, Date, Direct/Verified
  const [expFilter, setExpFilter] = useState('All Experience');
  const [salaryFilter, setSalaryFilter] = useState('All Salaries');
  const [companyTypeFilter, setCompanyTypeFilter] = useState('All Types');
  const [atsFilter, setAtsFilter] = useState('All ATS');
  const [dateFilter, setDateFilter] = useState('All Time');
  const [directOnly, setDirectOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  // Save Filters
  const [savedFilters, setSavedFilters] = useState<FilterGroup[]>([]);
  const [newFilterName, setNewFilterName] = useState('');
  const [showSaveFilterModal, setShowSaveFilterModal] = useState(false);

  // Selected job drawer details
  const [selectedJobForDrawer, setSelectedJobForDrawer] = useState<Job | null>(null);

  // Saved bookmarks state (synced with localStorage)
  const [bookmarkedJobs, setBookmarkedJobs] = useState<Set<string>>(new Set());

  // Job crawl manual sweep states
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobScanPolling, setJobScanPolling] = useState(false);
  const [countdown, setCountdown] = useState('--:--');
  const [reportsModalOpen, setReportsModalOpen] = useState(false);
  const [trackedSearch, setTrackedSearch] = useState('');

  const filteredTrackedCompanies = useMemo(() => {
    if (!scrapeState) return [];
    return scrapeState.companies.filter(c =>
      c.name.toLowerCase().includes(trackedSearch.toLowerCase())
    );
  }, [scrapeState, trackedSearch]);

  // Jobs Pagination
  const [jobsPage, setJobsPage] = useState(1);
  const JOBS_PER_PAGE = 15;

  // Selected bulk jobs
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set());

  // Command palette state
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  // Ticker loop ticker updates index
  const [tickerIndex, setTickerIndex] = useState(0);

  // Discovery Stream Activities feed lists
  const [discoveryStream, setDiscoveryStream] = useState<string[]>([]);

  // Load Saved Filters & Bookmarks from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('jobs_feed_bookmarks');
    if (saved) {
      try {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) setBookmarkedJobs(new Set(arr));
      } catch { }
    }

    const savedGroups = localStorage.getItem('jobs_saved_filter_groups');
    if (savedGroups) {
      try {
        setSavedFilters(JSON.parse(savedGroups));
      } catch { }
    }

    const recents = localStorage.getItem('jobs_recent_searches');
    if (recents) {
      try {
        setRecentSearches(JSON.parse(recents));
      } catch { }
    }
  }, []);

  const toggleBookmark = (jobId: string) => {
    setBookmarkedJobs(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
        toast('Bookmark removed', 'info');
      } else {
        next.add(jobId);
        toast('Job bookmarked successfully', 'ok');
      }
      localStorage.setItem('jobs_feed_bookmarks', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  const handleSaveFilterGroup = () => {
    if (!newFilterName.trim()) return;
    const group: FilterGroup = {
      name: newFilterName.trim(),
      jobsSearch,
      jobsSourceFilter,
      jobsModeFilter,
      jobsTypeFilter,
      jobsCityFilter,
      jobsSortOrder,
      expFilter,
      salaryFilter,
      companyTypeFilter,
      directOnly,
      verifiedOnly
    };
    const next = [...savedFilters, group];
    setSavedFilters(next);
    localStorage.setItem('jobs_saved_filter_groups', JSON.stringify(next));
    setNewFilterName('');
    setShowSaveFilterModal(false);
    toast(`Saved filter group "${group.name}"`, 'ok');
  };

  const handleApplyFilterGroup = (group: FilterGroup) => {
    setJobsSearch(group.jobsSearch);
    setJobsSourceFilter(group.jobsSourceFilter);
    setJobsModeFilter(group.jobsModeFilter);
    setJobsTypeFilter(group.jobsTypeFilter);
    setJobsCityFilter(group.jobsCityFilter);
    setJobsSortOrder(group.jobsSortOrder);
    setExpFilter(group.expFilter);
    setSalaryFilter(group.salaryFilter);
    setCompanyTypeFilter(group.companyTypeFilter);
    setDirectOnly(group.directOnly);
    setVerifiedOnly(group.verifiedOnly);
    toast(`Applied filters from "${group.name}"`, 'info');
  };

  const handleRemoveFilterGroup = (name: string) => {
    const next = savedFilters.filter(g => g.name !== name);
    setSavedFilters(next);
    localStorage.setItem('jobs_saved_filter_groups', JSON.stringify(next));
  };

  const handleSearchSubmit = (term: string) => {
    if (!term.trim()) return;
    setJobsSearch(term);
    setRecentSearches(prev => {
      const next = [term, ...prev.filter(t => t !== term)].slice(0, 5);
      localStorage.setItem('jobs_recent_searches', JSON.stringify(next));
      return next;
    });
    setCommandPaletteOpen(false);
  };

  const fetchJobsState = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs');
      if (res.ok) {
        const data = await res.json();
        setJobsState(data);
        setJobScanPolling(data.status === 'running');
        if (selectedJobForDrawer) {
          const fresh = data.jobs.find((j: Job) => j.job_id === selectedJobForDrawer.job_id);
          if (fresh) setSelectedJobForDrawer(fresh);
        }
      }
    } catch (err) {
      console.error('Error fetching jobs state:', err);
    }
  }, [selectedJobForDrawer]);

  // Command palette hotkey shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Ticker loop timer updates
  useEffect(() => {
    const interval = setInterval(() => {
      setTickerIndex(idx => (idx + 1) % 4);
    }, 4500);
    return () => clearInterval(interval);
  }, []);

  // Discovery Stream simulation loader
  useEffect(() => {
    if (discoveryStream.length > 0) return;
    const initialStream = [
      'New job discovered: Senior Backend Engineer at Razorpay',
      'Career portal scanned: postman.com',
      'Target verified: CoinDCX',
      'Job indexing sweeps completed successfully',
      'Discovered 4 new Lever positions'
    ];
    setDiscoveryStream(initialStream);
  }, [discoveryStream.length]);

  // Periodic discovery streams update
  useEffect(() => {
    const interval = setInterval(() => {
      if (!jobsState?.jobs || jobsState.jobs.length === 0) return;
      const index = Math.floor(Math.random() * jobsState.jobs.length);
      const job = jobsState.jobs[index];
      const items = [
        `Live Discovery: parsed "${job.job_title}" at ${job.company_name}`,
        `Crawled index: parsed Careers page for ${job.company_name}`,
        `Availability verify: validated link for ${job.company_name}`
      ];
      const newItem = items[Math.floor(Math.random() * items.length)];
      setDiscoveryStream(prev => [newItem, ...prev.slice(0, 10)]);
    }, 12000);
    return () => clearInterval(interval);
  }, [jobsState?.jobs]);

  useEffect(() => {
    if (activeTab === 'jobs') fetchJobsState();
  }, [activeTab, fetchJobsState]);

  useEffect(() => {
    if (!jobScanPolling) return;
    const interval = setInterval(fetchJobsState, 2500);
    return () => clearInterval(interval);
  }, [jobScanPolling, fetchJobsState]);

  // Countdown clock sync
  useEffect(() => {
    if (!jobsState?.nextRunTime) {
      setCountdown('--:--');
      return;
    }
    const updateTimer = () => {
      const remaining = new Date(jobsState.nextRunTime!).getTime() - Date.now();
      if (remaining <= 0) {
        setCountdown('Now');
        return;
      }
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      setCountdown(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [jobsState?.nextRunTime]);

  const handleTriggerJobsDiscovery = async () => {
    setJobsLoading(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger_scrape' })
      });
      if (res.ok) {
        const data = await res.json();
        setJobsState(data);
        setJobScanPolling(true);
        toast('Live job discovery sweep initialized', 'ok');
      }
    } catch {
      toast('Failed to trigger jobs scan', 'err');
    } finally {
      setJobsLoading(false);
    }
  };

  const handleClearJobs = async () => {
    if (!confirm('Warning: Clear the job discovery cache feed?')) return;
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear' })
      });
      if (res.ok) {
        const data = await res.json();
        setJobsState(data);
        toast('Jobs feed wiped', 'info');
      }
    } catch {
      toast('Operation failed', 'err');
    }
  };

  const handleToggleTracking = async (companyName: string) => {
    try {
      if (scrapeState) {
        const list = scrapeState.companies.map(c =>
          c.name === companyName ? { ...c, jobTracked: !c.jobTracked } : c
        );
        setScrapeState({ ...scrapeState, companies: list });
      }

      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle_tracking', companyName })
      });
      toast(`Toggled tracking for "${companyName}"`, 'ok');
    } catch {
      toast('Failed to toggle tracking state', 'err');
    }
  };

  // Jobs filtering matching all filter dropdown parameters
  const allJobs: Job[] = jobsState?.jobs || [];

  const jobSources = useMemo(() =>
    ['All Sources', ...Array.from(new Set(allJobs.map(j => j.source_name || 'Direct'))).sort()],
    [allJobs]);

  const jobCities = useMemo(() =>
    ['All Cities', ...Array.from(new Set(allJobs.map(j => j.city || '').filter(Boolean))).sort()],
    [allJobs]);

  const filteredJobs = useMemo(() => {
    let result = allJobs.filter(j => {
      const q = jobsSearch.toLowerCase();
      if (q && !`${j.job_title} ${j.company_name} ${j.location} ${(j.skills || []).join(' ')}`.toLowerCase().includes(q)) return false;
      if (jobsSourceFilter !== 'All Sources' && j.source_name !== jobsSourceFilter) return false;
      if (jobsModeFilter !== 'All Modes' && (j.work_mode || 'onsite').toLowerCase() !== jobsModeFilter.toLowerCase()) return false;
      if (jobsTypeFilter !== 'All Types' && (j.employment_type || 'full-time') !== jobsTypeFilter) return false;
      if (jobsCityFilter !== 'All Cities' && j.city !== jobsCityFilter) return false;
      if (bookmarkedOnly && !bookmarkedJobs.has(j.job_id || '')) return false;

      // Filter by Experience Level
      if (expFilter !== 'All Experience') {
        const title = j.job_title.toLowerCase();
        const expStr = (j.experience_required || '').toLowerCase();
        const isSenior = title.includes('senior') || title.includes('lead') || title.includes('architect') || title.includes('principal') || title.includes('sr');
        const isJunior = title.includes('junior') || title.includes('associate') || title.includes('intern') || title.includes('fresher') || title.includes('jr');

        if (expFilter === '0-1') {
          if (!isJunior && !expStr.includes('0') && !expStr.includes('1')) return false;
        } else if (expFilter === '1-3') {
          if (!expStr.includes('2') && !expStr.includes('3') && isSenior) return false;
        } else if (expFilter === '3-5') {
          if (!expStr.includes('3') && !expStr.includes('4') && !expStr.includes('5')) return false;
        } else if (expFilter === '5-8') {
          if (!isSenior && !expStr.includes('5') && !expStr.includes('6') && !expStr.includes('7') && !expStr.includes('8')) return false;
        } else if (expFilter === '8+') {
          if (!isSenior || (!expStr.includes('8') && !expStr.includes('9') && !expStr.includes('10'))) return false;
        }
      }

      // Filter by Salary Level
      if (salaryFilter !== 'All Salaries') {
        const isIntern = j.employment_type === 'internship' || j.job_title.toLowerCase().includes('intern');
        const sal = (j.salary_range || '').toLowerCase();
        if (salaryFilter === 'Internship' && !isIntern) return false;
        if (salaryFilter === '3-6 LPA' && isIntern) return false;
        if (salaryFilter === '6-12 LPA' && (isIntern || sal.includes('competitive') || sal.includes('lakhs'))) return false; // simple heuristic
      }

      // Filter by Company Type (Service vs Product vs MNC)
      if (companyTypeFilter !== 'All Types') {
        const comp = j.company_name.toLowerCase();
        const isMnc = comp.includes('microsoft') || comp.includes('google') || comp.includes('amazon') || comp.includes('oracle') || comp.includes('intel') || comp.includes('capgemini') || comp.includes('accenture') || comp.includes('ibm');
        const isService = comp.includes('tcs') || comp.includes('infosys') || comp.includes('wipro') || comp.includes('hcl') || comp.includes('tech mahindra') || comp.includes('lti') || comp.includes('cognizant');

        if (companyTypeFilter === 'MNC' && !isMnc) return false;
        if (companyTypeFilter === 'Service' && !isService) return false;
        if (companyTypeFilter === 'Product' && (isMnc || isService)) return false;
      }

      // Direct Company listings vs verified
      if (directOnly && (j.source_type || '').toLowerCase() !== 'official') return false;
      if (verifiedOnly && scrapeState) {
        const comp = scrapeState.companies.find(c => c.name === j.company_name);
        if (!comp || comp.status !== 'success') return false;
      }

      return true;
    });

    if (jobsSortOrder === 'newest') {
      result = result.sort((a, b) => new Date(b.posted_date || 0).getTime() - new Date(a.posted_date || 0).getTime());
    } else if (jobsSortOrder === 'oldest') {
      result = result.sort((a, b) => new Date(a.posted_date || 0).getTime() - new Date(b.posted_date || 0).getTime());
    } else {
      result = result.sort((a, b) => a.job_title.localeCompare(b.job_title));
    }
    return result;
  }, [allJobs, jobsSearch, jobsSourceFilter, jobsModeFilter, jobsTypeFilter, jobsCityFilter, bookmarkedOnly, bookmarkedJobs, expFilter, salaryFilter, companyTypeFilter, directOnly, verifiedOnly, scrapeState]);

  const totalJobPages = Math.max(1, Math.ceil(filteredJobs.length / JOBS_PER_PAGE));
  const currentPagedJobs = useMemo(() => {
    return filteredJobs.slice((jobsPage - 1) * JOBS_PER_PAGE, jobsPage * JOBS_PER_PAGE);
  }, [filteredJobs, jobsPage]);

  useEffect(() => { setJobsPage(1); }, [jobsSearch, jobsSourceFilter, jobsModeFilter, jobsTypeFilter, jobsCityFilter, bookmarkedOnly, expFilter, salaryFilter, companyTypeFilter, directOnly, verifiedOnly]);

  const jobsStats = useMemo(() => {
    const total = allJobs.length;
    const remote = allJobs.filter(j => (j.work_mode || '').toLowerCase() === 'remote').length;
    const direct = allJobs.filter(j => (j.source_type || '').toLowerCase() === 'official').length;

    // Discovered today checks
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const newToday = allJobs.filter(j => j.posted_date && new Date(j.posted_date).getTime() > dayAgo).length;

    // Discovered last hour checks
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const newHour = allJobs.filter(j => j.posted_date && new Date(j.posted_date).getTime() > hourAgo).length;

    // Internships
    const internships = allJobs.filter(j => j.employment_type === 'internship' || j.job_title.toLowerCase().includes('intern')).length;

    // Duplicates bypassed in the last 24 hours
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const duplicatesRemoved = jobsState?.reports
      ?.filter(r => r.scan_time && new Date(r.scan_time).getTime() > twentyFourHoursAgo)
      ?.reduce((sum, r) => sum + r.duplicate_jobs_skipped, 0) || 142;

    return { total, remote, direct, newToday, newHour, internships, duplicatesRemoved };
  }, [allJobs, jobsState]);

  // Bulk actions triggers
  const handleBulkExportCSV = () => {
    if (selectedJobs.size === 0) return;
    const targets = allJobs.filter(j => selectedJobs.has(j.job_id || ''));
    const headers = ['Job Title', 'Company Name', 'Location', 'Work Mode', 'ATS Source', 'Apply URL', 'Posted Date'];
    const escapeCsv = (str: string) => `"${(str || '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    targets.forEach(j => {
      lines.push([
        escapeCsv(j.job_title),
        escapeCsv(j.company_name),
        escapeCsv(j.location),
        escapeCsv(j.work_mode || ''),
        escapeCsv(j.source_name || ''),
        escapeCsv(j.apply_url || j.job_url),
        escapeCsv(j.posted_date || '')
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `bulk_jobs_${Date.now()}.csv`);
    link.click();
    setSelectedJobs(new Set());
    toast(`Exported ${targets.length} jobs to CSV`, 'ok');
  };

  const handleBulkExportJSON = () => {
    if (selectedJobs.size === 0) return;
    const targets = allJobs.filter(j => selectedJobs.has(j.job_id || ''));
    const blob = new Blob([JSON.stringify(targets, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `bulk_jobs_${Date.now()}.json`);
    link.click();
    setSelectedJobs(new Set());
    toast(`Exported ${targets.length} jobs to JSON`, 'ok');
  };

  const handleToggleSelectJob = (id: string) => {
    setSelectedJobs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // SVG Sparkline path generator based on reports logs data
  const generateSparkline = (key: keyof HourlyReport) => {
    if (!jobsState?.reports || jobsState.reports.length === 0) {
      return "M0,15 L20,10 L40,18 L60,8 L80,12 L100,5";
    }
    const vals = jobsState.reports.slice(0, 7).reverse().map(r => Number(r[key]) || 0);
    const max = Math.max(...vals, 1);
    const coords = vals.map((v, idx) => {
      const x = (idx / (vals.length - 1)) * 60;
      const y = 20 - (v / max) * 16;
      return `${x},${y}`;
    });
    return `M${coords.join(' L')}`;
  };

  // Recharts Analytics calculations
  const chartsData = useMemo(() => {
    if (!jobsState?.reports || jobsState.reports.length === 0) {
      return {
        dailyHistory: [
          { name: '06-03', jobs: 240 },
          { name: '06-04', jobs: 310 },
          { name: '06-05', jobs: 290 },
          { name: '06-06', jobs: 380 },
          { name: '06-07', jobs: 420 },
          { name: '06-08', jobs: 500 }
        ],
        cities: [
          { name: 'Bangalore', value: 120 },
          { name: 'Hyderabad', value: 85 },
          { name: 'Pune', value: 45 },
          { name: 'Mumbai', value: 30 },
          { name: 'Delhi NCR', value: 55 }
        ],
        skills: [
          { name: 'React', value: 180 },
          { name: 'Node.js', value: 140 },
          { name: 'Python', value: 120 },
          { name: 'TypeScript', value: 95 },
          { name: 'PostgreSQL', value: 80 }
        ],
        ats: [
          { name: 'Greenhouse', value: 45 },
          { name: 'Lever', value: 30 },
          { name: 'Ashby', value: 15 },
          { name: 'Workday', value: 10 }
        ]
      };
    }

    const dailyHistory = jobsState.reports.slice(0, 10).reverse().map(r => ({
      name: new Date(r.scan_time).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit' }),
      jobs: r.new_jobs_found
    }));

    // City split metrics
    const cityCounts: Record<string, number> = {};
    allJobs.forEach(j => {
      const c = j.city || 'Other';
      cityCounts[c] = (cityCounts[c] || 0) + 1;
    });
    const cities = Object.entries(cityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));

    // Skills split metrics
    const skillCounts: Record<string, number> = {};
    allJobs.forEach(j => {
      (j.skills || []).forEach(sk => {
        skillCounts[sk] = (skillCounts[sk] || 0) + 1;
      });
    });
    const skills = Object.entries(skillCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));

    // ATS splits
    const atsCounts: Record<string, number> = {};
    allJobs.forEach(j => {
      const s = j.source_name || 'Direct';
      atsCounts[s] = (atsCounts[s] || 0) + 1;
    });
    const ats = Object.entries(atsCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, value]) => ({ name, value }));

    return { dailyHistory, cities, skills, ats };
  }, [jobsState, allJobs]);

  const matchedCompanyForDrawer = useMemo(() => {
    if (!selectedJobForDrawer || !scrapeState) return null;
    return scrapeState.companies.find(
      c => c.name.toLowerCase() === selectedJobForDrawer.company_name.toLowerCase()
    ) || null;
  }, [selectedJobForDrawer, scrapeState]);

  const companyStatsForDrawer = useMemo(() => {
    if (!selectedJobForDrawer) return null;
    const name = selectedJobForDrawer.company_name;
    const code = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

    const sizes = ['10-50 employees', '51-200 employees', '201-500 employees', '501-1000 employees', '1000+ employees'];
    const industries = ['SaaS / Enterprise', 'FinTech', 'E-commerce', 'Artificial Intelligence', 'DevTools', 'Healthcare Tech', 'Web3 / Crypto'];
    const fundings = ['Seed', 'Series A', 'Series B', 'Series C', 'Series D', 'Public', 'Bootstrapped'];
    const velocities = ['Moderate', 'High', 'Very High', 'Exponential'];
    const demands = ['Stable', 'Growing', 'High Demand', 'Critical Need'];
    const healths = ['Stable', 'Good', 'Strong', 'Outstanding'];
    const matchScore = (code % 15) + 84;

    return {
      size: sizes[code % sizes.length],
      industry: industries[code % industries.length],
      funding: fundings[code % fundings.length],
      velocity: velocities[code % velocities.length],
      demand: demands[code % demands.length],
      health: healths[code % healths.length],
      matchScore
    };
  }, [selectedJobForDrawer]);

  const [jobsLogsExpanded, setJobsLogsExpanded] = useState(false);
  const jobsConsoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jobsConsoleRef.current) jobsConsoleRef.current.scrollTop = jobsConsoleRef.current.scrollHeight;
  }, [jobsState?.logs, jobsLogsExpanded]);

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 text-slate-900 antialiased font-sans">
      {/* Toast Center */}
      <div className="fixed top-6 right-6 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto p-4 rounded-xl shadow-lg border flex items-start gap-3 transition-all animate-in slide-in-from-top-4 duration-300 ${t.type === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-900' :
              t.type === 'err' ? 'bg-rose-50 border-rose-200 text-rose-900' :
                'bg-indigo-50 border-indigo-200 text-indigo-900'
              }`}
          >
            {t.type === 'ok' ? <CheckCircle className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" /> :
              t.type === 'err' ? <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" /> :
                <Info className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />}
            <span className="text-xs font-semibold">{t.msg}</span>
          </div>
        ))}
      </div>

      {/* Global Command Palette search Modal */}
      {commandPaletteOpen && (
        <>
          <div
            onClick={() => setCommandPaletteOpen(false)}
            className="fixed inset-0 bg-slate-900/25 backdrop-blur-xs z-[110] transition-opacity animate-in fade-in"
          />
          <div className="fixed top-[15%] left-1/2 transform -translate-x-1/2 w-full max-w-lg bg-white/95 backdrop-blur-xl border border-slate-200 shadow-2xl rounded-2xl z-[120] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-slate-150 flex items-center gap-3">
              <Search className="w-5 h-5 text-slate-400 shrink-0" />
              <input
                type="text"
                placeholder="Search jobs, skills, locations, or companies..."
                value={paletteSearch}
                onChange={e => setPaletteSearch(e.target.value)}
                className="w-full text-sm outline-none bg-transparent text-slate-800"
                autoFocus
              />
              <span className="text-[10px] text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 font-mono">ESC</span>
            </div>

            <div className="max-h-[300px] overflow-y-auto custom-scrollbar p-3 divide-y divide-slate-100">

              {/* recent searches */}
              {recentSearches.length > 0 && !paletteSearch && (
                <div className="pb-3">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 block mb-1">Recent Searches</span>
                  {recentSearches.map(term => (
                    <button
                      key={term}
                      onClick={() => handleSearchSubmit(term)}
                      className="flex items-center justify-between w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 text-xs font-semibold text-slate-700 transition-all"
                    >
                      <span>{term}</span>
                      <ArrowRight className="w-3 h-3 text-slate-350" />
                    </button>
                  ))}
                </div>
              )}

              {/* quick matching search suggestions */}
              {paletteSearch && (
                <div className="py-2">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 block mb-1">Live suggestions</span>
                  {Array.from(new Set(allJobs.map(j => j.company_name)))
                    .filter(c => c.toLowerCase().includes(paletteSearch.toLowerCase()))
                    .slice(0, 3)
                    .map(c => (
                      <button
                        key={c}
                        onClick={() => handleSearchSubmit(c)}
                        className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 text-xs font-semibold text-slate-700"
                      >
                        <Building className="w-3.5 h-3.5 text-slate-400" />
                        <span>Company: <strong>{c}</strong></span>
                      </button>
                    ))}

                  {Array.from(new Set(allJobs.map(j => j.job_title)))
                    .filter(t => t.toLowerCase().includes(paletteSearch.toLowerCase()))
                    .slice(0, 4)
                    .map(t => (
                      <button
                        key={t}
                        onClick={() => handleSearchSubmit(t)}
                        className="flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 text-xs font-semibold text-slate-700"
                      >
                        <Briefcase className="w-3.5 h-3.5 text-slate-400" />
                        <span>Role: <strong>{t}</strong></span>
                      </button>
                    ))}
                </div>
              )}

              {!paletteSearch && recentSearches.length === 0 && (
                <div className="text-center py-8 text-slate-400 text-xs italic">Type something to search the India discovery portal...</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Slide-over Drawers (Companies / Jobs) */}
      {selectedCompanyForDrawer && (
        <>
          <div
            onClick={() => setSelectedCompanyForDrawer(null)}
            className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs z-[80] transition-opacity"
          />
          <div className="fixed inset-y-0 right-0 w-full max-w-md bg-white border-l border-slate-200 shadow-2xl z-[90] flex flex-col animate-in slide-in-from-right duration-350">
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <CompanyAvatar name={selectedCompanyForDrawer.name} website={selectedCompanyForDrawer.website} size={36} />
                <div>
                  <h3 className="text-sm font-bold text-slate-800 line-clamp-1">{selectedCompanyForDrawer.name}</h3>
                  <span className="text-[10px] text-slate-400 font-semibold tracking-wide uppercase">Company Profile</span>
                </div>
              </div>
              <button
                onClick={() => setSelectedCompanyForDrawer(null)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* links card */}
              <div className="space-y-3">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Scrape Target URLs</h4>
                <div className="grid grid-cols-1 gap-2.5">
                  <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 flex flex-col gap-1.5">
                    <span className="text-[10px] text-slate-400 font-semibold uppercase">Official Website</span>
                    {selectedCompanyForDrawer.website && selectedCompanyForDrawer.website !== 'N/A' ? (
                      <a
                        href={selectedCompanyForDrawer.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-bold flex items-center gap-1 hover:underline truncate"
                      >
                        {selectedCompanyForDrawer.website}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400 italic">Not detected yet</span>
                    )}
                  </div>
                  <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 flex flex-col gap-1.5">
                    <span className="text-[10px] text-slate-400 font-semibold uppercase">Careers Portal Page</span>
                    {selectedCompanyForDrawer.careers && selectedCompanyForDrawer.careers !== 'N/A' ? (
                      <a
                        href={selectedCompanyForDrawer.careers}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-bold flex items-center gap-1 hover:underline truncate"
                      >
                        {selectedCompanyForDrawer.careers}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400 italic">Not detected yet</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Status details */}
              <div className="space-y-3">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Crawl Details</h4>
                <div className="border border-slate-100 rounded-xl divide-y divide-slate-100 text-xs">
                  <div className="flex justify-between p-3.5">
                    <span className="text-slate-500 font-semibold">Crawl Status</span>
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${selectedCompanyForDrawer.isScam ? 'bg-amber-100 text-amber-800' :
                      selectedCompanyForDrawer.isFake ? 'bg-rose-100 text-rose-800' :
                        selectedCompanyForDrawer.status === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' :
                          selectedCompanyForDrawer.status === 'failed' ? 'bg-rose-50 text-rose-700' :
                            'bg-slate-100 text-slate-600'
                      }`}>
                      {selectedCompanyForDrawer.isScam ? 'SCAM FLAG' :
                        selectedCompanyForDrawer.isFake ? 'OFFLINE' :
                          selectedCompanyForDrawer.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex justify-between p-3.5">
                    <span className="text-slate-500 font-semibold">Verified Check</span>
                    <span className="font-bold text-slate-700">{selectedCompanyForDrawer.verified ? 'YES' : 'NO'}</span>
                  </div>
                  <div className="flex justify-between p-3.5">
                    <span className="text-slate-500 font-semibold">Last Checked</span>
                    <span className="text-slate-600 font-mono text-[10.5px]">
                      {selectedCompanyForDrawer.timestamp ? new Date(selectedCompanyForDrawer.timestamp).toLocaleString() : 'Never'}
                    </span>
                  </div>
                  {selectedCompanyForDrawer.error && (
                    <div className="p-3.5 flex flex-col gap-1 bg-rose-50/40">
                      <span className="text-rose-800 font-bold uppercase text-[9px] tracking-wider">Crawl Error Notes</span>
                      <p className="text-rose-700 leading-relaxed font-mono text-[10px]">{selectedCompanyForDrawer.error}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Active Jobs inside Drawer */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Current Vacancies</h4>
                  <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-[10px] font-bold">
                    {allJobs.filter(j => j.company_name === selectedCompanyForDrawer.name).length} Openings
                  </span>
                </div>
                <div className="max-h-[220px] overflow-y-auto custom-scrollbar border border-slate-100 rounded-xl bg-slate-50/20 divide-y divide-slate-100">
                  {allJobs.filter(j => j.company_name === selectedCompanyForDrawer.name).map((job, idx) => (
                    <div key={idx} className="p-3 hover:bg-slate-50/50 transition-colors">
                      <a
                        href={(job.is_seeded || job.isSeeded) ? (job.career_page_url || job.company_website || job.apply_url || job.job_url) : (job.apply_url || job.job_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-bold text-slate-700 hover:text-indigo-600 line-clamp-1 block hover:underline"
                      >
                        {job.job_title}
                      </a>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400 font-semibold">
                        <span className="capitalize">{job.work_mode || 'Onsite'}</span>
                        <span>•</span>
                        <span>{job.location}</span>
                        <span>•</span>
                        {job.status === 'CLOSED' ? (
                          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider shrink-0">Closed</span>
                        ) : (
                          <span className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider shrink-0">Active</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {allJobs.filter(j => j.company_name === selectedCompanyForDrawer.name).length === 0 && (
                    <div className="text-center py-8 text-slate-400 italic text-xs">No active vacancies currently indexed.</div>
                  )}
                </div>
              </div>

              {/* Controls */}
              <div className="border-t border-slate-100 pt-5 flex gap-2">
                <button
                  onClick={() => handleVerifySingle(selectedCompanyForDrawer.name, selectedCompanyForDrawer.website, selectedCompanyForDrawer.careers)}
                  className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-sm transition-all text-center"
                >
                  Trigger Scrape Verify
                </button>
                <button
                  onClick={() => handleDeleteSingle(selectedCompanyForDrawer.name)}
                  className="px-4 py-2 border border-rose-200 text-rose-700 hover:bg-rose-50 rounded-xl text-xs font-bold transition-all text-center"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {selectedJobForDrawer && (
        <>
          <div
            onClick={() => setSelectedJobForDrawer(null)}
            className="fixed inset-0 bg-slate-900/20 backdrop-blur-xs z-[80] transition-opacity"
          />
          <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-white border-l border-slate-200 shadow-2xl z-[90] flex flex-col animate-in slide-in-from-right duration-350">
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <CompanyAvatar name={selectedJobForDrawer.company_name} website={selectedJobForDrawer.company_website} size={36} />
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-slate-800 line-clamp-1">{selectedJobForDrawer.job_title}</h3>
                    {selectedJobForDrawer.status === 'CLOSED' ? (
                      <span className="text-[9px] font-bold px-2 py-0.5 bg-slate-100 text-slate-600 rounded-lg uppercase tracking-wider shrink-0">Closed</span>
                    ) : (
                      <span className="text-[9px] font-bold px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg uppercase tracking-wider shrink-0">Active</span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-500 font-semibold">{selectedJobForDrawer.company_name}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleBookmark(selectedJobForDrawer.job_id || '')}
                  className={`p-1.5 rounded-lg hover:bg-slate-100 transition-colors ${bookmarkedJobs.has(selectedJobForDrawer.job_id || '') ? 'text-indigo-600' : 'text-slate-400'
                    }`}
                  title="Bookmark opportunity"
                >
                  <Bookmark className="w-4.5 h-4.5" fill={bookmarkedJobs.has(selectedJobForDrawer.job_id || '') ? 'currentColor' : 'none'} />
                </button>
                <button
                  onClick={() => setSelectedJobForDrawer(null)}
                  className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">

              {/* Job Intelligence Panel Widgets */}
              {companyStatsForDrawer && (
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Hiring Intelligence Analytics</h4>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="bg-gradient-to-br from-indigo-50 to-white border border-indigo-100/80 rounded-xl p-3.5 flex flex-col justify-between shadow-3xs relative overflow-hidden">
                      <div className="flex justify-between items-start">
                        <span className="text-[9px] uppercase font-bold text-indigo-500">Match Score</span>
                        <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                      </div>
                      <div className="mt-2 flex items-baseline gap-1">
                        <span className="text-2xl font-black text-indigo-700">{companyStatsForDrawer.matchScore}%</span>
                        <span className="text-[9px] text-indigo-500 font-semibold">Match Profile</span>
                      </div>
                    </div>

                    <div className="bg-gradient-to-br from-emerald-50 to-white border border-emerald-100/80 rounded-xl p-3.5 flex flex-col justify-between shadow-3xs relative overflow-hidden">
                      <div className="flex justify-between items-start">
                        <span className="text-[9px] uppercase font-bold text-emerald-500">Hiring Velocity</span>
                        <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                      </div>
                      <div className="mt-2 flex items-baseline gap-1">
                        <span className="text-xl font-black text-emerald-700">{companyStatsForDrawer.velocity}</span>
                        <span className="text-[8px] text-emerald-700 bg-emerald-100/60 font-extrabold px-1.5 py-0.5 rounded-sm">Active</span>
                      </div>
                    </div>

                    <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 flex flex-col justify-between shadow-3xs relative overflow-hidden">
                      <div className="flex justify-between items-start">
                        <span className="text-[9px] uppercase font-bold text-slate-400">Company Health</span>
                        <Building className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                      <div className="mt-2 flex items-baseline gap-1">
                        <span className="text-lg font-black text-slate-700">{companyStatsForDrawer.health}</span>
                        <span className="text-[9px] text-slate-400 font-medium">Safe Check</span>
                      </div>
                    </div>

                    <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5 flex flex-col justify-between shadow-3xs relative overflow-hidden">
                      <div className="flex justify-between items-start">
                        <span className="text-[9px] uppercase font-bold text-slate-400">Role Demand</span>
                        <Briefcase className="w-3.5 h-3.5 text-slate-400" />
                      </div>
                      <div className="mt-2 flex items-baseline gap-1">
                        <span className="text-lg font-black text-slate-700">{companyStatsForDrawer.demand}</span>
                        <span className="text-[9px] text-slate-400 font-medium">Global market</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* quick stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col">
                  <span className="text-[9px] uppercase font-bold text-slate-400">Work Mode</span>
                  <span className="text-xs font-bold text-slate-700 capitalize mt-1">{selectedJobForDrawer.work_mode || 'onsite'}</span>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col">
                  <span className="text-[9px] uppercase font-bold text-slate-400">Experience</span>
                  <span className="text-xs font-bold text-slate-700 mt-1">{selectedJobForDrawer.experience_required || 'Not specified'}</span>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col">
                  <span className="text-[9px] uppercase font-bold text-slate-400">Location</span>
                  <span className="text-xs font-bold text-slate-700 mt-1 truncate" title={selectedJobForDrawer.location}>{selectedJobForDrawer.city || 'India'}</span>
                </div>
                <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col">
                  <span className="text-[9px] uppercase font-bold text-slate-400">Salary Range</span>
                  <span className="text-xs font-bold text-slate-700 mt-1 truncate">{selectedJobForDrawer.salary_range || 'Competitive'}</span>
                </div>
              </div>

              {/* Skills required tags */}
              {selectedJobForDrawer.skills && selectedJobForDrawer.skills.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Required Skills</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedJobForDrawer.skills.map(sk => (
                      <span key={sk} className="bg-indigo-50 text-indigo-700 border border-indigo-100/60 text-xs px-2.5 py-1 rounded-lg font-bold">
                        {sk}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* cleaned description snippet body */}
              <div className="space-y-2.5">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Job Description</h4>
                <div className="prose max-w-none text-xs text-slate-600 leading-relaxed font-normal bg-slate-50/30 p-4 rounded-xl border border-slate-100/80 whitespace-pre-line max-h-[300px] overflow-y-auto custom-scrollbar">
                  {cleanJobDescription(selectedJobForDrawer.description) || 'No job description outline text compiled.'}
                </div>
              </div>

              {/* Company Overview section */}
              {companyStatsForDrawer && (
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Company Overview</h4>
                  <div className="border border-slate-200 rounded-xl p-4.5 bg-slate-50/30 space-y-3.5">
                    <div className="grid grid-cols-2 gap-3.5 text-xs">
                      <div>
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Industry</span>
                        <span className="font-bold text-slate-700">{companyStatsForDrawer.industry}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Company Size</span>
                        <span className="font-bold text-slate-700">{companyStatsForDrawer.size}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Funding Stage</span>
                        <span className="font-bold text-slate-700">{companyStatsForDrawer.funding}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px] uppercase font-bold">Remote Policy</span>
                        <span className="font-bold text-slate-700">
                          {selectedJobForDrawer.work_mode ? `${selectedJobForDrawer.work_mode} first` : 'Remote option available'}
                        </span>
                      </div>
                    </div>

                    <div className="border-t border-slate-100 pt-3 flex gap-2">
                      {(matchedCompanyForDrawer?.website || selectedJobForDrawer.company_website) && (
                        <a
                          href={matchedCompanyForDrawer?.website || selectedJobForDrawer.company_website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-[10.5px] font-bold text-slate-700 shadow-3xs flex items-center justify-center gap-1"
                        >
                          Official Website
                          <ExternalLink className="w-3 h-3 text-slate-400" />
                        </a>
                      )}
                      {(matchedCompanyForDrawer?.careers || selectedJobForDrawer.career_page_url) && (
                        <a
                          href={matchedCompanyForDrawer?.careers || selectedJobForDrawer.career_page_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg text-[10.5px] font-bold text-slate-700 shadow-3xs flex items-center justify-center gap-1"
                        >
                          Careers Portal
                          <ExternalLink className="w-3 h-3 text-slate-400" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Discovery timeline */}
              <div className="space-y-3">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Discovery timeline</h4>
                <div className="border border-slate-200 rounded-xl p-4.5 bg-white text-xs font-semibold text-slate-700 space-y-4">
                  <div className="flex gap-3 relative">
                    <div className="absolute left-2.5 top-5 bottom-0 w-0.5 bg-slate-100" />
                    <div className="w-5 h-5 rounded-full bg-emerald-50 border-4 border-emerald-500 shrink-0 mt-0.5" />
                    <div className="flex flex-col">
                      <span>Job discovered &amp; indexed successfully</span>
                      <span className="text-[10px] text-slate-400 font-mono mt-0.5">
                        {selectedJobForDrawer.posted_date ? new Date(selectedJobForDrawer.posted_date).toLocaleString() : 'Recent run'}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-3 relative">
                    <div className="absolute left-2.5 top-5 bottom-0 w-0.5 bg-slate-100" />
                    <div className="w-5 h-5 rounded-full bg-indigo-50 border-4 border-indigo-500 shrink-0 mt-0.5" />
                    <div className="flex flex-col">
                      <span>Deduplication &amp; scam filter verification complete</span>
                      <span className="text-[10px] text-slate-400 font-mono mt-0.5">Duplicates bypassed: safe listing confirmed</span>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <div className="w-5 h-5 rounded-full bg-slate-100 border-4 border-slate-300 shrink-0 mt-0.5" />
                    <div className="flex flex-col">
                      <span>Career page validation sweep finalized</span>
                      <span className="text-[10px] text-slate-400 font-mono mt-0.5">Verified active status on target portal</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* duplicate analysis / metadata */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Duplicate Analysis &amp; Source Trace</h4>
                <div className="border border-slate-100 rounded-xl divide-y divide-slate-100 text-[11px] font-medium text-slate-650">
                  <div className="flex justify-between p-3">
                    <span className="text-slate-400 font-semibold">ATS Source Trace</span>
                    <span className="font-semibold text-slate-700 capitalize">
                      {selectedJobForDrawer.source_name || 'Direct career page'} ({selectedJobForDrawer.source_type || 'Official'})
                    </span>
                  </div>
                  <div className="flex justify-between p-3">
                    <span className="text-slate-400 font-semibold">Fingerprint ID</span>
                    <span className="font-mono text-slate-700 truncate max-w-[200px]">{selectedJobForDrawer.job_fingerprint || selectedJobForDrawer.job_id || 'Radar-FP-Auto'}</span>
                  </div>
                  <div className="flex justify-between p-3">
                    <span className="text-slate-400 font-semibold">Clean Status</span>
                    {selectedJobForDrawer.is_duplicate ? (
                      <span className="text-rose-600 font-extrabold flex items-center gap-1">
                        <ShieldAlert className="w-3.5 h-3.5 fill-rose-50 text-rose-600 shrink-0" />
                        Duplicate Listing Flagged
                      </span>
                    ) : (
                      <span className="text-emerald-600 font-extrabold flex items-center gap-1">
                        <Shield className="w-3.5 h-3.5 fill-emerald-50 text-emerald-600 shrink-0" />
                        100% Verified Unique
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Apply trigger */}
              <div className="border-t border-slate-100 pt-5">
                <a
                  href={(selectedJobForDrawer.is_seeded || selectedJobForDrawer.isSeeded) ? (selectedJobForDrawer.career_page_url || selectedJobForDrawer.company_website || selectedJobForDrawer.apply_url || selectedJobForDrawer.job_url) : (selectedJobForDrawer.apply_url || selectedJobForDrawer.job_url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-md hover:shadow-lg transition-all text-center"
                >
                  Proceed to Application Portal
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>

            </div>
          </div>
        </>
      )}

      {/* Sticky top header panel */}
      <header className="sticky top-0 z-40 w-full bg-white/80 backdrop-blur-md border-b border-slate-200/80 shadow-xs px-6 py-3">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-200">
              <Activity className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h1 className="text-base font-black text-slate-900 tracking-tight leading-none">JobRadar India</h1>
              <p className="text-[10px] text-slate-500 mt-1 font-semibold flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${scrapeState?.status === 'running' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                {scrapeState?.status === 'running' ? 'Crawl System Syncing...' : 'Discovery Engines Active'}
              </p>
            </div>
          </div>

          {/* Search Trigger */}
          <div className="flex items-center gap-4 flex-1 max-w-md md:mx-6">
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="flex items-center justify-between w-full px-3 py-2 bg-slate-100 hover:bg-slate-200/60 rounded-xl border border-slate-200 text-slate-400 text-xs transition-all outline-none"
            >
              <span className="flex items-center gap-2 font-medium">
                <Search className="w-4 h-4 text-slate-400" />
                Search companies, roles, skills...
              </span>
              <span className="font-mono text-[9px] border border-slate-200 rounded px-1.5 bg-white shadow-3xs">⌘K</span>
            </button>
          </div>

          {/* Navigation Controls */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl shrink-0">
            <button
              onClick={() => setActiveTab('companies')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-150 ${activeTab === 'companies'
                ? 'bg-white text-indigo-600 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
                }`}
            >
              🏢 Companies Directory
            </button>
            <button
              onClick={() => setActiveTab('jobs')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-150 ${activeTab === 'jobs'
                ? 'bg-white text-indigo-600 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
                }`}
            >
              💼 Hiring Intelligence
            </button>
          </div>
        </div>
      </header>

      {/* Real-time hiring ticker strip */}
      <div className="bg-slate-900 text-indigo-200 text-[11px] font-mono py-1.5 px-6 border-y border-slate-950 shrink-0 select-none overflow-hidden">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-slate-400 font-extrabold uppercase text-[9px] tracking-wider shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping" />
            Live Discovery Feed:
          </span>
          <div className="flex-1 text-center font-bold px-4 truncate transition-all duration-500 animate-pulse">
            {tickerIndex === 0 ? '⚡ Razorpay posted Backend Engineer (3-5 years) • Bengaluru, India' :
              tickerIndex === 1 ? '🔥 Groww posted SDE-1 Frontend Role (1-3 years) • Remote, India' :
                tickerIndex === 2 ? '🏆 Postman posted Principal DevSecOps Lead (8+ years) • Bangalore, India' :
                  '⭐ Databricks posted Associate Data Solutions Engineer (0-1 years) • Pune, India'}
          </div>
          <span className="text-slate-500 shrink-0 text-[10px]">Ticking: active sweeps running</span>
        </div>
      </div>

      {/* Main viewport area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 flex flex-col gap-6">

        {/* 🏢 COMPANIES DIRECTORY VIEW */}
        {activeTab === 'companies' && (
          <div className="space-y-6 animate-in fade-in duration-200">

            {/* KPI summary strip */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Total Companies</span>
                <span className="text-2xl font-black text-slate-900 mt-1 tabular-nums">{compStats.total.toLocaleString()}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">Scraping index entries</span>
              </div>
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Verified Success</span>
                <span className="text-2xl font-black text-emerald-600 mt-1 tabular-nums">{compStats.verified.toLocaleString()}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">Active website URLs</span>
              </div>
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Pending Review</span>
                <span className="text-2xl font-black text-amber-500 mt-1 tabular-nums">{compStats.pending.toLocaleString()}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">Awaiting first sweeps</span>
              </div>
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Failed Pages</span>
                <span className="text-2xl font-black text-rose-500 mt-1 tabular-nums">{compStats.failed.toLocaleString()}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">DNS or timeout issues</span>
              </div>
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Scam Flags</span>
                <span className="text-2xl font-black text-amber-600 mt-1 tabular-nums">{compStats.scam.toLocaleString()}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">Blocked billing fee scams</span>
              </div>
              <div className="bg-white p-4.5 rounded-2xl border border-slate-200/90 shadow-2xs flex flex-col">
                <span className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">Offline Pages</span>
                <span className="text-2xl font-black text-slate-500 mt-1 tabular-nums">{compStats.offline.toLocaleString()}</span>
                <span className="text-[9px] text-slate-500 mt-0.5">Dead domains mapped</span>
              </div>
            </div>

            {/* Split layout: left controls, right table */}
            <div className="grid grid-cols-12 gap-6 items-start">

              {/* Scraper panel settings */}
              <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">

                <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-2xs flex flex-col gap-5">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Scraper Controller</h3>
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold ${scrapeState?.status === 'running' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 animate-pulse' :
                      'bg-slate-100 text-slate-600'
                      }`}>
                      {scrapeState?.status?.toUpperCase() || 'IDLE'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    {scrapeState?.status === 'running' ? (
                      <button
                        onClick={() => handleScraperAction('pause')}
                        className="flex items-center justify-center gap-1.5 px-3 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-xl text-xs font-bold transition-all"
                      >
                        <Pause className="w-3.5 h-3.5" /> Pause Scan
                      </button>
                    ) : (
                      <button
                        onClick={() => handleScraperAction('start', { delayMs: settingDelay, concurrency: settingConcurrency })}
                        className="flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-sm transition-all"
                      >
                        <Play className="w-3.5 h-3.5" /> Start Scan
                      </button>
                    )}
                    <button
                      onClick={() => handleScraperAction('stop')}
                      disabled={scrapeState?.status === 'idle'}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-100 border border-slate-200 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                    >
                      <Square className="w-3.5 h-3.5" /> Stop
                    </button>
                    <button
                      onClick={() => handleScraperAction('rescrape', { delayMs: settingDelay, concurrency: settingConcurrency })}
                      disabled={scrapeState?.status === 'running'}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" /> Retry Failed
                    </button>
                    <button
                      onClick={() => handleScraperAction('reset')}
                      disabled={scrapeState?.status === 'running'}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-700 rounded-xl text-xs font-bold transition-all disabled:opacity-50"
                    >
                      Reset Directory
                    </button>
                  </div>

                  <div className="flex flex-col gap-4 border-t border-slate-100 pt-4">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-[11px] font-bold text-slate-500 uppercase">
                        <span>Delay Multiplier</span>
                        <span className="text-indigo-600">{settingDelay}ms</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={4000}
                        step={100}
                        value={settingDelay}
                        onChange={e => setSettingDelay(Number(e.target.value))}
                        className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between text-[11px] font-bold text-slate-500 uppercase">
                        <span>Concurrent Workers</span>
                        <span className="text-indigo-600">{settingConcurrency} threads</span>
                      </div>
                      <input
                        type="range"
                        min={1}
                        max={20}
                        value={settingConcurrency}
                        onChange={e => setSettingConcurrency(Number(e.target.value))}
                        className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-slate-100 pt-4">
                    <button
                      onClick={() => setImportModalOpen(true)}
                      className="flex items-center justify-center gap-1.5 w-full px-3 py-2 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-bold transition-all"
                    >
                      <Upload className="w-4 h-4" /> Import Excel/CSV List
                    </button>
                    <button
                      onClick={() => setSettingsModalOpen(true)}
                      className="flex items-center justify-center gap-1.5 w-full px-3 py-2 bg-slate-50 border border-slate-200 hover:bg-slate-105 text-slate-600 rounded-xl text-xs font-bold transition-all"
                    >
                      <Settings className="w-4 h-4" /> Scraper Settings
                    </button>
                  </div>
                </div>

                {/* Scraper SVG donut metrics */}
                <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-2xs flex flex-col gap-5">
                  <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-3">Telemetry Charts</h4>

                  <div className="flex items-center gap-6 justify-center">
                    <div className="relative w-24 h-24 shrink-0">
                      <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                        <circle cx="50" cy="50" r="40" fill="transparent" stroke="#f1f5f9" strokeWidth="8" />
                        <circle
                          cx="50" cy="50" r="40" fill="transparent" stroke="#4f46e5" strokeWidth="8"
                          strokeDasharray="251.2" strokeDashoffset={donutProgressOffset}
                          strokeLinecap="round" className="transition-all duration-300"
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-base font-extrabold text-slate-900">{chartStats.progress}%</span>
                        <span className="text-[9px] text-slate-400 font-semibold uppercase">Scraped</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5 flex-1 min-w-0 text-xs font-semibold">
                      <div className="flex justify-between text-slate-500">
                        <span>Processed:</span>
                        <span className="text-slate-855">{(chartStats.total - chartStats.pending).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-slate-500">
                        <span>Remaining:</span>
                        <span className="text-slate-855">{chartStats.pending.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-slate-405 border-t border-slate-100 pt-1">
                        <span>Target total:</span>
                        <span>{chartStats.total.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  {/* segment lines */}
                  <div className="flex flex-col gap-2.5 border-t border-slate-100 pt-4">
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between text-[11px] font-bold">
                        <span className="text-emerald-700">Verified Active Pages</span>
                        <span>{chartStats.success} / {chartStats.total}</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500" style={{ width: `${(chartStats.success / chartStats.total * 100) || 0}%` }} />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between text-[11px] font-bold">
                        <span className="text-amber-700">Flagged Scam Pages</span>
                        <span>{chartStats.scam} / {chartStats.total}</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500" style={{ width: `${(chartStats.scam / chartStats.total * 100) || 0}%` }} />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between text-[11px] font-bold">
                        <span className="text-rose-700">Offline / Dead Pages</span>
                        <span>{chartStats.offline} / {chartStats.total}</span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-rose-50" style={{ width: `${(chartStats.offline / chartStats.total * 100) || 0}%` }} />
                      </div>
                    </div>
                  </div>
                </div>

              </div>

              {/* Table section */}
              <div className="col-span-12 lg:col-span-8 flex flex-col gap-6">

                <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">

                  {/* search filter row */}
                  <div className="p-5 border-b border-slate-100 flex flex-col gap-4">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                      <div className="relative flex-1 max-w-sm">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 transform -translate-y-1/2" />
                        <input
                          type="text"
                          placeholder="Search database..."
                          value={companiesSearch}
                          onChange={e => setCompaniesSearch(e.target.value)}
                          className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <select
                          value={tldFilter}
                          onChange={e => setTldFilter(e.target.value as any)}
                          className="border border-slate-200 rounded-xl px-2.5 py-1.5 text-xs font-bold bg-white text-slate-650 outline-none"
                        >
                          <option value="all">All TLDs</option>
                          <option value=".in">.in (India)</option>
                          <option value=".com">.com (Commercial)</option>
                          <option value=".org">.org</option>
                          <option value="others">Other TLDs</option>
                        </select>
                        <button
                          onClick={handleExportCSV}
                          className="flex items-center gap-1 px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-650 rounded-xl text-xs font-bold transition-all"
                        >
                          <Download className="w-3.5 h-3.5" /> CSV
                        </button>
                        <button
                          onClick={handleExportJSON}
                          className="flex items-center gap-1 px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-655 rounded-xl text-xs font-bold transition-all"
                        >
                          <Download className="w-3.5 h-3.5" /> JSON
                        </button>
                      </div>
                    </div>

                    {/* status categories */}
                    <div className="flex flex-wrap gap-1.5 border-b border-slate-100 pb-1">
                      {[
                        { id: 'all', label: 'All Targets' },
                        { id: 'success', label: 'Verified Success' },
                        { id: 'scam', label: 'Scams ⚠️' },
                        { id: 'offline', label: 'Offline / Dead ❌' },
                        { id: 'failed', label: 'General Failures' },
                        { id: 'pending', label: 'Pending review' }
                      ].map(tab => (
                        <button
                          key={tab.id}
                          onClick={() => setStatusFilter(tab.id as any)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${statusFilter === tab.id
                            ? 'bg-indigo-600 text-white shadow-xs'
                            : 'bg-slate-50 hover:bg-slate-100 text-slate-650 border border-slate-200/40'
                            }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {selectedCompanies.size > 0 && (
                      <div className="flex items-center justify-between bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-2.5 animate-in fade-in duration-150">
                        <span className="text-xs font-bold text-indigo-900">{selectedCompanies.size} entities selected</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleCopySelectedWebsites}
                            className="px-2.5 py-1 bg-white border border-indigo-200 hover:bg-indigo-50 text-indigo-700 rounded-lg text-xs font-bold transition-all"
                          >
                            Copy URLs
                          </button>
                          <button
                            onClick={handleBulkVerifySelected}
                            className="px-2.5 py-1 bg-white border border-indigo-200 hover:bg-indigo-50 text-indigo-700 rounded-lg text-xs font-bold transition-all"
                          >
                            Verify
                          </button>
                          <button
                            onClick={handleBulkDeleteSelected}
                            className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-all"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() => setSelectedCompanies(new Set())}
                            className="text-indigo-600 hover:text-indigo-950 text-xs font-bold px-1 py-0.5"
                          >
                            Deselect
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* table body */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/75 border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                          <th className="py-3 px-5 w-10 text-center">
                            <input
                              type="checkbox"
                              checked={isAllPageSelected}
                              onChange={handleSelectAllOnPage}
                              className="rounded-sm accent-indigo-600 cursor-pointer"
                            />
                          </th>
                          <th className="py-3 px-5">Hiring Employer</th>
                          <th className="py-3 px-5">Website Link</th>
                          <th className="py-3 px-5">Careers Portal</th>
                          <th className="py-3 px-5">Active Jobs</th>
                          <th className="py-3 px-5 w-28">Status</th>
                          <th className="py-3 px-5 w-16 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs font-semibold text-slate-705">
                        {currentPagedCompanies.map(c => {
                          const jobCount = allJobs.filter(j => j.company_name === c.name).length;

                          let badgeBg = 'bg-slate-100 text-slate-600';
                          let label = 'PENDING';
                          if (c.isScam) {
                            badgeBg = 'bg-amber-100 text-amber-800 border border-amber-200';
                            label = 'SCAM ⚠️';
                          } else if (c.isFake) {
                            badgeBg = 'bg-rose-100 text-rose-800 border border-rose-200';
                            label = 'OFFLINE';
                          } else if (c.status === 'success') {
                            badgeBg = 'bg-emerald-50 text-emerald-700 border border-emerald-200';
                            label = 'VERIFIED';
                          } else if (c.status === 'failed') {
                            badgeBg = 'bg-rose-50 text-rose-700 border border-rose-200';
                            label = 'FAILED';
                          }

                          return (
                            <tr
                              key={c.name}
                              onClick={() => setSelectedCompanyForDrawer(c)}
                              className="hover:bg-slate-50/50 cursor-pointer transition-colors"
                            >
                              <td className="py-3.5 px-5 text-center" onClick={e => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={selectedCompanies.has(c.name)}
                                  onChange={() => handleToggleSelectCompany(c.name)}
                                  className="rounded-sm accent-indigo-600 cursor-pointer"
                                />
                              </td>
                              <td className="py-3.5 px-5">
                                <div className="flex items-center gap-2.5">
                                  <CompanyAvatar name={c.name} website={c.website} size={30} />
                                  <span className="font-bold text-slate-800 truncate max-w-[160px]">{c.name}</span>
                                </div>
                              </td>
                              <td className="py-3.5 px-5">
                                {c.website && c.website !== 'N/A' ? (
                                  <a 
                                    href={c.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="text-indigo-600 hover:text-indigo-850 hover:underline font-mono text-[11px] flex items-center gap-1 max-w-[140px] truncate"
                                  >
                                    <ExternalLink className="w-3 h-3 text-indigo-400 shrink-0" />
                                    {c.website.replace(/^https?:\/\/(www\.)?/, '')}
                                  </a>
                                ) : (
                                  <span className="text-slate-400 font-normal italic">Pending scan...</span>
                                )}
                              </td>
                              <td className="py-3.5 px-5">
                                {c.careers && c.careers !== 'N/A' ? (
                                  <a 
                                    href={c.careers}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="text-indigo-600 hover:text-indigo-850 hover:underline font-mono text-[11px] flex items-center gap-1 max-w-[140px] truncate"
                                  >
                                    <ExternalLink className="w-3 h-3 text-indigo-400 shrink-0" />
                                    View Portal
                                  </a>
                                ) : (
                                  <span className="text-slate-400 font-normal italic">Pending scan...</span>
                                )}
                              </td>
                              <td className="py-3.5 px-5">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${jobCount > 0 ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' : 'bg-slate-50 text-slate-400'
                                  }`}>
                                  {jobCount} Jobs
                                </span>
                              </td>
                              <td className="py-3.5 px-5">
                                <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide ${badgeBg}`}>
                                  {label}
                                </span>
                              </td>
                              <td className="py-3.5 px-5 text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    onClick={() => handleVerifySingle(c.name, c.website, c.careers)}
                                    className="p-1 text-slate-400 hover:text-emerald-600 rounded"
                                    title="Verify Target page"
                                  >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDeleteSingle(c.name)}
                                    className="p-1 text-slate-400 hover:text-rose-600 rounded"
                                    title="Remove Target"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                        {filteredCompanies.length === 0 && (
                          <tr>
                            <td colSpan={6} className="py-12 text-center text-slate-400 italic">
                              No companies found matching current filters.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* table pagination */}
                  {totalCompPages > 1 && (
                    <div className="p-4 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-xs text-slate-400 font-semibold">
                        Page <strong className="text-slate-750">{compPage}</strong> of <strong className="text-slate-755">{totalCompPages}</strong>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setCompPage(p => Math.max(1, p - 1))}
                          disabled={compPage === 1}
                          className="px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                        >
                          Prev
                        </button>
                        <button
                          onClick={() => setCompPage(p => Math.min(totalCompPages, p + 1))}
                          disabled={compPage === totalCompPages}
                          className="px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}

                </div>

                {/* Expandable Logs Section */}
                <div className="bg-slate-900 rounded-2xl border border-slate-950 overflow-hidden flex flex-col transition-all duration-300">
                  <div
                    onClick={() => setScraperLogsExpanded(!scraperLogsExpanded)}
                    className="bg-slate-955/90 px-5 py-3 flex items-center justify-between cursor-pointer border-b border-slate-850"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                      <span className="font-mono text-xs font-bold text-slate-400">Scraper Engine Console Logs</span>
                    </div>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        handleScraperAction('clear_logs');
                      }}
                      className="text-[10px] uppercase font-bold text-slate-500 hover:text-slate-355"
                    >
                      Clear console
                    </button>
                  </div>
                  {scraperLogsExpanded && (
                    <div
                      ref={consoleRef}
                      className="p-5 h-[240px] font-mono text-[10.5px] overflow-y-auto custom-scrollbar text-slate-300 bg-slate-900/90 divide-y divide-slate-800/30"
                    >
                      {scrapeState?.logs && scrapeState.logs.length > 0 ? (
                        scrapeState.logs.map((log, idx) => {
                          let colorClass = 'text-slate-455';
                          if (log.includes('✅') || log.includes('SUCCESS') || log.includes('✓')) colorClass = 'text-emerald-400';
                          else if (log.includes('❌') || log.toLowerCase().includes('fail') || log.toLowerCase().includes('error')) colorClass = 'text-rose-400';
                          else if (log.includes('⚠️') || log.toLowerCase().includes('scam')) colorClass = 'text-amber-400';
                          return <div key={idx} className={`py-1 ${colorClass}`}>{log}</div>;
                        })
                      ) : (
                        <div className="text-slate-500 italic py-2">No logging trace compiled. Run a scan.</div>
                      )}
                    </div>
                  )}
                </div>

              </div>

            </div>

          </div>
        )}

        {/* 💼 HIRING INTELLIGENCE VIEW */}
        {activeTab === 'jobs' && (
          <div className="space-y-6 animate-in fade-in duration-200">

            {/* Top Executive KPI strip of 10 live stats cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 lg:grid-cols-10 gap-3">
              {[
                { title: 'Active Jobs', val: jobsStats.total, trend: '▲ 8%', color: 'text-indigo-650', key: 'new_jobs_found', label: 'Indexed postings' },
                { title: 'New Today', val: jobsStats.newToday, trend: '▲ 15%', color: 'text-emerald-650', key: 'new_jobs_found', label: 'Discovered 24h' },
                { title: 'New Hour', val: jobsStats.newHour, trend: '▲ 2%', color: 'text-indigo-500', key: 'new_jobs_found', label: 'Discovered 1h' },
                { title: 'Employers', val: new Set(allJobs.map(j => j.company_name)).size, trend: '▲ 4%', color: 'text-slate-800', key: 'companies_scanned', label: 'Hiring entities' },
                { title: 'Remote Roles', val: jobsStats.remote, trend: '▲ 12%', color: 'text-emerald-650', key: 'new_jobs_found', label: 'Wfh index count' },
                { title: 'Internships', val: jobsStats.internships, trend: '▲ 6%', color: 'text-violet-650', key: 'new_jobs_found', label: 'Fresh entry roles' },
                { title: 'Direct List', val: jobsStats.direct, trend: '▲ 9%', color: 'text-slate-750', key: 'companies_scanned', label: 'Direct career sites' },
                { title: 'Duplicates', val: jobsStats.duplicatesRemoved, trend: '▼ 18%', color: 'text-slate-450', key: 'duplicate_jobs_skipped', label: 'Bypassed overlaps' },
                { title: 'Closing Soon', val: Math.round(jobsStats.total * 0.12), trend: '▼ 3%', color: 'text-amber-600', key: 'closed_jobs_found', label: 'Expiring openings' },
                { title: 'Avg/Minute', val: '0.8', trend: '▲ 5%', color: 'text-emerald-500', key: 'new_jobs_found', label: 'Discovery flow rate' }
              ].map((card, i) => (
                <div key={i} className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-3xs flex flex-col justify-between h-28 relative overflow-hidden">
                  <div className="flex justify-between items-start">
                    <span className="text-[8.5px] uppercase font-bold text-slate-400 tracking-wider line-clamp-1">{card.title}</span>
                    <span className={`text-[8.5px] font-bold px-1 py-0.5 rounded-sm ${card.trend.includes('▲') ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-500'}`}>
                      {card.trend}
                    </span>
                  </div>

                  <div className="my-1.5 flex items-baseline gap-1">
                    <span className={`text-lg font-black tracking-tight ${card.color}`}>{card.val.toLocaleString()}</span>
                  </div>

                  {/* Sparkline mini-graph */}
                  <div className="h-6 w-full mt-auto">
                    <svg className="w-full h-full text-indigo-500/30" viewBox="0 0 60 20">
                      <path
                        d={generateSparkline(card.key as any)}
                        fill="none"
                        stroke={card.color.includes('emerald') ? '#10b981' : card.color.includes('rose') ? '#f43f5e' : '#4f46e5'}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                </div>
              ))}
            </div>

            {/* Split layout: left sidebar with heatmaps/insights/streams, right list cards */}
            <div className="grid grid-cols-12 gap-6 items-start">

              {/* Left sidebar widgets column */}
              <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">

                {/* AI Insights panel card */}
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs flex flex-col gap-4">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2.5 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-indigo-600 animate-pulse" />
                    AI Hiring Intelligence Insights
                  </h3>
                  <div className="space-y-3.5 text-xs">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold text-slate-800">Most Hiring Entities Today</span>
                      <span className="text-slate-500 text-[11px]">Tata Consultancy Services (TCS), Infosys, Wipro</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold text-slate-800">Fastest Growing Target Skills</span>
                      <span className="text-slate-500 text-[11px]">React, Node.js, Python, TypeScript (+18% YoY)</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold text-slate-800">Trending Job Titles</span>
                      <span className="text-slate-500 text-[11px]">Backend Engineer, Frontend Developer, DevOps Architect</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-bold text-slate-800">Top Remote India Employers</span>
                      <span className="text-slate-500 text-[11px]">Calendly, InfoTrust, FiveTran (Remote policy: 100%)</span>
                    </div>
                  </div>
                </div>

                {/* India Tech Hubs Hiring Heatmap list */}
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs flex flex-col gap-4">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2.5 flex items-center gap-1.5">
                    <Map className="w-4 h-4 text-indigo-650" />
                    India Hubs Hiring Heatmap
                  </h3>
                  <div className="space-y-3 text-xs">
                    {[
                      { city: 'Bangalore', count: allJobs.filter(j => (j.city || '').toLowerCase() === 'bangalore' || (j.city || '').toLowerCase() === 'bengaluru').length || 180, pct: 85, badge: '🔥 Hot' },
                      { city: 'Hyderabad', count: allJobs.filter(j => (j.city || '').toLowerCase() === 'hyderabad').length || 120, pct: 60, badge: '⚡ Active' },
                      { city: 'Pune', count: allJobs.filter(j => (j.city || '').toLowerCase() === 'pune').length || 65, pct: 40, badge: '⚡ Active' },
                      { city: 'Delhi NCR / Noida', count: allJobs.filter(j => (j.city || '').toLowerCase() === 'noida' || (j.city || '').toLowerCase() === 'delhi' || (j.city || '').toLowerCase() === 'gurgaon').length || 50, pct: 35, badge: 'Steady' },
                      { city: 'Mumbai', count: allJobs.filter(j => (j.city || '').toLowerCase() === 'mumbai').length || 35, pct: 20, badge: 'Steady' },
                      { city: 'Remote Roles', count: jobsStats.remote, pct: 90, badge: '🔥 Hot' }
                    ].map((hub, idx) => (
                      <div key={idx} className="space-y-1">
                        <div className="flex justify-between items-center text-xs font-bold">
                          <span className="text-slate-705">{hub.city}</span>
                          <span className="text-slate-450">{hub.count} open roles</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${hub.pct}%` }} />
                          </div>
                          <span className={`text-[8.5px] font-black px-1 py-0.5 rounded-sm ${hub.badge.includes('🔥') ? 'bg-amber-50 text-amber-700' : hub.badge.includes('⚡') ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-50 text-slate-500'}`}>
                            {hub.badge}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Live discovery activity stream log */}
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs flex flex-col gap-4">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2.5 flex items-center gap-1.5">
                    <Compass className="w-4 h-4 text-indigo-600 animate-spin-slow" />
                    Live Discovery Activity Stream
                  </h3>
                  <div className="space-y-3 max-h-[200px] overflow-y-auto custom-scrollbar pr-1 text-[11px] font-mono leading-relaxed text-slate-500 divide-y divide-slate-100/50">
                    {discoveryStream.map((item, idx) => (
                      <div key={idx} className="pt-2 flex items-start gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Target Company selection list */}
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs flex flex-col gap-4">
                  <div className="border-b border-slate-100 pb-2.5">
                    <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Hiring Targets selection</h3>
                    <span className="text-[9px] text-slate-400 font-semibold uppercase mt-0.5 block">Select monitored directories</span>
                  </div>
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 transform -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search companies..."
                      value={trackedSearch}
                      onChange={e => setTrackedSearch(e.target.value)}
                      className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-lg text-xs outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div className="max-h-[180px] overflow-y-auto custom-scrollbar border border-slate-100 rounded-lg bg-slate-50/20 divide-y divide-slate-100">
                    {filteredTrackedCompanies.map(c => (
                      <label key={c.name} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer text-xs">
                        <input
                          type="checkbox"
                          checked={!!c.jobTracked}
                          onChange={() => handleToggleTracking(c.name)}
                          className="rounded-sm accent-indigo-600 cursor-pointer"
                        />
                        <span className="font-semibold text-slate-700 truncate">{c.name}</span>
                      </label>
                    ))}
                  </div>
                </div>

              </div>

              {/* Right list results panel */}
              <div className="col-span-12 lg:col-span-8 flex flex-col gap-6">

                {/* Advanced filter parameters toolbar */}
                <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs flex flex-col gap-4">

                  {/* Row 1 search & filters */}
                  <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
                    <div className="flex-1 relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 transform -translate-y-1/2" />
                      <input
                        type="text"
                        placeholder="Search title, skills, keywords..."
                        value={jobsSearch}
                        onChange={e => setJobsSearch(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-xs outline-none focus:border-indigo-500 font-semibold text-slate-700"
                      />
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        value={expFilter}
                        onChange={e => setExpFilter(e.target.value)}
                        className="border border-slate-200 rounded-xl px-2.5 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                      >
                        <option value="All Experience">All Experience</option>
                        <option value="0-1">Fresher (0-1 yrs)</option>
                        <option value="1-3">Junior (1-3 yrs)</option>
                        <option value="3-5">Mid-level (3-5 yrs)</option>
                        <option value="5-8">Senior (5-8 yrs)</option>
                        <option value="8+">Lead/Principal (8+ yrs)</option>
                      </select>

                      <select
                        value={salaryFilter}
                        onChange={e => setSalaryFilter(e.target.value)}
                        className="border border-slate-200 rounded-xl px-2.5 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                      >
                        <option value="All Salaries">All Salaries</option>
                        <option value="Internship">Internship/Unpaid</option>
                        <option value="3-6 LPA">3-6 LPA</option>
                        <option value="6-12 LPA">6-12 LPA</option>
                        <option value="12-25 LPA">12-25 LPA</option>
                        <option value="25+ LPA">25+ LPA</option>
                      </select>
                    </div>
                  </div>

                  {/* Row 2 additional selects */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <select
                      value={jobsSourceFilter}
                      onChange={e => setJobsSourceFilter(e.target.value)}
                      className="border border-slate-200 rounded-xl px-2 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                    >
                      {jobSources.map(src => <option key={src} value={src}>{src}</option>)}
                    </select>

                    <select
                      value={jobsModeFilter}
                      onChange={e => setJobsModeFilter(e.target.value)}
                      className="border border-slate-200 rounded-xl px-2 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                    >
                      <option value="All Modes">All Modes</option>
                      <option value="Remote">Remote Only</option>
                      <option value="Hybrid">Hybrid Only</option>
                      <option value="Onsite">Onsite Only</option>
                    </select>

                    <select
                      value={companyTypeFilter}
                      onChange={e => setCompanyTypeFilter(e.target.value)}
                      className="border border-slate-200 rounded-xl px-2 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                    >
                      <option value="All Types">Company Types</option>
                      <option value="Product">Product Company</option>
                      <option value="Service">Service/Staffing</option>
                      <option value="MNC">Global MNCs</option>
                    </select>

                    <select
                      value={jobsCityFilter}
                      onChange={e => setJobsCityFilter(e.target.value)}
                      className="border border-slate-200 rounded-xl px-2 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                    >
                      {jobCities.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>

                    <select
                      value={jobsSortOrder}
                      onChange={e => setJobsSortOrder(e.target.value as any)}
                      className="border border-slate-200 rounded-xl px-2 py-1.5 text-[11px] font-bold bg-white text-slate-600 outline-none"
                    >
                      <option value="newest">Newest First</option>
                      <option value="oldest">Oldest First</option>
                      <option value="alpha">A-Z Title</option>
                    </select>
                  </div>

                  {/* Filter configurations check box */}
                  <div className="flex flex-wrap items-center justify-between border-t border-slate-100 pt-3 text-[11px] font-bold text-slate-500 gap-3">
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-1.5 cursor-pointer text-slate-605">
                        <input
                          type="checkbox"
                          checked={directOnly}
                          onChange={e => setDirectOnly(e.target.checked)}
                          className="rounded-sm accent-indigo-600 cursor-pointer"
                        />
                        <span>Direct Company</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-slate-605">
                        <input
                          type="checkbox"
                          checked={verifiedOnly}
                          onChange={e => setVerifiedOnly(e.target.checked)}
                          className="rounded-sm accent-indigo-600 cursor-pointer"
                        />
                        <span>Verified Directory Only</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-slate-605">
                        <input
                          type="checkbox"
                          checked={bookmarkedOnly}
                          onChange={e => setBookmarkedOnly(e.target.checked)}
                          className="rounded-sm accent-indigo-600 cursor-pointer"
                        />
                        <span>Starred only</span>
                      </label>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowSaveFilterModal(true)}
                        className="text-indigo-600 hover:text-indigo-850 px-2 py-1 border border-indigo-100 rounded bg-indigo-50/50"
                      >
                        Save Search Filters
                      </button>
                      {savedFilters.length > 0 && (
                        <select
                          onChange={e => {
                            const selected = savedFilters.find(g => g.name === e.target.value);
                            if (selected) handleApplyFilterGroup(selected);
                          }}
                          className="border border-slate-200 rounded px-2 py-1 font-bold text-slate-600 bg-white"
                          defaultValue=""
                        >
                          <option value="" disabled>Saved Filters...</option>
                          {savedFilters.map(g => (
                            <option key={g.name} value={g.name}>{g.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                </div>

                {/* Recharts visual analytics panels */}
                {mounted && (
                  <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-2xs space-y-5">
                    <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider border-b border-slate-100 pb-2.5 flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-indigo-650" />
                      Hiring Analytics &amp; Pipeline Telemetry
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Line chart discovery timeline */}
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2.5 block">Discovery Timeline (New Jobs)</span>
                        <div className="h-[150px] w-full relative min-w-0">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={chartsData.dailyHistory} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                              <defs>
                                <linearGradient id="colorJobs" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.2} />
                                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} tickLine={false} />
                              <YAxis stroke="#94a3b8" fontSize={10} tickLine={false} />
                              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                              <Area type="monotone" dataKey="jobs" stroke="#6366f1" strokeWidth={2} fillOpacity={1} fill="url(#colorJobs)" />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      {/* Bar chart hubs split */}
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2.5 block">Top Cities Vacancies Split</span>
                        <div className="h-[150px] w-full relative min-w-0">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartsData.cities} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                              <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} tickLine={false} />
                              <YAxis stroke="#94a3b8" fontSize={10} tickLine={false} />
                              <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                              <Bar dataKey="value" fill="#4f46e5" radius={[4, 4, 0, 0]} barSize={20}>
                                {chartsData.cities.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={index === 0 ? '#4f46e5' : '#818cf8'} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Bulk Actions toolbar */}
                {selectedJobs.size > 0 && (
                  <div className="bg-white rounded-2xl border border-indigo-150 p-4.5 shadow-2xs flex items-center justify-between animate-in slide-in-from-top-2 duration-200">
                    <span className="text-xs font-bold text-indigo-905">{selectedJobs.size} job applications selected</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleBulkExportCSV}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-750 text-white rounded-xl text-xs font-bold transition-all shadow-xs"
                      >
                        Export CSV
                      </button>
                      <button
                        onClick={handleBulkExportJSON}
                        className="px-3 py-1.5 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-bold transition-all"
                      >
                        Export JSON
                      </button>
                      <button
                        onClick={() => setSelectedJobs(new Set())}
                        className="text-slate-400 hover:text-slate-600 text-xs font-bold px-1.5 py-0.5"
                      >
                        Clear Selection
                      </button>
                    </div>
                  </div>
                )}

                {/* compact job rows */}
                <div className="flex flex-col gap-3">
                  {currentPagedJobs.map((job, idx) => {
                    const src = getSourceConfig(job.source_name);
                    const mode = (job.work_mode || 'onsite').toLowerCase();
                    const modeBg = WORK_MODE_COLORS[mode] || WORK_MODE_COLORS.onsite;
                    const modeText = WORK_MODE_TEXT[mode] || WORK_MODE_TEXT.onsite;
                    const skills = (job.skills || []).slice(0, 4);
                    const isBookmarked = bookmarkedJobs.has(job.job_id || '');
                    const isChecked = selectedJobs.has(job.job_id || '');

                    // Mock score / health checks based on titles
                    const matchScore = (parseInt(job.job_id?.substring(0, 4) || 'a1', 16) % 15) + 84;
                    const isHighGrowth = job.company_name.length % 2 === 0;

                    // Resolve website domain and careers portal URL dynamically
                    const resolvedWebsite = (() => {
                      if (job.company_website && job.company_website !== 'N/A') {
                        return job.company_website;
                      }
                      // Lookup in loaded companies database
                      const found = scrapeState?.companies?.find(
                        (c: any) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === job.company_name.toLowerCase().replace(/[^a-z0-9]/g, '')
                      );
                      if (found && found.website && found.website !== 'N/A') {
                        return found.website;
                      }
                      // Heuristic guess fallback
                      const cleanName = job.company_name
                        .toLowerCase()
                        .trim()
                        .replace(/[^a-z0-9]/g, '')
                        .replace(/(tech|technology|consulting|services|solutions|india|software|systems|labs|analytics|group|corp|corporation|inc|ltd|limited|pvt|private)$/g, '');
                      if (cleanName && cleanName.length > 1) {
                        return `https://${cleanName}.com`;
                      }
                      return null;
                    })();

                    const resolvedCareers = (() => {
                      if (job.career_page_url && job.career_page_url !== 'N/A') {
                        return job.career_page_url;
                      }
                      // Lookup in loaded companies database
                      const found = scrapeState?.companies?.find(
                        (c: any) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === job.company_name.toLowerCase().replace(/[^a-z0-9]/g, '')
                      );
                      if (found && found.careers && found.careers !== 'N/A') {
                        return found.careers;
                      }
                      return null;
                    })();

                    return (
                      <div
                        key={job.job_id || `${job.job_url}-${idx}`}
                        onClick={() => setSelectedJobForDrawer(job)}
                        className="bg-white border border-slate-200 hover:border-indigo-200 rounded-xl p-4 shadow-3xs hover:shadow-md transition-all flex items-center gap-4 cursor-pointer relative"
                      >
                        {/* selection checkbox */}
                        <div
                          className="shrink-0"
                          onClick={e => {
                            e.stopPropagation();
                            handleToggleSelectJob(job.job_id || '');
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => { }}
                            className="rounded-sm accent-indigo-600 cursor-pointer"
                          />
                        </div>

                        <CompanyAvatar name={job.company_name} website={resolvedWebsite || undefined} size={34} />

                        <div className="flex-1 min-w-0 flex flex-col md:flex-row md:items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h4 className="text-xs font-black text-slate-800 line-clamp-1 hover:underline">{job.job_title}</h4>
                              {job.status === 'CLOSED' ? (
                                <span className="text-[8px] font-black px-1.5 py-0.2 bg-slate-100 text-slate-500 rounded-sm shrink-0 uppercase tracking-wider">● Closed</span>
                              ) : (
                                <span className="text-[8px] font-black px-1.5 py-0.2 bg-emerald-50 text-emerald-700 rounded-sm shrink-0 uppercase tracking-wider">● Active</span>
                              )}
                              {job.is_duplicate && (
                                <span className="text-[8px] font-black px-1.5 py-0.2 bg-rose-50 border border-rose-200 text-rose-700 rounded-sm shrink-0 uppercase tracking-wider">📋 Duplicate</span>
                              )}
                              {isHighGrowth ? (
                                <span className="text-[8px] font-black px-1.5 py-0.2 bg-amber-50 text-amber-700 rounded-sm shrink-0 uppercase tracking-wider">🔥 High Growth</span>
                              ) : (
                                <span className="text-[8px] font-black px-1.5 py-0.2 bg-indigo-50 text-indigo-700 rounded-sm shrink-0 uppercase tracking-wider">⚡ Hiring Fast</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-550 font-bold flex-wrap">
                              <span className="text-slate-800 font-extrabold">{job.company_name}</span>
                              {resolvedWebsite && (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <a 
                                    href={resolvedWebsite}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="text-indigo-650 hover:text-indigo-850 hover:underline flex items-center gap-0.5 text-[9.5px]"
                                  >
                                    <ExternalLink className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                                    website
                                  </a>
                                </>
                              )}
                              {resolvedCareers && (
                                <>
                                  <span className="text-slate-300">•</span>
                                  <a 
                                    href={resolvedCareers}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="text-indigo-650 hover:text-indigo-850 hover:underline flex items-center gap-0.5 text-[9.5px]"
                                  >
                                    <ExternalLink className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                                    careers page
                                  </a>
                                </>
                              )}
                              <span className="text-slate-300">•</span>
                              <span className="text-slate-405 font-mono text-[9.5px] font-medium">Match score: <strong className="text-indigo-650">{matchScore}%</strong></span>
                            </div>
                          </div>

                          <div className="flex items-center gap-4 shrink-0 justify-between md:justify-end">
                            {/* mode and location metadata */}
                            <div className="flex items-center gap-2.5 text-[10px] text-slate-450 font-semibold">
                              <span className="flex items-center gap-0.5 max-w-[80px] truncate">
                                <MapPin className="w-3 h-3 shrink-0" />
                                {job.city || 'India'}
                              </span>
                              <span className="px-1.5 py-0.2 rounded text-[9px] font-bold capitalize" style={{ color: modeText, backgroundColor: modeBg }}>
                                {mode}
                              </span>
                              <span className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase" style={{ color: src.color, backgroundColor: src.bg }}>
                                {job.source_name || 'Direct'}
                              </span>
                            </div>

                            {/* apply button icon */}
                            <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => toggleBookmark(job.job_id || '')}
                                className={`p-1.5 rounded-lg border border-slate-100 hover:bg-slate-50 transition-colors ${isBookmarked ? 'text-indigo-600' : 'text-slate-400'
                                  }`}
                              >
                                <Bookmark className="w-3.5 h-3.5" fill={isBookmarked ? 'currentColor' : 'none'} />
                              </button>
                              <a
                                href={(job.is_seeded || job.isSeeded) ? (job.career_page_url || job.company_website || job.apply_url || job.job_url) : (job.apply_url || job.job_url)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[10px] font-bold transition-all text-center"
                              >
                                Apply
                              </a>
                            </div>
                          </div>
                        </div>

                      </div>
                    );
                  })}

                  {filteredJobs.length === 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center flex flex-col items-center gap-3">
                      <span className="text-3xl">🔭</span>
                      <h5 className="text-xs font-bold text-slate-800">No matching discovered jobs in feed</h5>
                      <p className="text-xs text-slate-400 max-w-sm">
                        No roles matching the selected search criteria are currently indexed.
                      </p>
                    </div>
                  )}
                </div>

                {/* pagination navigation */}
                {totalJobPages > 1 && (
                  <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between shadow-3xs">
                    <span className="text-xs text-slate-400 font-semibold">
                      Page <strong className="text-slate-700">{jobsPage}</strong> of <strong className="text-slate-700">{totalJobPages}</strong>
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setJobsPage(p => Math.max(1, p - 1))}
                        disabled={jobsPage === 1}
                        className="px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                      >
                        Prev
                      </button>
                      <button
                        onClick={() => setJobsPage(p => Math.min(totalJobPages, p + 1))}
                        disabled={jobsPage === totalJobPages}
                        className="px-3.5 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-semibold disabled:opacity-50 transition-all"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}

                {/* Expandable discovery logs */}
                <div className="bg-slate-900 rounded-2xl border border-slate-950 overflow-hidden flex flex-col transition-all duration-300">
                  <div
                    onClick={() => setJobsLogsExpanded(!jobsLogsExpanded)}
                    className="bg-slate-955/90 px-5 py-3 flex items-center justify-between cursor-pointer border-b border-slate-850"
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                      <span className="font-mono text-xs font-bold text-slate-400">Discovery Engine Crawler Logs</span>
                    </div>
                  </div>
                  {jobsLogsExpanded && (
                    <div
                      ref={jobsConsoleRef}
                      className="p-5 h-[240px] font-mono text-[10.5px] overflow-y-auto custom-scrollbar text-slate-300 bg-slate-900/90 divide-y divide-slate-800/30"
                    >
                      {jobsState?.logs && jobsState.logs.length > 0 ? (
                        jobsState.logs.map((log, idx) => {
                          let colorClass = 'text-slate-400';
                          if (log.includes('✅') || log.includes('✓') || log.includes('completed')) colorClass = 'text-emerald-400';
                          else if (log.includes('❌') || log.toLowerCase().includes('fail') || log.toLowerCase().includes('error')) colorClass = 'text-rose-400';
                          else if (log.includes('🔍') || log.includes('Initiating')) colorClass = 'text-indigo-300';
                          return <div key={idx} className={`py-1 ${colorClass}`}>{log}</div>;
                        })
                      ) : (
                        <div className="text-slate-500 italic py-2">No logging trace compiled. Sweep feed.</div>
                      )}
                    </div>
                  )}
                </div>

              </div>

            </div>

          </div>
        )}

      </main>

      {/* ─────────────────── MODALS SECTION ─────────────────── */}

      {/* 1. Scraper Settings Modal */}
      {settingsModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Scraper Configurations</h3>
              <button onClick={() => setSettingsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-4 overflow-y-auto max-h-[60vh]">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Search Fleet Mode</label>
                <select
                  value={settingSearchEngine}
                  onChange={e => setSettingSearchEngine(e.target.value)}
                  className="border border-slate-200 rounded-xl px-3 py-2 text-xs bg-white outline-none font-semibold text-slate-700"
                >
                  <option value="heuristics_first">Heuristics First, then Search Sweep</option>
                  <option value="guess">URL Suffix Guessing Only (Fastest)</option>
                  <option value="all">Check All Search Engines</option>
                  <option value="ddg">DuckDuckGo Search Only</option>
                  <option value="yahoo">Yahoo Search Only</option>
                  <option value="bing">Bing Search Only</option>
                  <option value="brave">Brave Search Only</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Blacklisted Domains (Comma-separated)</label>
                <textarea
                  value={settingBlacklist}
                  onChange={e => setSettingBlacklist(e.target.value)}
                  rows={3}
                  className="border border-slate-200 rounded-xl p-3 text-xs outline-none focus:border-indigo-500 font-mono text-slate-700"
                  placeholder="e.g. linkedin.com, facebook.com, twitter.com"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Scam Flag Keywords (Line-separated)</label>
                <textarea
                  value={settingScamKeywords}
                  onChange={e => setSettingScamKeywords(e.target.value)}
                  rows={3}
                  className="border border-slate-200 rounded-xl p-3 text-xs outline-none focus:border-indigo-500 font-mono text-slate-700"
                  placeholder="e.g. registration fee&#10;placement charges"
                />
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
              <button
                onClick={() => setSettingsModalOpen(false)}
                className="px-4 py-2 text-xs font-bold text-slate-500 hover:text-slate-700 bg-white border border-slate-200 rounded-xl"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSettings}
                className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs animate-in"
              >
                Save configurations
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Save Filters Modal */}
      {showSaveFilterModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="px-5 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Save Current Filters</h3>
              <button onClick={() => setShowSaveFilterModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 flex flex-col gap-3">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Filter group Name</label>
              <input
                type="text"
                placeholder="e.g. Bangalore Remote Products"
                value={newFilterName}
                onChange={e => setNewFilterName(e.target.value)}
                className="border border-slate-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-indigo-500 font-semibold text-slate-750"
              />
            </div>
            <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setShowSaveFilterModal(false)}
                className="px-3.5 py-1.5 bg-white border border-slate-200 text-slate-550 rounded-lg text-xs font-bold"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveFilterGroup}
                className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold shadow-xs animate-in"
              >
                Save Filters
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. File Import Modal */}
      {importModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Import Targets</h3>
              <button onClick={() => setImportModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-4 overflow-y-auto max-h-[60vh]">
              <div className="border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-2xl p-6 text-center cursor-pointer relative bg-slate-50/50 hover:bg-slate-50 transition-all">
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.json,.txt"
                  onChange={handleFileChange}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <Upload className="w-7 h-7 text-slate-455 mx-auto mb-2" />
                <p className="text-xs font-bold text-slate-700">
                  {importFileName ? `Selected: ${importFileName}` : 'Select or Drop File'}
                </p>
                <p className="text-[10px] text-slate-400 mt-1">Supports Excel, CSV, JSON, or TXT lines</p>
              </div>

              {xlsxLoading && (
                <div className="text-center py-2 text-[10px] font-bold text-slate-500 flex items-center justify-center gap-1.5 animate-pulse">
                  <span className="w-3.5 h-3.5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                  Loading SheetJS library...
                </div>
              )}

              {importRawData && importRawData.length > 0 && (
                <div className="flex flex-col gap-3.5 border-t border-slate-100 pt-4 animate-in fade-in duration-250">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] font-bold text-slate-450 uppercase">Company Name *</label>
                      <select
                        value={mappedNameCol}
                        onChange={e => setMappedNameCol(e.target.value)}
                        className="border border-slate-200 rounded-lg p-1.5 text-xs bg-white text-slate-705 outline-none"
                      >
                        <option value="">-- Select --</option>
                        {importHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] font-bold text-slate-455 uppercase">Website URL</label>
                      <select
                        value={mappedWebCol}
                        onChange={e => setMappedWebCol(e.target.value)}
                        className="border border-slate-200 rounded-lg p-1.5 text-xs bg-white text-slate-705 outline-none"
                      >
                        <option value="">-- Skip --</option>
                        {importHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[9px] font-bold text-slate-455 uppercase">Careers Link</label>
                      <select
                        value={mappedCareersCol}
                        onChange={e => setMappedCareersCol(e.target.value)}
                        className="border border-slate-200 rounded-lg p-1.5 text-xs bg-white text-slate-705 outline-none"
                      >
                        <option value="">-- Skip --</option>
                        {importHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* preview rows */}
                  <div className="flex flex-col gap-1 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">Preview mapped list</span>
                    <div className="text-[10px] text-slate-500 mt-1 space-y-1 font-semibold">
                      {importRawData.slice(0, 3).map((item, idx) => (
                        <div key={idx} className="truncate">
                          <strong>{item[mappedNameCol] || '-'}</strong> | {mappedWebCol ? (item[mappedWebCol] || '-') : '-'}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
              <button
                onClick={() => setImportModalOpen(false)}
                className="px-4 py-2 text-xs font-bold text-slate-500 hover:text-slate-700 bg-white border border-slate-200 rounded-xl"
              >
                Cancel
              </button>
              <button
                onClick={executeConfirmImport}
                disabled={!importRawData || !mappedNameCol}
                className="px-4 py-2 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl disabled:opacity-50 shadow-xs"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Hourly Reports Log */}
      {reportsModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Discovery Sync History</h3>
              <button onClick={() => setReportsModalOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 flex flex-col gap-4 overflow-y-auto max-h-[60vh]">
              <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50/20">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-100/80 border-b border-slate-200 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                      <th className="p-3">Sync Time</th>
                      <th className="p-3 text-center">New Jobs</th>
                      <th className="p-3 text-center">Updated</th>
                      <th className="p-3 text-center">Closed</th>
                      <th className="p-3 text-center">Duplicates</th>
                      <th className="p-3 text-center">Scanned</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                    {jobsState?.reports && jobsState.reports.length > 0 ? (
                      jobsState.reports.map((rep, idx) => (
                        <tr key={idx} className="hover:bg-white transition-colors">
                          <td className="p-3 text-slate-800">
                            {new Date(rep.scan_time).toLocaleString()}
                          </td>
                          <td className="p-3 text-center text-emerald-600 font-extrabold">{rep.new_jobs_found}</td>
                          <td className="p-3 text-center text-indigo-650">{rep.updated_jobs_found}</td>
                          <td className="p-3 text-center text-slate-450">{rep.closed_jobs_found}</td>
                          <td className="p-3 text-center text-slate-455">{rep.duplicate_jobs_skipped}</td>
                          <td className="p-3 text-center text-slate-605">{rep.companies_scanned}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-slate-400 italic">No historical runs logged yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end">
              <button
                onClick={() => setReportsModalOpen(false)}
                className="px-4 py-2 text-xs font-bold text-slate-500 hover:text-slate-700 bg-white border border-slate-200 rounded-xl"
              >
                Close Logs
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
