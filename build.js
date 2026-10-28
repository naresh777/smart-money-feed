// Builds public/smart-feed.json (served on GitHub Pages) for StockApp's Smart money tab from public filings:
//   - SEC Form 4: open-market insider purchases (filed within 2 business days of the trade)
//   - SEC 13F-HR: latest holdings of well-known funds (filed up to 45 days after each quarter)
//   - House Clerk PTRs: stock trades members of Congress disclosed (up to 45 days after the trade)
// Run by .github/workflows/feed.yml, or locally: node build.js
// Each run only reads what is new since the last one; the previous file (downloaded from the live page) is the state.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const L = require('./lib');

const OUT = path.join(__dirname, 'public', 'smart-feed.json');
// The SEC asks for a real name and email ("Jane Doe jane@example.com"): the SEC_USER_AGENT repository secret.
// Without it the Form 4 and 13F parts keep their last data and only Congress updates.
const SEC_UA = (process.env.SEC_USER_AGENT || '').trim();
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const INSIDER_DAYS = 45, CONGRESS_DAYS = 60, MAX_BACKFILL = 22;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 864e5));

// Well-known stock pickers that file 13Fs (CIKs from the trader-copycat skill's filers.json, checked 2026-10-13)
const FUNDS = [
  [1067983, 'Berkshire Hathaway', 'Warren Buffett / Greg Abel'], [1336528, 'Pershing Square', 'Bill Ackman'],
  [1536411, 'Duquesne Family Office', 'Stanley Druckenmiller'], [1656456, 'Appaloosa', 'David Tepper'],
  [1061768, 'Baupost Group', 'Seth Klarman'], [1040273, 'Third Point', 'Dan Loeb'], [1709323, 'Himalaya Capital', 'Li Lu'],
  [921669, 'Icahn', 'Carl Icahn'], [1167483, 'Tiger Global', 'Chase Coleman'], [1135730, 'Coatue', 'Philippe Laffont'],
  [1061165, 'Lone Pine Capital', 'Stephen Mandel (founder)'], [1569205, 'Fundsmith', 'Terry Smith'],
  [1112520, 'Akre Capital', 'Chuck Akre (founder)'], [1549575, 'Dalal Street', 'Mohnish Pabrai'],
  [1096343, 'Markel Group', 'Tom Gayner'], [1697748, 'ARK Investment', 'Cathie Wood'], [1649339, 'Scion', 'Michael Burry'],
];

