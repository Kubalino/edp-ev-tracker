import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { PublicClientApplication } from "@azure/msal-browser";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Area, AreaChart, ComposedChart, Line,
} from "recharts";

/* ═══════════════════════════════════════════════════════════════════
   OneDrive / Microsoft Graph
   ─ Paste your Azure App Registration Client ID below.
   ─ The Client ID is not a secret for browser apps — it's safe in
     a public repo. Security comes from the redirect URI restriction
     you set in the Azure portal.
   ═══════════════════════════════════════════════════════════════════ */
const OD_CLIENT_ID = "98583d53-df69-46e2-a3dd-3dbcc81ea9b1";
const OD_SCOPES = ["Files.Read"];

const _msalCfg = {
  auth: {
    clientId: OD_CLIENT_ID,
    authority: "https://login.microsoftonline.com/common",
    redirectUri: window.location.origin + window.location.pathname.replace(/[^/]*$/, ""),
  },
  cache: { cacheLocation: "localStorage", storeAuthStateInCookie: false },
};

let _msal = null;
async function getMsal() {
  if (!_msal) {
    _msal = new PublicClientApplication(_msalCfg);
    await _msal.initialize();
    await _msal.handleRedirectPromise();
  }
  return _msal;
}

async function fetchOneDriveFile(filePath) {
  const msal = await getMsal();
  const accounts = msal.getAllAccounts();
  let accessToken;
  try {
    const req = { scopes: OD_SCOPES, account: accounts[0] };
    const r = accounts.length
      ? await msal.acquireTokenSilent(req)
      : await msal.acquireTokenPopup({ scopes: OD_SCOPES });
    accessToken = r.accessToken;
  } catch {
    const r = await msal.acquireTokenPopup({ scopes: OD_SCOPES });
    accessToken = r.accessToken;
  }
  const encoded = filePath.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encoded}:/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`OneDrive ${res.status}: ${await res.text()}`);
  return res.text();
}

/* ═══════════════════════════════════════════════════════════════════
   IndexedDB
   ═══════════════════════════════════════════════════════════════════ */
const DB = "edp_ev_v3";
const V = 1;
const S_EV = "events";
const S_RT = "rates";

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, V);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(S_EV)) {
        const s = db.createObjectStore(S_EV, { keyPath: "id", autoIncrement: true });
        s.createIndex("month", "month");
        s.createIndex("uid", "uid", { unique: true });
      }
      if (!db.objectStoreNames.contains(S_RT))
        db.createObjectStore(S_RT, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function dbAll(s) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s).objectStore(s).getAll();
    q.onsuccess = () => r(q.result); q.onerror = () => j(q.error);
  });
}
async function dbPut(s, d) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s, "readwrite").objectStore(s).put(d);
    q.onsuccess = () => r(q.result); q.onerror = () => j(q.error);
  });
}
async function dbDel(s, k) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s, "readwrite").objectStore(s).delete(k);
    q.onsuccess = () => r(); q.onerror = () => j(q.error);
  });
}
async function dbClear(s) {
  const db = await openDB();
  return new Promise((r, j) => {
    const q = db.transaction(s, "readwrite").objectStore(s).clear();
    q.onsuccess = () => r(); q.onerror = () => j(q.error);
  });
}

/* ═══════════════════════════════════════════════════════════════════
   EDP Tri-Horária — Ciclo Diário Period Classification
   ═══════════════════════════════════════════════════════════════════

   WINTER (Nov 1 – Mar 31):
     Vazio:   00:00–08:00  &  22:00–24:00  (every day)
     Ponta:   09:30–12:00  &  18:30–21:00  (weekdays only)
     Cheias:  08:00–09:30, 12:00–18:30, 21:00–22:00 (weekdays)
              08:00–22:00  (Sat & Sun — no Ponta on weekends)

   SUMMER (Apr 1 – Oct 31):
     Vazio:   00:00–08:00  &  22:00–24:00  (every day)
     Ponta:   10:30–13:00  &  19:30–21:00  (weekdays only)
     Cheias:  08:00–10:30, 13:00–19:30, 21:00–22:00 (weekdays)
              08:00–22:00  (Sat & Sun)
   ═══════════════════════════════════════════════════════════════════ */
function isSummer(d) { const m = d.getMonth(); return m >= 3 && m <= 9; }
function isWeekday(d) { const w = d.getDay(); return w >= 1 && w <= 5; }

function periodAt(minute, date) {
  const h = minute / 60;
  if (h < 8 || h >= 22) return "vazio";
  if (!isWeekday(date)) return "cheias";
  if (isSummer(date)) {
    if ((h >= 10.5 && h < 13) || (h >= 19.5 && h < 21)) return "ponta";
  } else {
    if ((h >= 9.5 && h < 12) || (h >= 18.5 && h < 21)) return "ponta";
  }
  return "cheias";
}

function classifyEvent(startDate, durMin, kWh) {
  if (durMin <= 0 || kWh <= 0) return { vazio: 0, cheias: 0, ponta: 0 };
  const b = { vazio: 0, cheias: 0, ponta: 0 };
  const startMin = startDate.getHours() * 60 + startDate.getMinutes();
  const rate = kWh / durMin;
  const step = durMin > 300 ? 5 : 1;
  for (let m = 0; m < durMin; m += step) {
    const effMin = (startMin + m) % 1440;
    const dayOff = Math.floor((startMin + m) / 1440);
    const effDate = new Date(startDate.getTime() + dayOff * 86400000);
    b[periodAt(effMin, effDate)] += rate * step;
  }
  const tot = b.vazio + b.cheias + b.ponta;
  if (tot > 0) { const s = kWh / tot; b.vazio *= s; b.cheias *= s; b.ponta *= s; }
  return b;
}

/* ═══════════════════════════════════════════════════════════════════
   CSV Parser — flexible auto-detect
   ═══════════════════════════════════════════════════════════════════ */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error("CSV needs headers + at least 1 data row");
  const sep = lines[0].includes(";") ? ";" : ",";
  const hdr = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/[""]/g, "").replace(/:$/,""));
  const fmt = detectFmt(hdr);
  if (!fmt) throw new Error(
    "Unrecognized CSV format.\n\nExpected either:\n" +
    "• Event rows: Time, Start, End, Duration, Charged(kWh)\n" +
    "• Monthly rows: Mês, kWh Vazio, kWh Cheias, kWh Ponta"
  );
  const evts = [];
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i].split(sep).map(s => s.trim().replace(/[""]/g, ""));
    if (v.length < hdr.length) continue;
    try {
      const ev = fmt.type === "events" ? parseEvtRow(v, fmt) : parseMonRow(v, fmt);
      if (ev) evts.push(ev);
    } catch { /* skip */ }
  }
  return { type: fmt.type, events: evts };
}