let lastSec = 0;
async function get(url, { as = 'text', ua = SEC_UA, tries = 3 } = {}) {
  const sec = /sec\.gov/.test(url);
  for (let k = 0; k < tries; k++) {
    if (sec) { const wait = lastSec + 125 - Date.now(); if (wait > 0) await sleep(wait); lastSec = Date.now(); } // under 10/s
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' } });
      if (r.status === 404) return as === 'idx' ? 404 : null;
      if (r.status === 403 && !sec) return null;
      if (!r.ok) throw new Error(String(r.status));
      if (as === 'json') return await r.json();
      if (as === 'buf') return Buffer.from(await r.arrayBuffer());
      if (as === 'idx') return await r.text();
      return await r.text();
    } catch (e) {
      if (k === tries - 1) { console.log('fail', url, e.message); return null; }
      await sleep(2000 * (k + 1));
    }
  }
}
const tag = (xml, t) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${t}>\\s*(?:<value>)?([^<]*)`, 'i')); return m ? m[1].trim() : ''; };
const mdy = (s) => { const m = (s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null; };

// ---------- Form 4 ----------
function parseForm4(txt, filed, url) {
  const x = (txt.match(/<ownershipDocument>[\s\S]*<\/ownershipDocument>/) || [])[0];
  if (!x) return [];
  const sym = tag(x, 'issuerTradingSymbol').toUpperCase();
  if (!/^[A-Z]{1,5}([.-][A-Z])?$/.test(sym)) return [];
  const owner = (x.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/) || [''])[0];
  const title = tag(owner, 'officerTitle');
  const yes = (t) => /^(1|true)$/i.test(tag(owner, t));
  const role = /CEO|chief executive|president/i.test(title) ? 'CEO' : /CFO|chief financial/i.test(title) ? 'CFO'
    : yes('isOfficer') ? (title || 'Officer') : yes('isDirector') ? 'Director' : yes('isTenPercentOwner') ? '10% owner' : 'Other';
  let sh = 0, val = 0, after = 0, date = null;
  for (const m of x.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const t = m[1];
    if (tag(t, 'transactionCode') !== 'P' || tag(t, 'transactionAcquiredDisposedCode') !== 'A') continue;
    const s = +tag(t, 'transactionShares'), p = +tag(t, 'transactionPricePerShare');
    if (!(s > 0 && p > 0)) continue;
    sh += s; val += s * p; after = Math.max(after, +tag(t, 'sharesOwnedFollowingTransaction') || 0); date = date || tag(t, 'transactionDate').slice(0, 10);
  }
  if (!val) return [];
  return [{ symbol: sym.replace('.', '-'), issuer: tag(x, 'issuerName'), insider: tag(owner, 'rptOwnerName'), cik: tag(owner, 'rptOwnerCik'), role,
    shares: Math.round(sh), value: Math.round(val), price: +(val / sh).toFixed(2), stakeUp: after > sh ? +(sh / (after - sh)).toFixed(3) : null, traded: date, filed, url }];
}

async function insiders(prev) {
  if (!SEC_UA) return prev.insider || { daysRead: [], buys: [] };
  const done = new Set(prev.insider?.daysRead || []);
  let buys = (prev.insider?.buys || []).filter((b) => b.filed >= daysAgo(INSIDER_DAYS));
  const seen = new Set(buys.map((b) => b.url));
  const days = [];
  for (let k = MAX_BACKFILL + 4; k >= 0; k--) {
    const d = new Date(Date.now() - k * 864e5);
    if (d.getUTCDay() % 6 && !done.has(isoDay(d))) days.push(d);
  }
  for (const d of days.slice(-MAX_BACKFILL)) {
    const ymd = isoDay(d).replace(/-/g, '');
    const idx = await get(`https://www.sec.gov/Archives/edgar/daily-index/${d.getUTCFullYear()}/QTR${Math.floor(d.getUTCMonth() / 3) + 1}/form.${ymd}.idx`, { as: 'idx' });
    if (idx === 404) { if (d < Date.now() - 4 * 864e5) done.add(isoDay(d)); continue; } // a holiday, or not posted yet
    if (!idx) continue; // an error: try that day again next run
    const files = [...new Set(idx.split('\n').filter((l) => /^4\s{2,}/.test(l)).map((l) => (l.match(/(edgar\/data\/\S+\.txt)/) || [])[1]).filter(Boolean))];
    console.log('form 4 filings on', isoDay(d), files.length);
    for (const f of files) {
      const url = `https://www.sec.gov/Archives/${f}`;
      if (seen.has(url)) continue;
      const txt = await get(url);
      if (!txt) continue;
      for (const b of parseForm4(txt, isoDay(d), url)) { buys.push(b); seen.add(url); }
    }
    done.add(isoDay(d));
  }
  buys = buys.filter((b) => b.value >= 10000 && b.price >= 1).sort((a, b) => b.filed.localeCompare(a.filed) || b.value - a.value);
  return { daysRead: [...done].filter((d) => d >= daysAgo(30)).sort(), buys };
}