function detectFmt(h) {
  const ti = h.findIndex(x => /^(time|datetime|timestamp|data)/.test(x));
  const ci = h.findIndex(x => /charged|kwh|energia|energy|consumo/.test(x));
  const di = h.findIndex(x => /duration|duraç|duracao/.test(x));
  const si = h.findIndex(x => /^start/.test(x));
  const ei = h.findIndex(x => /^end/.test(x));
  if (ti >= 0 && ci >= 0) return { type: "events", ti, ci, di, si, ei };
  const mi = h.findIndex(x => /^(m[eê]s|month|date|periodo)/.test(x));
  const pi = h.findIndex(x => /ponta|peak/.test(x));
  const chi = h.findIndex(x => /cheia|mid|shoulder/.test(x));
  const vi = h.findIndex(x => /vazio|off.?peak/.test(x));
  if (pi >= 0 && chi >= 0 && vi >= 0) return { type: "monthly", mi: mi >= 0 ? mi : 0, pi, chi, vi };
  if (h.length >= 4) return { type: "monthly", mi: 0, vi: 1, chi: 2, pi: 3 };
  return null;
}

function pNum(v) { if (!v) return NaN; return parseFloat(v.replace(",", ".").replace(/[^\d.\-]/g, "")); }

function parseDur(s) {
  if (!s) return 0;
  let m = s.match(/(\d+):(\d+):(\d+)/);
  if (m) return +m[1]*60 + +m[2] + +m[3]/60;
  m = s.match(/(\d+):(\d+)/);
  if (m) return +m[1]*60 + +m[2];
  return parseFloat(s) || 0;
}