// ---------- 13F ----------
async function figi(cusips, map) {
  const todo = cusips.filter((c) => !(c in map));
  for (let k = 0; k < todo.length; k += 10) {
    const chunk = todo.slice(k, k + 10);
    let res = null;
    for (let t = 0; t < 3 && !res; t++) {
      try {
        const r = await fetch('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk.map((c) => ({ idType: 'ID_CUSIP', idValue: c, exchCode: 'US' }))) });
        if (r.status === 429) { await sleep(30000); continue; }
        res = await r.json();
      } catch { await sleep(5000); }
    }
    (res || []).forEach((x, i) => { const d = x.data?.find((y) => y.marketSector === 'Equity') || x.data?.[0]; map[chunk[i]] = d?.ticker ? d.ticker.replace('/', '-') : null; });
    await sleep(2500);
  }
}

async function infoTable(cik, acc) {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}`;
  const idx = await get(`${base}/index.json`, { as: 'json' });
  for (const n of (idx?.directory?.item || []).map((x) => x.name).filter((n) => /\.xml$/i.test(n) && !/primary_doc/i.test(n))) {
    const txt = await get(`${base}/${n}`);
    if (!txt || !/infoTable/i.test(txt)) continue;
    const rows = new Map();
    for (const m of txt.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi)) {
      if (tag(m[1], 'putCall') || /PRN/i.test(tag(m[1], 'sshPrnamtType'))) continue;
      const cu = tag(m[1], 'cusip').toUpperCase();
      const r = rows.get(cu) || { cusip: cu, name: tag(m[1], 'nameOfIssuer'), value: 0, shares: 0 };
      r.value += +tag(m[1], 'value') || 0; r.shares += +tag(m[1], 'sshPrnamt') || 0;
      rows.set(cu, r);
    }
    return { url: `${base}/${n}`, rows: [...rows.values()] };
  }
  return null;
}

async function funds(prev) {
  if (!SEC_UA) return { funds: prev.funds || [], cusipMap: prev.cusipMap || {} };
  const cusipMap = prev.cusipMap || {};
  const out = [];
  for (const [cik, name, person] of FUNDS) {
    const sub = await get(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, { as: 'json' });
    if (!sub) { const old = prev.funds?.find((f) => f.cik === cik); if (old) out.push(old); continue; }
    const R = sub.filings.recent;
    const list = R.form.map((form, i) => ({ form, acc: R.accessionNumber[i], filed: R.filingDate[i], period: R.reportDate[i] })).filter((f) => f.form === '13F-HR');
    if (list.length < 1) continue;
    const [cur, last] = list; // newest first
    const old = prev.funds?.find((f) => f.cik === cik);
    if (old && old.accession === cur.acc) { out.push(old); continue; }
    const a = await infoTable(cik, cur.acc), b = last ? await infoTable(cik, last.acc) : null;
    if (!a) continue;
    await figi([...new Set([...a.rows, ...(b?.rows || [])].map((r) => r.cusip))], cusipMap);
    const total = a.rows.reduce((s, r) => s + r.value, 0);
    const before = new Map((b?.rows || []).map((r) => [r.cusip, r]));
    const now = new Set(a.rows.map((r) => r.cusip));
    const hold = a.rows.sort((x, y) => y.value - x.value).map((r) => {
      const p = before.get(r.cusip);
      const change = !b ? null : !p ? 'new' : r.shares > p.shares * 1.05 ? 'added' : r.shares < p.shares * 0.95 ? 'trimmed' : 'same';
      return { symbol: cusipMap[r.cusip] || null, name: r.name, weight: +(r.value / total).toFixed(4), change, sharesChange: p ? +(r.shares / p.shares - 1).toFixed(3) : null };
    });
    const sold = (b?.rows || []).filter((r) => !now.has(r.cusip)).sort((x, y) => y.value - x.value).slice(0, 10).map((r) => ({ symbol: cusipMap[r.cusip] || null, name: r.name }));
    out.push({ cik, name, person, accession: cur.acc, period: cur.period, filed: cur.filed, url: a.url, positions: a.rows.length, top: hold.slice(0, 15), newBuys: hold.filter((h) => h.change === 'new').slice(0, 10), sold, stale: cur.filed < daysAgo(200) });
    console.log('13F', name, cur.period, a.rows.length, 'positions');
  }
  return { funds: out, cusipMap };
}

// ---------- Congress (House Clerk PTRs) ----------
// PTR row layout from the trader-pelosi skill (github.com/Jakeschincariol/trader-skill, MIT)
const TXN = /^\s*(?:(SP|JT|DC)\s+)?(.*?)\s+(S \(partial\)|P|S|E)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\S.*?)\s*$/;
function parsePtr(text) {
  const lines = text.split('\n'), rows = [];
  lines.forEach((line, i) => {
    const t = line.match(TXN);
    if (!t) return;
    let asset = t[2], amount = t[6];
    for (let j = i + 1; j < Math.min(lines.length, i + 4) && !TXN.test(lines[j]) && !/^\s*(F\s+S|D\s+:|$)/.test(lines[j]); j++) {
      const parts = lines[j].trim().split(/\s{2,}/);
      if (/-$/.test(amount) && /^\$[\d,]+$/.test(parts[parts.length - 1])) amount += ' ' + parts.pop();
      asset += ' ' + parts.join(' ');
    }
    const tk = asset.match(/\(([A-Z][A-Z.]{0,5})\)\s*\[(\w\w)\]/);
    if (!tk || !['ST', 'OP'].includes(tk[2])) return;
    rows.push({ owner: { SP: 'Spouse', JT: 'Joint', DC: 'Child' }[t[1]] || 'Self', asset: asset.replace(/\s*\(.*$/, '').trim(), symbol: tk[1].replace('.', '-'),
      kind: tk[2] === 'OP' ? 'options' : 'stock', type: t[3] === 'P' ? 'Buy' : t[3] === 'E' ? 'Exchange' : 'Sell', traded: mdy(t[4]), amount: amount.replace(/\s+/g, ' ') });
  });
  return rows;
}

async function congress(prev) {
  const read = new Set(prev.congress?.docsRead || []);
  let trades = (prev.congress?.trades || []).filter((t) => t.filed >= daysAgo(CONGRESS_DAYS));
  const y = new Date().getUTCFullYear();
  const docs = [];
  for (const yr of new Date().getUTCMonth() === 0 ? [y - 1, y] : [y]) {
    const zip = await get(`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${yr}FD.zip`, { as: 'buf', ua: WEB_UA });
    if (!zip) continue;
    const zp = path.join(os.tmpdir(), `${yr}FD.zip`);
    fs.writeFileSync(zp, zip);
    const xml = execFileSync('unzip', ['-p', zp, '*.xml'], { maxBuffer: 1 << 28 }).toString();
    for (const m of xml.matchAll(/<Member>([\s\S]*?)<\/Member>/g)) {
      const t = (k) => (m[1].match(new RegExp(`<${k}>([^<]*)<`)) || [])[1]?.trim() || '';
      const filed = mdy(t('FilingDate'));
      if (t('FilingType') !== 'P' || !filed || filed < daysAgo(CONGRESS_DAYS) || read.has(t('DocID'))) continue;
      docs.push({ yr, id: t('DocID'), member: `${t('First')} ${t('Last')}`.trim(), district: t('StateDst'), filed, paper: !/^2/.test(t('DocID')) });
    }
  }
  console.log('new House PTRs', docs.length);
  for (const d of docs) {
    const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${d.yr}/${d.id}.pdf`;
    read.add(d.id);
    if (d.paper) { trades.push({ member: d.member, district: d.district, filed: d.filed, url, paper: true }); continue; }
    const pdf = await get(url, { as: 'buf', ua: WEB_UA });
    if (!pdf) continue;
    const fp = path.join(os.tmpdir(), `${d.id}.pdf`);
    fs.writeFileSync(fp, pdf);
    let txt = '';
    try { txt = execFileSync('pdftotext', ['-layout', fp, '-'], { maxBuffer: 1 << 26, timeout: 60000 }).toString(); } catch { /* unreadable */ }
    for (const r of parsePtr(txt)) trades.push({ ...r, member: d.member, district: d.district, filed: d.filed, delay: r.traded ? Math.round((new Date(d.filed) - new Date(r.traded)) / 864e5) : null, url });
  }
  trades.sort((a, b) => b.filed.localeCompare(a.filed));
  return { docsRead: [...read].slice(-3000), trades };
}