function parseEvtRow(v, f) {
  const d = new Date(v[f.ti].replace(/\//g, "-"));
  if (isNaN(d.getTime())) return null;
  const kwh = pNum(v[f.ci]);
  if (isNaN(kwh) || kwh <= 0) return null;
  let dur = 0;
  if (f.di >= 0) dur = parseDur(v[f.di]);
  else if (f.si >= 0 && f.ei >= 0) {
    const s = v[f.si].match(/(\d+):(\d+)/), e = v[f.ei].match(/(\d+):(\d+)/);
    if (s && e) { const sm = +s[1]*60+ +s[2], em = +e[1]*60+ +e[2]; dur = em > sm ? em-sm : 1440-sm+em; }
  }
  if (dur <= 0) dur = 60;
  const b = classifyEvent(d, dur, kwh);
  const mo = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  return { date: d.toISOString(), month: mo, durMin: dur, kwh, ...b, uid: `${v[f.ti]}_${kwh}` };
}

function parseMonRow(v, f) {
  const mo = parseMo(v[f.mi]); if (!mo) return null;
  const p = pNum(v[f.pi]), c = pNum(v[f.chi]), vz = pNum(v[f.vi]);
  if (isNaN(p)||isNaN(c)||isNaN(vz)) return null;
  return { date: `${mo}-15T00:00:00`, month: mo, durMin: 0, kwh: p+c+vz, ponta: p, cheias: c, vazio: vz, uid: `m_${mo}` };
}

function parseMo(val) {
  if (!val) return null;
  let m = val.match(/^(\d{4})[\/\-](\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2,"0")}`;
  m = val.match(/^(\d{1,2})[\/\-](\d{4})/); if (m) return `${m[2]}-${m[1].padStart(2,"0")}`;
  m = val.match(/^(\d{4})[\/\-](\d{1,2})[\/\-]\d/); if (m) return `${m[1]}-${m[2].padStart(2,"0")}`;
  const mos = {jan:"01",fev:"02",feb:"02",mar:"03",abr:"04",apr:"04",mai:"05",may:"05",jun:"06",jul:"07",ago:"08",aug:"08",set:"09",sep:"09",out:"10",oct:"10",nov:"11",dez:"12",dec:"12"};
  m = val.match(/([a-záéíóúãõ]{3})\w*\s*[\/\-]?\s*(\d{4})/i);
  if (m && mos[m[1].toLowerCase()]) return `${m[2]}-${mos[m[1].toLowerCase()]}`;
  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   Default EDP Rates (approx 2026, 6.9 kVA, Eletricidade Verde)
   ═══════════════════════════════════════════════════════════════════ */
const DEF_RATES = {
  id: "current",
  ponta: 0.2452,
  cheias: 0.0412,
  vazio: 0.0158,
  potenciaDia: 0.3819,
  iva: 0.06,
  label: "EDP Tri-Horária (10,35 kW)",
  lastUpdated: "2025-12-22",
};

/* ═══════════════════════════════════════════════════════════════════
   Aggregation
   ═══════════════════════════════════════════════════════════════════ */
function aggregate(events, rates) {
  const mp = {};
  events.forEach(ev => {
    if (!mp[ev.month]) mp[ev.month] = { month: ev.month, vazio: 0, cheias: 0, ponta: 0, sessions: 0, kwh: 0, totalDur: 0 };
    mp[ev.month].vazio += ev.vazio;
    mp[ev.month].cheias += ev.cheias;
    mp[ev.month].ponta += ev.ponta;
    mp[ev.month].kwh += ev.kwh;
    mp[ev.month].totalDur += ev.durMin;
    mp[ev.month].sessions++;
  });
  return Object.values(mp).sort((a, b) => a.month.localeCompare(b.month)).map(m => {
    const cP = m.ponta * rates.ponta;
    const cC = m.cheias * rates.cheias;
    const cV = m.vazio * rates.vazio;
    const energy = cP + cC + cV;
    // Note: potência is a fixed daily cost on your bill regardless of EV charging
    // For EV tracking we show just the energy cost; the full bill section adds potência
    const energyIva = energy * (1 + rates.iva);
    return {
      ...m, label: moLabel(m.month),
      cP: +cP.toFixed(2), cC: +cC.toFixed(2), cV: +cV.toFixed(2),
      energy: +energy.toFixed(2),
      energyIva: +energyIva.toFixed(2),
      avgPerSession: m.sessions > 0 ? +(energyIva / m.sessions).toFixed(2) : 0,
      avgKwhSession: m.sessions > 0 ? +(m.kwh / m.sessions).toFixed(2) : 0,
      costPerKwh: m.kwh > 0 ? +(energyIva / m.kwh).toFixed(4) : 0,
    };
  });
}

function moLabel(m) {
  const [y, mo] = m.split("-");
  const n = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return `${n[+mo-1]} ${y}`;
}

function aggregateWeekly(events, rates) {
  const wp = {};
  events.forEach(ev => {
    const d = new Date(ev.date);
    const dow = d.getDay() === 0 ? 6 : d.getDay() - 1; // days since Monday
    const mon = new Date(d); mon.setDate(d.getDate() - dow); mon.setHours(0,0,0,0);
    const key = mon.toISOString().slice(0,10);
    const label = `${String(mon.getDate()).padStart(2,"0")}/${String(mon.getMonth()+1).padStart(2,"0")}`;
    if (!wp[key]) wp[key] = { key, label, vazio: 0, cheias: 0, ponta: 0, kwh: 0, sessions: 0 };
    wp[key].vazio += ev.vazio; wp[key].cheias += ev.cheias; wp[key].ponta += ev.ponta;
    wp[key].kwh += ev.kwh; wp[key].sessions++;
  });
  return Object.values(wp).sort((a,b) => a.key.localeCompare(b.key)).map(w => {
    const energy = w.ponta*rates.ponta + w.cheias*rates.cheias + w.vazio*rates.vazio;
    return { ...w, energy: +energy.toFixed(2), energyIva: +(energy*(1+rates.iva)).toFixed(2) };
  });
}

/* ═══════════════════════════════════════════════════════════════════
   Nord colour palette — https://www.nordtheme.com
   Installed via: npm install nord  (CSS vars also loaded in main.jsx)
   ═══════════════════════════════════════════════════════════════════ */
const NORD = {
  // Polar Night
  n0:"#2E3440", n1:"#3B4252", n2:"#434C5E", n3:"#4C566A",
  // Snow Storm
  n4:"#D8DEE9", n5:"#E5E9F0", n6:"#ECEFF4",
  // Frost
  n7:"#8FBCBB", n8:"#88C0D0", n9:"#81A1C1", n10:"#5E81AC",
  // Aurora
  n11:"#BF616A", n12:"#D08770", n13:"#EBCB8B", n14:"#A3BE8C", n15:"#B48EAD",
};

const THEMES = {
  dark: {
    bg:      NORD.n0,          // #2E3440  page background (Polar Night)
    bg2:     "#2A3344",        // inner nested — Frost-tinted dark, distinct from both bg and card
    card:    NORD.n1,          // #3B4252  outer cards — clearly raised from bg
    cardH:   NORD.n2,          // #434C5E  hover
    brd:    `${NORD.n8}35`,    // Frost blue border, semi-transparent
    brdL:   `${NORD.n8}60`,    // Frost blue border, brighter on hover
    ponta:   NORD.n11,         // #BF616A  Aurora red
    cheias:  NORD.n13,         // #EBCB8B  Aurora yellow
    vazio:   NORD.n14,         // #A3BE8C  Aurora green
    accent:  NORD.n8,          // #88C0D0  Frost
    accentD: NORD.n10,         // #5E81AC  Frost dark
    accentBg:`${NORD.n8}22`,
    txt:     NORD.n6,          // #ECEFF4  Snow Storm — primary text
    txtD:    NORD.n4,          // #D8DEE9  Snow Storm — secondary text
    txtM:    NORD.n9,          // #81A1C1  Frost — muted text (characteristic Nord tint)
    ok:      NORD.n14,
    err:     NORD.n11,
  },
  light: {
    bg: NORD.n6, bg2: NORD.n5, card: "#FFFFFF", cardH: NORD.n4,
    brd: NORD.n4, brdL: "#C3CCE0",
    ponta: NORD.n11, cheias: "#A07000", vazio: "#4A7A38",
    accent: NORD.n10, accentD: NORD.n9, accentBg: `${NORD.n10}18`,
    txt: NORD.n0, txtD: NORD.n2, txtM: NORD.n3,
    ok: "#4A7A38", err: NORD.n11,
  },
};

const PL = { ponta: "Ponta", cheias: "Cheias", vazio: "Vazio" };

/* ═══════════════════════════════════════════════════════════════════
   Schedule Preview Data
   ═══════════════════════════════════════════════════════════════════ */
const SCHED = Array.from({ length: 48 }, (_, i) => {
  const min = i * 30;
  const wdW = periodAt(min, new Date(2026, 0, 5)); // Jan Mon
  const weW = periodAt(min, new Date(2026, 0, 3)); // Jan Sat
  const wdS = periodAt(min, new Date(2026, 6, 6)); // Jul Mon
  const weS = periodAt(min, new Date(2026, 6, 5)); // Jul Sat
  return { min, h: Math.floor(min/60), wdW, weW, wdS, weS };
});

/* ═══════════════════════════════════════════════════════════════════
   App
   ═══════════════════════════════════════════════════════════════════ */
export default function App() {
  const [events, setEvents] = useState([]);
  const [rates, setRates] = useState(DEF_RATES);
  const [view, setView] = useState("dashboard");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editR, setEditR] = useState(null);
  const [ready, setReady] = useState(false);
  const fRef = useRef(null);
  const [odPath, setOdPath] = useState(() => localStorage.getItem("od_path") || "");
  const [odBusy, setOdBusy] = useState(false);
  const [odMsg, setOdMsg] = useState(null);
  const [chartMode, setChartMode] = useState("monthly");
  const [theme, setTheme] = useState(() => localStorage.getItem("edp_theme") || "dark");
  const C = THEMES[theme];
  const PC = { ponta: C.ponta, cheias: C.cheias, vazio: C.vazio };
  const TT = {
    contentStyle: { background: C.card, border: `1px solid ${C.brd}`, borderRadius: 12, fontFamily: "'Outfit',sans-serif", fontSize: 13, boxShadow: "0 12px 40px rgba(0,0,0,.5)" },
    labelStyle: { color: C.txt, fontWeight: 600, marginBottom: 4 },
  };
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("edp_theme", next);
  };

  useEffect(() => {
    (async () => {
      try {
        const ev = await dbAll(S_EV); setEvents(ev.sort((a,b) => a.date.localeCompare(b.date)));
        const r = await dbAll(S_RT); if (r.length) setRates(r[0]);
      } catch(e) { console.error(e); }
      setReady(true);
    })();
  }, []);

  const reload = async () => {
    const ev = await dbAll(S_EV);
    setEvents(ev.sort((a,b) => a.date.localeCompare(b.date)));
  };

  const saveR = async r => { setRates(r); await dbPut(S_RT, r); };

  // Import CSV
  const onImport = useCallback(async e => {
    const file = e.target.files?.[0]; if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const { type, events: parsed } = parseCSV(await file.text());
      if (!parsed.length) throw new Error("No valid records found");
      const ex = new Set((await dbAll(S_EV)).map(e => e.uid));
      let add = 0, skip = 0;
      for (const ev of parsed) { if (ex.has(ev.uid)) { skip++; continue; } await dbPut(S_EV, ev); add++; }
      await reload();
      setMsg({ ok: true, text: `Imported ${add} ${type === "events" ? "sessions" : "months"}, ${skip} duplicates skipped` });
    } catch(err) { setMsg({ ok: false, text: err.message }); }
    setBusy(false);
    if (fRef.current) fRef.current.value = "";
  }, []);

  // Export
  const onExport = fmt => {
    let c, fn, mt;
    if (fmt === "json") {
      c = JSON.stringify({ events, rates }, null, 2); fn = "edp_ev_backup.json"; mt = "application/json";
    } else {
      c = "Time,Duration_min,kWh,Vazio_kWh,Cheias_kWh,Ponta_kWh\n" +
        events.map(e => `${e.date},${e.durMin.toFixed(1)},${e.kwh},${e.vazio.toFixed(3)},${e.cheias.toFixed(3)},${e.ponta.toFixed(3)}`).join("\n");
      fn = "edp_ev_sessions.csv"; mt = "text/csv";
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([c], { type: mt }));
    a.download = fn; a.click();
  };

  const onRestore = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (d.rates) await saveR(d.rates);
      if (d.events?.length) { await dbClear(S_EV); for (const ev of d.events) await dbPut(S_EV, ev); await reload(); }
      setMsg({ ok: true, text: "Backup restored!" });
    } catch(err) { setMsg({ ok: false, text: "Bad file: " + err.message }); }
  };

  const onClearAll = async () => {
    if (!confirm("Delete ALL charging sessions? Cannot be undone.")) return;
    await dbClear(S_EV); setEvents([]);
  };

  const onSyncOneDrive = useCallback(async () => {
    if (OD_CLIENT_ID === "PASTE_YOUR_CLIENT_ID_HERE") {
      setOdMsg({ ok: false, text: "Azure Client ID not configured yet — paste it into the code first (see setup guide)." });
      return;
    }
    if (!odPath.trim()) {
      setOdMsg({ ok: false, text: "Enter the OneDrive file path first." });
      return;
    }
    setOdBusy(true); setOdMsg(null);
    try {
      const text = await fetchOneDriveFile(odPath.trim());
      const { type, events: parsed } = parseCSV(text);
      if (!parsed.length) throw new Error("No valid records found in OneDrive file");
      const ex = new Set((await dbAll(S_EV)).map(e => e.uid));
      let add = 0, skip = 0;
      for (const ev of parsed) {
        if (ex.has(ev.uid)) { skip++; continue; }
        await dbPut(S_EV, ev); add++;
      }
      await reload();
      setOdMsg({ ok: true, text: `OneDrive sync: ${add} new ${type === "events" ? "sessions" : "months"} imported, ${skip} duplicates skipped.` });
    } catch (err) { setOdMsg({ ok: false, text: err.message }); }
    setOdBusy(false);
  }, [odPath]);

  // ── Aggregated data ──
  const monthly = useMemo(() => aggregate(events, rates), [events, rates]);
  const latest = monthly.length ? monthly[monthly.length - 1] : null;
  const totals = useMemo(() => {
    if (!monthly.length) return { cost: 0, kwh: 0, sessions: 0 };
    return {
      cost: monthly.reduce((s,m) => s+m.energyIva, 0),
      kwh: monthly.reduce((s,m) => s+m.kwh, 0),
      sessions: events.length,
    };
  }, [monthly, events]);
  const avgMo = monthly.length ? { cost: totals.cost/monthly.length, kwh: totals.kwh/monthly.length } : { cost: 0, kwh: 0 };
  const weekly = useMemo(() => aggregateWeekly(events, rates), [events, rates]);
  const chartData = chartMode === "monthly" ? monthly : weekly;

  if (!ready) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: C.accent, fontFamily: "'Outfit',sans-serif" }}>Loading…</div>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Outfit',sans-serif", color: C.txt }}>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${C.brd};border-radius:3px}
        .cd{background:${C.card};border:1px solid ${C.brd};border-radius:14px;padding:22px;transition:border-color .2s}
        .cd:hover{border-color:${C.brdL}}
        .b{padding:9px 18px;border:1px solid ${C.brd};border-radius:9px;background:${C.card};color:${C.txt};cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;transition:all .15s;display:inline-flex;align-items:center;gap:6px}
        .b:hover{background:${C.cardH};border-color:${C.brdL}}
        .bp{background:${C.accentD};border-color:transparent;color:#fff}.bp:hover{background:${C.accent}}
        .bs{padding:6px 14px;font-size:12px}
        .bd{border-color:${C.err}33;color:${C.err}}.bd:hover{background:${C.err}18;border-color:${C.err}55}
        .nb{padding:7px 15px;border:none;border-radius:8px;background:transparent;color:${C.txtD};cursor:pointer;font-family:inherit;font-size:13px;font-weight:500;transition:all .15s}
        .nb:hover{color:${C.txt};background:${C.bg2}}
        .nb.on{color:${C.accent};background:${C.accentBg}}
        .mo{font-family:'JetBrains Mono',monospace}
        @keyframes su{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .su{animation:su .35s ease-out forwards}
        .recharts-tooltip-wrapper{outline:none!important}
        @media(max-width:600px){main{padding:12px 10px!important}.chart-2col{grid-template-columns:1fr!important}}
        @media(max-width:400px){.grid-periods{grid-template-columns:1fr!important;width:100%}}
        .tg{display:inline-block;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600;letter-spacing:.3px}
        .inp{padding:9px 12px;border:1px solid ${C.brd};border-radius:9px;background:${C.bg2};color:${C.txt};font-family:'JetBrains Mono',monospace;font-size:14px;width:100%;outline:none;transition:border-color .15s}
        .inp:focus{border-color:${C.accent}}
      `}</style>

      {/* ═══ HEADER ═══ */}
      <header style={{ borderBottom: `1px solid ${C.brd}`, padding: "13px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${NORD.n10}, ${NORD.n8})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="bx bxs-bolt" style={{ fontSize: 22, color: NORD.n6, lineHeight: 1 }}></i>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: -.3 }}>EDP EV Charging Tracker</div>
            <div style={{ fontSize: 11, color: C.txtM, letterSpacing: .3 }}>Tri-Horária · Ciclo Diário · Portugal</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={toggleTheme} title={theme === "dark" ? "Switch to light" : "Switch to dark"}
            style={{ width: 34, height: 34, borderRadius: 9, border: `1px solid ${C.brd}`, background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className={`bx ${theme === "dark" ? "bx-sun" : "bx-moon"}`} style={{ fontSize: 19, color: NORD.n9 }}></i>
          </button>
        <nav style={{ display: "flex", gap: 3, background: C.bg2, padding: 3, borderRadius: 10, border: `1px solid ${C.brd}` }}>
          {[
            { id: "dashboard", icon: "📊", l: "Dashboard" },
            { id: "sessions", icon: "🔋", l: "Sessões" },
            { id: "import", icon: "📁", l: "Import" },
            { id: "rates", icon: "💰", l: "Tarifas" },
          ].map(t => (
            <button key={t.id} className={`nb ${view===t.id?"on":""}`} onClick={() => setView(t.id)}>{t.icon} {t.l}</button>
          ))}
        </nav>
        </div>
      </header>

      <main style={{ padding: "22px 24px", maxWidth: 1220, margin: "0 auto" }}>

        {/* ═══════════════════ DASHBOARD ═══════════════════ */}
        {view === "dashboard" && (
          <div className="su">
            {!events.length ? (
              <EmptyState onAction={() => setView("import")} C={C} />
            ) : (<>
              {/* KPIs */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
                {[
                  { l: "Último mês", v: latest ? `€${latest.energyIva.toFixed(2)}` : "—", s: latest?.label, c: C.accent },
                  { l: "Custo médio / mês", v: `€${avgMo.cost.toFixed(2)}`, s: `${monthly.length} meses`, c: C.txt },
                  { l: "kWh médio / mês", v: `${avgMo.kwh.toFixed(0)} kWh`, s: "carregamento", c: C.txt },
                  { l: "Custo / sessão (últ.)", v: latest ? `€${latest.avgPerSession.toFixed(2)}` : "—", s: latest ? `${latest.sessions} sessões` : "", c: C.cheias },
                  { l: "€/kWh real (últ.)", v: latest ? `€${latest.costPerKwh.toFixed(4)}` : "—", s: "com IVA", c: C.vazio },
                  { l: "Total sessões", v: `${totals.sessions}`, s: `${totals.kwh.toFixed(0)} kWh total`, c: C.ponta },
                ].map((k,i) => (
                  <div className="cd" key={i}>
                    <div style={{ fontSize: 11, color: C.txtM, fontWeight: 500, textTransform: "uppercase", letterSpacing: .6 }}>{k.l}</div>
                    <div className="mo" style={{ fontSize: 23, fontWeight: 700, color: k.c, marginTop: 5 }}>{k.v}</div>
                    {k.s && <div style={{ fontSize: 11.5, color: C.txtM, marginTop: 1 }}>{k.s}</div>}
                  </div>
                ))}
              </div>

              {/* Monthly charging cost trend */}
              <div className="cd" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <h3 style={{ fontWeight: 600, fontSize: 15 }}>Custo de Carregamento (€ c/ IVA)</h3>
                  <div style={{ display: "flex", gap: 3, background: C.bg2, padding: 3, borderRadius: 8, border: `1px solid ${C.brd}` }}>
                    <button className={`nb ${chartMode==="monthly"?"on":""}`} style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setChartMode("monthly")}>Mensal</button>
                    <button className={`nb ${chartMode==="weekly"?"on":""}`} style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setChartMode("weekly")}>Semanal</button>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={270}>
                  <ComposedChart data={chartData} margin={{ top: 5, right: 8, left: -10, bottom: 5 }}>
                    <defs>
                      <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.accent} stopOpacity={.25} /><stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.brd} />
                    <XAxis dataKey="label" tick={{ fill: C.txtM, fontSize: 11 }} axisLine={{ stroke: C.brd }} />
                    <YAxis tick={{ fill: C.txtM, fontSize: 11 }} axisLine={{ stroke: C.brd }} tickFormatter={v => `€${v}`} />
                    <Tooltip {...TT} formatter={v => [`€${Number(v).toFixed(2)}`,""]} />
                    <Area type="monotone" dataKey="energyIva" fill="url(#cg)" stroke="none" />
                    <Line type="monotone" dataKey="energyIva" stroke={C.accent} strokeWidth={2.5} dot={{ fill: C.accent, r: 4, strokeWidth: 0 }} name="Custo c/ IVA" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Two-col: cost by period + kWh */}
              <div className="chart-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div className="cd">
                  <h3 style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>Custo por Período (€)</h3>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={monthly} margin={{ top: 5, right: 8, left: -10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.brd} />
                      <XAxis dataKey="label" tick={{ fill: C.txtM, fontSize: 10 }} axisLine={{ stroke: C.brd }} />
                      <YAxis tick={{ fill: C.txtM, fontSize: 11 }} axisLine={{ stroke: C.brd }} tickFormatter={v => `€${v}`} />
                      <Tooltip {...TT} formatter={v => [`€${Number(v).toFixed(2)}`,""]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="cP" name="Ponta" stackId="a" fill={C.ponta} />
                      <Bar dataKey="cC" name="Cheias" stackId="a" fill={C.cheias} />
                      <Bar dataKey="cV" name="Vazio" stackId="a" fill={C.vazio} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="cd">
                  <h3 style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>kWh Carregado por Período</h3>
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={monthly} margin={{ top: 5, right: 8, left: -10, bottom: 5 }}>
                      <defs>
                        {["ponta","cheias","vazio"].map(p => (
                          <linearGradient key={p} id={`g${p}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={PC[p]} stopOpacity={.3}/><stop offset="100%" stopColor={PC[p]} stopOpacity={0}/>
                          </linearGradient>
                        ))}
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.brd} />
                      <XAxis dataKey="label" tick={{ fill: C.txtM, fontSize: 10 }} axisLine={{ stroke: C.brd }} />
                      <YAxis tick={{ fill: C.txtM, fontSize: 11 }} axisLine={{ stroke: C.brd }} />
                      <Tooltip {...TT} formatter={v => [`${Number(v).toFixed(1)} kWh`,""]} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="ponta" name="Ponta" stroke={C.ponta} fill="url(#gponta)" strokeWidth={2} />
                      <Area type="monotone" dataKey="cheias" name="Cheias" stroke={C.cheias} fill="url(#gcheias)" strokeWidth={2} />
                      <Area type="monotone" dataKey="vazio" name="Vazio" stroke={C.vazio} fill="url(#gvazio)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Latest month detail */}
              {latest && (
                <div className="cd">
                  <h3 style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>
                    Detalhe — {latest.label}
                    <span className="tg" style={{ background: C.accentBg, color: C.accent, marginLeft: 10 }}>{latest.sessions} sessões</span>
                    <span className="tg mo" style={{ background: `${C.vazio}18`, color: C.vazio, marginLeft: 6 }}>{latest.kwh.toFixed(1)} kWh</span>
                  </h3>
                  <div className="grid-periods" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 14 }}>
                    {["ponta","cheias","vazio"].map(p => {
                      const kwh = latest[p], cost = latest[`c${p.charAt(0).toUpperCase()}`];
                      const pct = latest.kwh > 0 ? kwh/latest.kwh*100 : 0;
                      return (
                        <div key={p} style={{ background: C.bg2, padding: 18, borderRadius: 12, border: `1px solid ${C.brd}` }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <div style={{ width: 10, height: 10, borderRadius: 3, background: PC[p] }} />
                            <span style={{ fontWeight: 600, fontSize: 14 }}>{PL[p]}</span>
                            <span className="tg mo" style={{ background: `${PC[p]}18`, color: PC[p], marginLeft: "auto" }}>€{rates[p].toFixed(4)}/kWh</span>
                          </div>
                          <div className="mo" style={{ fontSize: 22, fontWeight: 700 }}>{kwh.toFixed(1)} <span style={{ fontSize: 13, color: C.txtD, fontWeight: 400 }}>kWh</span></div>
                          <div className="mo" style={{ color: PC[p], fontSize: 16, fontWeight: 600, marginTop: 3 }}>€{cost.toFixed(2)}</div>
                          <div style={{ marginTop: 10, height: 4, background: C.brd, borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${pct}%`, height: "100%", background: PC[p], borderRadius: 2 }} />
                          </div>
                          <div style={{ fontSize: 11, color: C.txtM, marginTop: 4 }}>{pct.toFixed(1)}% do consumo</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
                    {[
                      { l: "Energia (s/ IVA)", v: `€${latest.energy.toFixed(2)}` },
                      { l: "IVA (6%)", v: `€${(latest.energyIva - latest.energy).toFixed(2)}` },
                      { l: "Total carregamento", v: `€${latest.energyIva.toFixed(2)}`, bold: true },
                      { l: "Média / sessão", v: `€${latest.avgPerSession.toFixed(2)}` },
                    ].map(r => (
                      <div key={r.l} style={{ background: C.bg2, padding: 12, borderRadius: 10, border: `1px solid ${r.bold ? C.accent+"44" : C.brd}` }}>
                        <div style={{ fontSize: 11, color: C.txtM }}>{r.l}</div>
                        <div className="mo" style={{ fontWeight: r.bold ? 700 : 600, fontSize: r.bold ? 18 : 15, color: r.bold ? C.accent : C.txt, marginTop: 2 }}>{r.v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>)}
          </div>
        )}

        {/* ═══════════════════ SESSIONS ═══════════════════ */}
        {view === "sessions" && (
          <div className="su">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <h2 style={{ fontWeight: 700, fontSize: 20 }}>Sessões de Carregamento</h2>
                <p style={{ color: C.txtD, fontSize: 13 }}>{events.length} sessões · {monthly.length} meses</p>
              </div>
              {events.length > 0 && <button className="b bs bd" onClick={onClearAll}>Apagar tudo</button>}
            </div>
            {!events.length ? (
              <EmptyState onAction={() => setView("import")} C={C} />
            ) : (
              <div className="cd" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${C.brd}` }}>
                        {["Data / Hora","Duração","kWh","Vazio","Cheias","Ponta","Custo €",""].map(h => (
                          <th key={h} style={{ padding: "12px 13px", textAlign: "left", fontWeight: 600, fontSize: 10.5, color: C.txtM, textTransform: "uppercase", letterSpacing: .5 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...events].reverse().map(ev => {
                        const d = new Date(ev.date);
                        const cost = (ev.ponta*rates.ponta + ev.cheias*rates.cheias + ev.vazio*rates.vazio) * (1+rates.iva);
                        const dom = ev.ponta >= ev.cheias && ev.ponta >= ev.vazio ? "ponta" : ev.cheias >= ev.vazio ? "cheias" : "vazio";
                        return (
                          <tr key={ev.id} style={{ borderBottom: `1px solid ${C.brd}08` }}>
                            <td style={{ padding: "10px 13px", whiteSpace: "nowrap" }}>
                              <span style={{ fontWeight: 500 }}>{d.toLocaleDateString("pt-PT")}</span>
                              <span className="mo" style={{ color: C.txtM, marginLeft: 8, fontSize: 12 }}>{d.toLocaleTimeString("pt-PT",{hour:"2-digit",minute:"2-digit"})}</span>
                            </td>
                            <td className="mo" style={{ padding: "10px 13px", color: C.txtD, fontSize: 12 }}>{Math.round(ev.durMin)} min</td>
                            <td className="mo" style={{ padding: "10px 13px", fontWeight: 600 }}>{ev.kwh.toFixed(1)}</td>
                            <td className="mo" style={{ padding: "10px 13px", color: C.vazio, fontSize: 12 }}>{ev.vazio.toFixed(2)}</td>
                            <td className="mo" style={{ padding: "10px 13px", color: C.cheias, fontSize: 12 }}>{ev.cheias.toFixed(2)}</td>
                            <td className="mo" style={{ padding: "10px 13px", color: C.ponta, fontSize: 12 }}>{ev.ponta.toFixed(2)}</td>
                            <td className="mo" style={{ padding: "10px 13px", fontWeight: 600, color: PC[dom], fontSize: 12 }}>€{cost.toFixed(3)}</td>
                            <td style={{ padding: "10px 13px" }}>
                              <button className="b bs bd" style={{ padding: "3px 8px" }} onClick={() => dbDel(S_EV, ev.id).then(reload)}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════ IMPORT ═══════════════════ */}
        {view === "import" && (
          <div className="su" style={{ maxWidth: 640, margin: "0 auto" }}>
            <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 6 }}>Importar Dados</h2>
            <p style={{ color: C.txtD, fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>
              Carregue o CSV do seu carregador EV. O parser detecta o formato automaticamente e classifica cada sessão em Vazio/Cheias/Ponta com base nos horários oficiais EDP.
            </p>

            <div className="cd" style={{ marginBottom: 14 }}>
              <h3 style={{ fontWeight: 600, fontSize: 14, color: C.accent, marginBottom: 10 }}>Formatos aceites</h3>
              <div className="mo" style={{ background: C.bg2, borderRadius: 10, padding: 16, fontSize: 12, color: C.txtD, lineHeight: 1.9, overflowX: "auto" }}>
                <div style={{ color: C.vazio, fontWeight: 600 }}>▸ Sessões do carregador (o seu formato):</div>
                Time,Start:,End:,Duration:,Charged:(kWh)<br/>
                2026-03-06 10:46:18,10:46,11:39,00:52:56,2.2<br/><br/>
                <div style={{ color: C.cheias, fontWeight: 600 }}>▸ Mensal (agregado):</div>
                Mês;kWh Vazio;kWh Cheias;kWh Ponta<br/>
                2025-01;180.5;120.3;45.2
              </div>
            </div>

            <div className="cd" style={{ marginBottom: 14 }}>
              <h3 style={{ fontWeight: 600, fontSize: 14, color: C.accent, marginBottom: 6 }}>☁️ Sync from OneDrive</h3>
              <p style={{ fontSize: 13, color: C.txtD, marginBottom: 12, lineHeight: 1.6 }}>
                Enter the path to your CSV inside OneDrive (relative to your OneDrive root). The app will sign you in with Microsoft, read the file, and import any new sessions — duplicates are skipped automatically.
              </p>
              <input
                className="inp"
                placeholder="e.g. EV-Tracker/charges.csv"
                value={odPath}
                onChange={e => { setOdPath(e.target.value); localStorage.setItem("od_path", e.target.value); }}
                style={{ marginBottom: 10 }}
              />
              <button className="b bp" onClick={onSyncOneDrive} disabled={odBusy || !odPath.trim()}>
                {odBusy ? "⏳ A sincronizar…" : "☁️ Sincronizar com OneDrive"}
              </button>
              {odMsg && (
                <div style={{ marginTop: 12, padding: "10px 16px", borderRadius: 10, fontSize: 13,
                  background: odMsg.ok ? `${C.ok}12` : `${C.err}12`,
                  border: `1px solid ${odMsg.ok ? C.ok : C.err}30`,
                  color: odMsg.ok ? C.ok : C.err,
                }}>{odMsg.text}</div>
              )}
              {OD_CLIENT_ID === "PASTE_YOUR_CLIENT_ID_HERE" && (
                <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 12,
                  background: `${C.cheias}15`, border: `1px solid ${C.cheias}40`, color: C.cheias }}>
                  ⚠️ Azure Client ID not configured — follow the setup guide below and paste your ID into the code.
                </div>
              )}
            </div>

            <div className="cd" style={{ marginBottom: 14 }}>
              <h3 style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Upload CSV</h3>
              <input ref={fRef} type="file" accept=".csv,.txt" onChange={onImport} style={{ display: "none" }} />
              <button className="b bp" onClick={() => fRef.current?.click()} disabled={busy}>
                {busy ? "⏳ A processar…" : "📁 Selecionar ficheiro CSV"}
              </button>
              {msg && (
                <div style={{ marginTop: 12, padding: "10px 16px", borderRadius: 10, fontSize: 13,
                  background: msg.ok ? `${C.ok}12` : `${C.err}12`,
                  border: `1px solid ${msg.ok ? C.ok : C.err}30`,
                  color: msg.ok ? C.ok : C.err,
                }}>{msg.text}</div>
              )}
            </div>

            <div className="cd" style={{ marginBottom: 14 }}>
              <h3 style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Backup & Restauro</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="b bs" onClick={() => onExport("json")}>💾 Backup JSON</button>
                <button className="b bs" onClick={() => onExport("csv")}>📄 Exportar CSV</button>
                <label className="b bs" style={{ cursor: "pointer" }}>📥 Restaurar backup<input type="file" accept=".json" onChange={onRestore} style={{ display: "none" }} /></label>
              </div>
            </div>

            {/* Schedule reference */}
            <div className="cd">
              <h3 style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Horários EDP — Ciclo Diário</h3>
              <p style={{ fontSize: 12, color: C.txtD, marginBottom: 14, lineHeight: 1.6 }}>
                Cada sessão é classificada automaticamente com base na hora, dia da semana e estação. Sessões que cruzam períodos são divididas proporcionalmente.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                {[{ t: "Inverno (Nov–Mar) — Dias úteis", k: "wdW" }, { t: "Verão (Abr–Out) — Dias úteis", k: "wdS" }].map(s => (
                  <div key={s.k} style={{ background: C.bg2, borderRadius: 10, padding: 12, border: `1px solid ${C.brd}` }}>
                    <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 8 }}>{s.t}</div>
                    <div style={{ display: "flex", gap: 1, height: 22 }}>
                      {SCHED.map((h,i) => (
                        <div key={i} title={`${String(Math.floor(h.min/60)).padStart(2,"0")}:${String(h.min%60).padStart(2,"0")} — ${PL[h[s.k]]}`}
                          style={{ flex: 1, background: PC[h[s.k]], borderRadius: 1, opacity: .8 }} />
                      ))}
                    </div>
                    <div style={{ fontSize: 9.5, color: C.txtM, marginTop: 3, display: "flex", justifyContent: "space-between" }}>
                      <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.txtM, marginTop: 8, textAlign: "center" }}>
                Fins de semana: apenas Vazio (22h–8h) e Cheias (8h–22h) — sem Ponta
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 10, justifyContent: "center" }}>
                {["ponta","cheias","vazio"].map(p => (
                  <div key={p} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: PC[p] }} />
                    <span style={{ color: C.txtD }}>{PL[p]}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════ RATES ═══════════════════ */}
        {view === "rates" && (
          <div className="su" style={{ maxWidth: 640, margin: "0 auto" }}>
            <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 6 }}>Tarifas EDP</h2>
            <p style={{ color: C.txtD, fontSize: 14, marginBottom: 8, lineHeight: 1.6 }}>
              Tarifas de acesso às redes (ERSE) para Tri-Horária — 10,35 kW. Ajuste conforme o seu contrato.
            </p>
            <p style={{ fontSize: 12, color: C.txtM, marginBottom: 20 }}>
              Fonte:{" "}
              <a href="https://helpcenter.edp.pt/media/hswmizya/20251222_tarifas_acesso_redes.pdf"
                target="_blank" rel="noopener noreferrer"
                style={{ color: C.accent, textDecoration: "none" }}>
                EDP — Tarifas de Acesso às Redes (Dez 2025)
              </a>
            </p>

            <div className="cd" style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{rates.label}</div>
                  <div style={{ fontSize: 11, color: C.txtM }}>Atualização: {rates.lastUpdated}</div>
                </div>
                {!editR && <button className="b bs bp" onClick={() => setEditR({...rates})}>Editar</button>}
              </div>

              {editR ? (
                <div>
                  {[
                    { k: "ponta", l: "Ponta (€/kWh)", c: C.ponta },
                    { k: "cheias", l: "Cheias (€/kWh)", c: C.cheias },
                    { k: "vazio", l: "Vazio (€/kWh)", c: C.vazio },
                    { k: "potenciaDia", l: "Potência contratada (€/dia)", c: C.accent },
                    { k: "iva", l: "IVA (decimal — 0.06 = 6%)", c: C.txtD },
                  ].map(f => (
                    <div key={f.k} style={{ marginBottom: 11 }}>
                      <label style={{ fontSize: 12, color: f.c, fontWeight: 500, marginBottom: 4, display: "block" }}>{f.l}</label>
                      <input className="inp" type="number" step="0.0001" value={editR[f.k]}
                        onChange={e => setEditR({...editR, [f.k]: parseFloat(e.target.value)||0})} />
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <button className="b bs bp" onClick={() => { saveR({...editR, lastUpdated: new Date().toISOString().slice(0,10)}); setEditR(null); }}>Guardar</button>
                    <button className="b bs" onClick={() => setEditR(null)}>Cancelar</button>
                    <button className="b bs bd" onClick={() => setEditR({...DEF_RATES})}>Repor padrão</button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
                  {["ponta","cheias","vazio"].map(p => (
                    <div key={p} style={{ background: C.bg2, padding: 16, borderRadius: 12, border: `1px solid ${C.brd}`, textAlign: "center" }}>
                      <div style={{ width: 12, height: 12, borderRadius: 4, background: PC[p], margin: "0 auto 8px" }} />
                      <div style={{ fontSize: 12, color: C.txtD }}>{PL[p]}</div>
                      <div className="mo" style={{ fontWeight: 700, fontSize: 21, color: PC[p], marginTop: 4 }}>€{rates[p].toFixed(4)}</div>
                      <div style={{ fontSize: 11, color: C.txtM }}>por kWh</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="cd">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                {[
                  { l: "Potência contratada (€/dia)", v: `€${rates.potenciaDia.toFixed(4)}` },
                  { l: "IVA", v: `${(rates.iva*100).toFixed(1)}%` },
                ].map(r => (
                  <div key={r.l} style={{ background: C.bg2, padding: 14, borderRadius: 10, border: `1px solid ${C.brd}` }}>
                    <div style={{ fontSize: 11, color: C.txtM }}>{r.l}</div>
                    <div className="mo" style={{ fontWeight: 600, fontSize: 16, marginTop: 2 }}>{r.v}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: C.txtM, marginTop: 14, lineHeight: 1.6, background: C.bg2, padding: 12, borderRadius: 8 }}>
                <strong style={{ color: C.txtD }}>Nota:</strong> A potência contratada é um custo fixo diário na sua fatura, independente do carregamento EV. Os custos do dashboard refletem apenas a energia consumida no carregador + IVA.
              </div>
            </div>
          </div>
        )}
      </main>

      <footer style={{ borderTop: `1px solid ${C.brd}`, padding: "14px 24px", textAlign: "center", marginTop: 40 }}>
        <div style={{ fontSize: 11, color: C.txtM }}>
          EDP EV Charging Tracker · IndexedDB local · Tarifas são estimativas — confirme com a sua fatura
        </div>
      </footer>
    </div>
  );
}

function EmptyState({ onAction, C }) {
  return (
    <div style={{ textAlign: "center", padding: "80px 24px" }}>
      <div style={{ fontSize: 56, marginBottom: 16 }}>🔌</div>
      <h2 style={{ fontWeight: 700, fontSize: 24, marginBottom: 8 }}>Sem sessões de carregamento</h2>
      <p style={{ color: C.txtD, marginBottom: 24, maxWidth: 380, margin: "0 auto 24px" }}>
        Importe o CSV do seu carregador EV para ver custos, distribuição por período e tendências mensais.
      </p>
      <button className="b bp" onClick={onAction}>Importar CSV</button>
    </div>
  );
}