// ---------- price context ----------
// Liquidity and trend for each ticker the tab shows, so it can mark what passed the backtest's filters
async function enrich(symbols, prev) {
  const out = {};
  await L.mapLimit([...symbols], 6, async (s) => {
    try {
      const bars = await L.fetchYahoo(s, '1y');
      if (!bars || bars.length < 60) return;
      const ind = L.indicators(bars);
      const i = bars.length - 1;
      let dv = 0; for (let k = i - 19; k <= i; k++) dv += bars[k].close * bars[k].volume;
      out[s] = { price: +bars[i].close.toFixed(2), date: bars[i].date, adv: Math.round(dv / 20), above50: ind.sma50[i] != null && bars[i].close > ind.sma50[i],
        above200: ind.sma200[i] != null && bars[i].close > ind.sma200[i], uptrend: ind.sma200[i] != null && bars[i].close > ind.sma50[i] && ind.sma50[i] > ind.sma200[i],
        closes: bars.slice(-130).map((b) => [b.date, +b.close.toFixed(2)]) };
    } catch { if (prev[s]) out[s] = prev[s]; }
  });
  return out;
}

async function main() {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }
  const ins = await insiders(prev);
  const f = await funds(prev);
  const cg = await congress(prev);
  const syms = new Set([...ins.buys.map((b) => b.symbol), ...cg.trades.filter((t) => t.symbol).map((t) => t.symbol), ...f.funds.flatMap((x) => [...x.top, ...x.newBuys].map((h) => h.symbol).filter(Boolean))]);
  const prices = await enrich(syms, prev.prices || {});
  const feed = { generatedAt: new Date().toISOString(), secMissing: !SEC_UA, insider: ins, funds: f.funds, cusipMap: f.cusipMap, congress: cg, prices };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(feed));
  console.log('insider buys', ins.buys.length, 'funds', f.funds.length, 'congress rows', cg.trades.length, 'priced', Object.keys(prices).length);
}

if (require.main === module) main();
module.exports = { parseForm4, parsePtr };
