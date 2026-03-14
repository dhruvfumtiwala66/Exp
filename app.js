const CONFIG = {
    CLIENT_ID: '303192971315-dve5s629u293ggs9lnnan376iug70dsc.apps.googleusercontent.com',
    SCOPES: 'profile email https://www.googleapis.com/auth/spreadsheets',
    REDIRECT_URI: window.location.origin + window.location.pathname
};

const state = { token: null, spreadsheetId: null };

// ── Loader ────────────────────────────────────────────────────────────────────
function showLoader(show) {
    document.getElementById('loader').style.display = show ? 'flex' : 'none';
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' toast-error' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 2800);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function init() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const tokenFromHash = params.get('access_token');
    if (tokenFromHash) {
        localStorage.setItem('google_token', tokenFromHash);
        window.history.replaceState({}, document.title, window.location.pathname);
        state.token = tokenFromHash;
        checkSetup(); return;
    }
    const stored = localStorage.getItem('google_token');
    if (stored) { 
        state.token = stored; 
        checkSetup(); 
    }
    else { document.getElementById('signin-screen').style.display = 'flex'; }
}

function handleSignIn() {
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}&response_type=token&scope=${encodeURIComponent(CONFIG.SCOPES)}&prompt=consent`;
    window.location.href = url;
}

function handleSignOut() {
    localStorage.removeItem('google_token');
    localStorage.removeItem('spreadsheetId');
    window.location.reload();
}

function checkSetup() {
    const id = localStorage.getItem('spreadsheetId');
    if (id) { state.spreadsheetId = id; bootstrapApp(); }
    else { showSetupScreen(); }
}

function showSetupScreen() {
    document.getElementById('signin-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = 'flex';
    document.getElementById('main-app').style.display = 'none';
}

// ── Sheets API ────────────────────────────────────────────────────────────────
class SheetsAPI {
    constructor(token, id) {
        this.token = token;
        this.id = id;
        this.base = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
    }
    async req(path, opts = {}) {
        const url = path.startsWith('http') ? path : this.base + path;
        const res = await fetch(url, {
            ...opts,
            headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json', ...opts.headers }
        });
        if (!res.ok) {
            if (res.status === 401) {
                handleSignOut();
                throw new Error('Session expired. Please sign in again.');
            }
            const e = await res.json().catch(() => ({ error: { message: 'Network error' } }));
            throw new Error(e.error?.message || `HTTP ${res.status}`);
        }
        return res.json();
    }
    async fetchSheet(name) {
        const d = await this.req(`/values/${encodeURIComponent(name)}`);
        return d.values || [];
    }
    async appendRow(sheet, values) {
        return this.req(`/values/${encodeURIComponent(sheet)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
            method: 'POST', body: JSON.stringify({ values: [values] })
        });
    }
    async updateRow(sheet, rowIndex, values) {
        const range = `${sheet}!A${rowIndex}`;
        return this.req(`/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
            method: 'PUT', body: JSON.stringify({ range, values: [values] })
        });
    }
    async deleteRow(sheet, rowIndex) {
        const ss = await this.req('');
        const sheetObj = ss.sheets.find(s => s.properties.title === sheet);
        if (!sheetObj) throw new Error(`Sheet "${sheet}" not found`);
        return this.req(':batchUpdate', {
            method: 'POST',
            body: JSON.stringify({
                requests: [{ deleteDimension: { range: { sheetId: sheetObj.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }]
            })
        });
    }
}

// ── DataStore ─────────────────────────────────────────────────────────────────
const DS = {
    ed: [], id: [], med: [], api: null,
    headers: { ED: [], ID: [], MED: [] },
    async init(token, spreadsheetId) {
        this.api = new SheetsAPI(token, spreadsheetId);
        await this.refresh();
    },
    async refresh() {
        showLoader(true);
        try {
            const [edRes, idRes, medRes] = await Promise.all([
                this.api.req(`/values/ED`),
                this.api.req(`/values/ID`),
                this.api.req(`/values/MED`)
            ]);
            
            this.headers.ED = (edRes.values && edRes.values[0]) || [];
            this.headers.ID = (idRes.values && idRes.values[0]) || [];
            this.headers.MED = (medRes.values && medRes.values[0]) || [];

            this.ed = this.parse(edRes.values || [], 'ED');
            this.id = this.parse(idRes.values || [], 'ID');
            this.med = this.parse(medRes.values || [], 'MED');
        } catch (err) { showToast(err.message, true); throw err; }
        finally { showLoader(false); }
    },
    parse(rows, sheetName) {
        if (rows.length < 1) return [];
        const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
        return rows.slice(1).map((row, i) => {
            const obj = { _row: i + 2 };
            headers.forEach((h, j) => { 
                if (h) obj[h] = (row[j] || '').trim(); 
            });
            return obj;
        });
    },
    mapFieldsToRow(sheetName, data) {
        const sheetHeaders = this.headers[sheetName];
        if (!sheetHeaders.length) throw new Error(`Headers for ${sheetName} not found.`);
        
        // Map common app keys to potential header variations
        const keyMap = {
            'cat': 'category',
            'desc': 'description',
            'name': 'name',
            'amt': 'amount',
            'qty': 'weight',
            'weight': 'weight',
            'pay': 'payment_type',
            'bw': 'repeat_bi_weekly',
            'biweekly': 'repeat_bi_weekly',
            'mo': 'repeat_monthly',
            'monthly': 'repeat_monthly',
            'comp': 'company',
            'phone': 'phone_bill'
        };

        return sheetHeaders.map(h => {
            const cleanH = h.trim().toLowerCase().replace(/\s+/g, '_');
            // Try to find value by clean header name or mapped key
            if (data[cleanH] !== undefined) return data[cleanH];
            
            // Check mapping
            for (const [appKey, sheetKey] of Object.entries(keyMap)) {
                if (cleanH === sheetKey && data[appKey] !== undefined) return data[appKey];
                if (cleanH === appKey && data[appKey] !== undefined) return data[appKey];
            }
            return ''; // Default empty if no match
        });
    }
};

// ── Sheet Validation ──────────────────────────────────────────────────────────
async function validateSheet() {
    let raw = document.getElementById('sheet-id-input').value.trim();
    const errEl = document.getElementById('setup-error');
    errEl.textContent = '';
    const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const id = m ? m[1] : raw.replace(/\/+$/, '');
    if (!id) { errEl.textContent = 'Please enter a Spreadsheet ID or URL'; return; }
    showLoader(true);
    try {
        const api = new SheetsAPI(state.token, id);
        await api.fetchSheet('ED');
        localStorage.setItem('spreadsheetId', id);
        state.spreadsheetId = id;
        document.getElementById('setup-screen').style.display = 'none';
        bootstrapApp();
    } catch (err) { errEl.textContent = 'Could not access sheet. Check ID & permissions.'; }
    finally { showLoader(false); }
}

async function bootstrapApp() {
    try {
        await DS.init(state.token, state.spreadsheetId);
        document.getElementById('main-app').style.display = 'flex';
        switchTab('expenses');
    } catch (err) {
        showToast('Failed to load data. Try again.', true);
        showSetupScreen();
    }
}

// ── Tab Navigation ────────────────────────────────────────────────────────────
let currentTab = 'expenses';
const CURRENCY = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

const filters = {
    category: 'All',
    dateRange: 'AllTime' // AllTime, ThisMonth, LastMonth, 30Days
};

function setFilter(type, val) {
    filters[type] = val;
    renderTabContent();
}

function getFilteredData(items) {
    return items.filter(item => {
        // Category Filter
        if (filters.category !== 'All' && item.category !== filters.category) return false;
        
        // Date Filter
        if (filters.dateRange === 'AllTime') return true;
        if (!item.date) return false;
        
        const itemDate = new Date(item.date + 'T00:00:00');
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        if (filters.dateRange === 'ThisMonth') {
            return itemDate.getMonth() === now.getMonth() && itemDate.getFullYear() === now.getFullYear();
        }
        if (filters.dateRange === 'LastMonth') {
            const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            return itemDate.getMonth() === lastMonth.getMonth() && itemDate.getFullYear() === lastMonth.getFullYear();
        }
        if (filters.dateRange === '30Days') {
            const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
            return itemDate >= thirtyDaysAgo;
        }
        return true;
    });
}

function renderFilterBar(items, sheet) {
    const cats = ['All', ...new Set(items.map(i => i.category).filter(Boolean))].sort();
    const dateRanges = [
        {id:'AllTime', label:'All Time'},
        {id:'ThisMonth', label:'This Month'},
        {id:'LastMonth', label:'Last Month'},
        {id:'30Days', label:'Last 30 Days'}
    ];

    return `
        <div class="filter-bar">
            ${dateRanges.map(dr => `<div class="filter-chip ${filters.dateRange===dr.id?'active':''}" onclick="setFilter('dateRange', '${dr.id}')">${dr.label}</div>`).join('')}
        </div>
        ${sheet !== 'ID' ? `
        <div class="filter-bar">
            ${cats.map(c => `<div class="filter-chip ${filters.category===c?'active':''}" onclick="setFilter('category', '${c}')">${c}</div>`).join('')}
        </div>` : ''}
    `;
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    // Show/hide FAB — hide on analytics
    document.getElementById('fab').style.display = tab === 'analytics' ? 'none' : 'flex';
    renderTabContent();
}

function renderTabContent() {
    const c = document.getElementById('tab-content');
    c.scrollTop = 0;
    if (currentTab === 'expenses') renderExpenses(c);
    else if (currentTab === 'mandatory') renderMandatory(c);
    else if (currentTab === 'income') renderIncome(c);
    else if (currentTab === 'analytics') renderAnalytics(c);
}

// ── Render Helpers ────────────────────────────────────────────────────────────
const CAT_ICONS = {
    'Anti Virus':'🛡️',
    'Games':'🎮','Movies':'🎬','Others':'🎭',
    'Coffee':'☕','Dining Out':'🍽️','Groceries':'🛒','Packaged Food':'🍱',
    'Electronics':'💻','Furniture':'🛋️','Household Machines':'🧺','Household Supplies':'🧻','Insurance':'🛡️','Maintenance':'🔧','Mortgage':'🏦','Rent':'🏠','Taxes':'📄',
    'Bank Account Fees':'💸','Business':'💼','Charity':'❤️','Clothing':'👕','Credit Card Fees':'💳','Donation':'🎁','Education':'🎓','Footwear':'👟','Gifts':'🎁','Grooming':'🪮','India':'🇮🇳','Investments':'📈','Makeup & Skincare':'💄','Medical Expenses':'🏥','Membership':'💳','Other':'📦','Parcels':'📦','Shein':'🛍️','Souvenir':'🧸',
    'Liquor':'🍺',
    'Bus':'🚌','Car':'🚗','Flight':'✈️','Gas':'⛽','Hotel':'🏨','Other':'🚗','Parking':'🅿️','Taxi':'🚕','Train':'🚆',
    'Electricity':'⚡','Heat':'🔥','Internet (Wi-Fi)':'📶','Phone':'📱','TV':'📺','Water':'💧'
};

function catIcon(cat) { return CAT_ICONS[cat] || '💰'; }

function formatDate(d) {
    if (!d) return '';
    try {
        let dateObj = new Date(d);
        if (isNaN(dateObj.getTime())) {
            const parts = d.split(/[ \-/]/);
            if (parts.length === 3) {
                if (parts[2].length === 4) dateObj = new Date(parts[2], parts[1] - 1, parts[0]);
                else if (parts[0].length === 4) dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
            }
        }
        if (isNaN(dateObj.getTime())) return d;
        return dateObj.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    catch { return d; }
}

function parseToTime(d) {
    if (!d) return 0;
    let dateObj = new Date(d);
    if (isNaN(dateObj.getTime())) {
        const parts = d.split(/[ \-/]/);
        if (parts.length === 3) {
            if (parts[2].length === 4) dateObj = new Date(parts[2], parts[1] - 1, parts[0]);
            else if (parts[0].length === 4) dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
        }
    }
    return isNaN(dateObj.getTime()) ? 0 : dateObj.getTime();
}

function renderSummaryCard(gradient, topLabel, topValue, left, right) {
    return `<div class="summary-card" style="background: ${gradient};">
        <div class="sc-label">${topLabel}</div>
        <div class="sc-amount">${topValue}</div>
        <div class="sc-grid">
            <div><div class="sc-sub-label">${left.label}</div><div class="sc-sub-val">${left.value}</div></div>
            <div><div class="sc-sub-label">${right.label}</div><div class="sc-sub-val">${right.value}</div></div>
        </div>
    </div>`;
}

function renderItemList(items, sheet) {
    const filtered = getFilteredData(items);
    if (!filtered.length) return `<div class="empty-state"><div class="empty-icon">📭</div><div>No entries match your filters</div><div class="empty-sub">Try changing your filter settings</div></div>`;
    
    // Improved sorting: Newest to Oldest using robust parser
    const sorted = [...filtered].sort((a, b) => parseToTime(b.date) - parseToTime(a.date));
    
    const grouped = {};
    sorted.forEach(item => {
        const key = item.date || 'No Date';
        if (!grouped[key]) grouped[key] = { items: [], total: 0 };
        grouped[key].items.push(item);
        grouped[key].total += (parseFloat(item.amount) || 0);
    });
    let html = '';
    for (const date in grouped) {
        html += `<div class="date-section">
            <div class="date-label">
                <span>${formatDate(date)}</span>
                <span style="opacity: 0.8;">${CURRENCY.format(grouped[date].total)}</span>
            </div>
            <div class="list-card">`;
        grouped[date].items.forEach((item, idx) => {
            const name = item.description || item.name || item.company || 'Unnamed';
            const sub = getSubtext(item, sheet);
            const icon = sheet === 'ID' ? '💼' : (sheet === 'MED' ? '📅' : catIcon(item.category));
            const amtCls = sheet === 'ID' ? 'amt-income' : (sheet === 'MED' ? 'amt-mandatory' : 'amt-expense');
            const prefix = sheet === 'ID' ? '+' : '-';
            const isLast = idx === grouped[date].items.length - 1;
            html += `<div class="list-item${isLast ? ' last' : ''}" onclick="editEntry('${sheet}', ${item._row})">
                <div class="item-icon">${icon}</div>
                <div class="item-body">
                    <div class="item-name">${name}</div>
                    ${sub ? `<div class="item-sub">${sub}</div>` : ''}
                </div>
                <div class="item-right">
                    <div class="${amtCls}">${prefix}${CURRENCY.format(parseFloat(item.amount)||0)}</div>
                    <div class="item-chevron">›</div>
                </div>
            </div>`;
        });
        html += `</div></div>`;
    }
    return html;
}

function getSubtext(item, sheet) {
    if (sheet === 'ID') {
        const parts = [];
        if (item.company) parts.push(item.company);
        if (item.repeat_bi_weekly === 'TRUE') parts.push('Bi-weekly');
        return parts.join(' · ');
    }
    const parts = [];
    if (item.quantity && item.unit) parts.push(`${item.quantity} ${item.unit}`);
    else if (item.unit) parts.push(item.unit);
    
    if (item.category) parts.push(item.category);
    if (item.payment_type) parts.push(item.payment_type);

    if (sheet === 'MED') {
        if (item.repeat_bi_weekly === 'TRUE') parts.push('Bi-weekly');
        else if (item.repeat_monthly === 'TRUE') parts.push('Monthly');
    }
    return parts.join(' · ');
}

// ── Expenses Tab ──────────────────────────────────────────────────────────────
function renderExpenses(c) {
    const items = DS.ed;
    const now = new Date();
    const thisMonth = items.filter(r => r.date && r.date.startsWith(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`));
    const monthTotal = thisMonth.reduce((s, r) => s + (parseFloat(r.amount)||0), 0);
    c.innerHTML = `
        <div class="page-header"><h1 class="page-title">Expenses</h1>
            <button class="refresh-btn" onclick="syncData()" title="Sync">↻</button>
        </div>
        ${renderSummaryCard('linear-gradient(135deg, #667eea 0%, #764ba2 100%)', 'THIS MONTH', CURRENCY.format(monthTotal),
            {label:'TOTAL ENTRIES', value: items.length},
            {label:'DAILY AVG', value: CURRENCY.format(monthTotal / (new Date(now.getFullYear(), now.getMonth()+1, 0).getDate()))}
        )}
        ${renderFilterBar(items, 'ED')}
        ${renderItemList(items, 'ED')}`;
}

// ── Mandatory Tab ─────────────────────────────────────────────────────────────
function renderMandatory(c) {
    const items = DS.med;
    const bw = items.filter(i => i.repeat_bi_weekly === 'TRUE').reduce((a, b) => a + (parseFloat(b.amount)||0), 0) * 2;
    const mo = items.filter(i => i.repeat_monthly === 'TRUE').reduce((a, b) => a + (parseFloat(b.amount)||0), 0);
    const total = bw + mo;
    c.innerHTML = `
        <div class="page-header"><h1 class="page-title">Mandatory</h1>
            <button class="refresh-btn" onclick="syncData()" title="Sync">↻</button>
        </div>
        ${renderSummaryCard('linear-gradient(135deg, #f093fb 0%, #8B5CF6 100%)', 'MONTHLY OBLIGATIONS', CURRENCY.format(total),
            {label:'BI-WEEKLY ×2', value: CURRENCY.format(bw)},
            {label:'MONTHLY', value: CURRENCY.format(mo)}
        )}
        ${renderFilterBar(items, 'MED')}
        ${renderItemList(items, 'MED')}`;
}

// ── Income Tab ────────────────────────────────────────────────────────────────
function renderIncome(c) {
    const items = DS.id;
    const incomeTotal = items.reduce((a, b) => a + (parseFloat(b.amount)||0), 0);
    const expTotal = DS.ed.reduce((a, b) => a + (parseFloat(b.amount)||0), 0);
    const mandBW = DS.med.filter(i => i.repeat_bi_weekly === 'TRUE').reduce((a, b) => a + (parseFloat(b.amount)||0), 0) * 2;
    const mandMO = DS.med.filter(i => i.repeat_monthly === 'TRUE').reduce((a, b) => a + (parseFloat(b.amount)||0), 0);
    const net = incomeTotal - expTotal - mandBW - mandMO;
    c.innerHTML = `
        <div class="page-header"><h1 class="page-title">Income</h1>
            <button class="refresh-btn" onclick="syncData()" title="Sync">↻</button>
        </div>
        ${renderSummaryCard('linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)', 'NET REMAINING', CURRENCY.format(net),
            {label:'TOTAL INCOME', value: CURRENCY.format(incomeTotal)},
            {label:'SOURCES', value: items.length}
        )}
        ${renderItemList(items, 'ID')}`;
}

// ── Analytics Tab ─────────────────────────────────────────────────────────────
let analyticView = 'Category';

function renderAnalytics(c) {
    const views = ['Category', 'Payment', 'Monthly', 'Cash Flow'];
    c.innerHTML = `
        <div class="page-header"><h1 class="page-title">Analytics</h1>
            <button class="refresh-btn" onclick="syncData()" title="Sync">↻</button>
        </div>
        <div class="seg-control">
            ${views.map(v => `<div class="seg${analyticView===v?' seg-active':''}" onclick="switchAnalytics('${v}')">${v}</div>`).join('')}
        </div>
        <div id="analytics-body"></div>`;
    renderAnalyticsBody();
}

function switchAnalytics(v) {
    analyticView = v;
    document.querySelectorAll('.seg').forEach(s => s.classList.toggle('seg-active', s.textContent === v));
    renderAnalyticsBody();
}

function renderAnalyticsBody() {
    const body = document.getElementById('analytics-body');
    if (!body) return;
    const expenses = DS.ed;
    const incomeTotal = DS.id.reduce((a, b) => a + (parseFloat(b.amount)||0), 0);
    const mandBW = DS.med.filter(i => i.repeat_bi_weekly==='TRUE').reduce((a,b)=>a+(parseFloat(b.amount)||0),0)*2;
    const mandMO = DS.med.filter(i=>i.repeat_monthly==='TRUE').reduce((a,b)=>a+(parseFloat(b.amount)||0),0);
    const mandTotal = mandBW + mandMO;
    const expTotal = expenses.reduce((a, b) => a + (parseFloat(b.amount)||0), 0);

    // Visual Analysis Cards (Top Metrics)
    const sortedByAmt = [...expenses].sort((a,b) => (parseFloat(b.amount)||0) - (parseFloat(a.amount)||0));
    const maxExpense = sortedByAmt[0];
    const avgTrans = expTotal / (expenses.length || 1);

    const cardUsage = {};
    expenses.forEach(r => { if(r.payment_type) cardUsage[r.payment_type] = (cardUsage[r.payment_type]||0) + (parseFloat(r.amount)||0); });
    const topCard = Object.entries(cardUsage).sort((a,b)=>b[1]-a[1])[0];

    const statsHtml = `
        <div class="an-grid">
            <div class="an-stat-card"><div class="an-stat-label">BIGGEST SPEND</div><div class="an-stat-val">${maxExpense ? CURRENCY.format(maxExpense.amount) : '$0'}</div><div class="an-stat-sub">${maxExpense?.description || 'None'}</div></div>
            <div class="an-stat-card"><div class="an-stat-label">TOP CARD</div><div class="an-stat-val" style="font-size:14px; line-height:1.2;">${topCard ? topCard[0] : 'None'}</div><div class="an-stat-sub">${topCard ? CURRENCY.format(topCard[1]) : ''}</div></div>
            <div class="an-stat-card"><div class="an-stat-label">AVG TRANS</div><div class="an-stat-val">${CURRENCY.format(avgTrans)}</div><div class="an-stat-sub">${expenses.length} Trans</div></div>
            <div class="an-stat-card"><div class="an-stat-label">TOTAL SPENT</div><div class="an-stat-val">${CURRENCY.format(expTotal)}</div><div class="an-stat-sub">Across all time</div></div>
        </div>
    `;

    if (analyticView === 'Cash Flow') {
        const net = incomeTotal - expTotal - mandTotal;
        const savRate = incomeTotal > 0 ? (net / incomeTotal) * 100 : 0;
        const hColor = savRate > 20 ? '#10B981' : (savRate > 0 ? '#F59E0B' : '#EF4444');
        const maxBar = Math.max(incomeTotal, expTotal, mandTotal, 1);
        body.innerHTML = statsHtml + `
            <div class="an-card">
                ${barRow('Income', incomeTotal, maxBar, '#10B981')}
                ${barRow('Expenses', expTotal, maxBar, '#EF4444')}
                ${barRow('Mandatory', mandTotal, maxBar, '#8B5CF6')}
            </div>
            <div class="an-card">
                <div class="an-card-title">Budget Health — ${Math.round(savRate)}% Saved</div>
                <div class="health-bar-bg"><div class="health-bar-fill" style="width:${Math.max(0,Math.min(100,savRate+50))}%;background:${hColor};"></div></div>
                <p class="an-hint">Savings rate relative to 0% baseline.</p>
            </div>`;
        return;
    }

    const groupFn = analyticView === 'Category' ? r => r.category || 'Other'
        : analyticView === 'Payment' ? r => r.payment_type || 'Other'
        : r => (r.date || '').substring(0, 7) || 'Unknown';

    const map = {};
    expenses.forEach(r => { const k = groupFn(r); map[k] = (map[k]||0) + (parseFloat(r.amount)||0); });
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]);
    const maxVal = sorted.length ? sorted[0][1] : 1;

    const COLORS = ['#667eea','#764ba2','#f093fb','#f5576c','#4facfe','#43e97b','#fa709a','#fee140'];
    let html = statsHtml + `<div class="an-card">${sorted.map(([label, val], i) => barRow(label||'Other', val, maxVal, COLORS[i % COLORS.length])).join('')}</div>`;
    body.innerHTML = html;
}

function barRow(label, val, max, color) {
    const pct = Math.round((val / max) * 100);
    return `<div class="bar-row">
        <div class="bar-meta"><span class="bar-label">${label}</span><span class="bar-amount">${CURRENCY.format(val)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>
    </div>`;
}

// ── Sync ──────────────────────────────────────────────────────────────────────
async function syncData() {
    try { await DS.refresh(); renderTabContent(); showToast('✓ Synced with Google Sheets'); }
    catch (err) { showToast(err.message, true); }
}

// ── Bottom Sheet ──────────────────────────────────────────────────────────────
let activeSheet = 'ED';
let activeEntry = null;

function openSheet() {
    document.getElementById('sheet-overlay').classList.add('show');
    requestAnimationFrame(() => document.getElementById('bottom-sheet').classList.add('show'));
}

function closeSheet() {
    document.getElementById('bottom-sheet').classList.remove('show');
    document.getElementById('sheet-overlay').classList.remove('show');
}

function showAddSheet() {
    activeSheet = currentTab === 'expenses' ? 'ED' : currentTab === 'mandatory' ? 'MED' : 'ID';
    activeEntry = null;
    const labels = { ED: 'Expense', MED: 'Mandatory', ID: 'Income' };
    document.getElementById('sheet-title').textContent = `New ${labels[activeSheet]}`;
    document.getElementById('delete-btn').style.display = 'none';
    buildForm();
    resetForm();
    openSheet();
}

function editEntry(sheet, rowIndex) {
    activeSheet = sheet;
    const store = sheet === 'ED' ? DS.ed : sheet === 'MED' ? DS.med : DS.id;
    const entry = store.find(r => r._row === rowIndex);
    if (!entry) { showToast('Entry not found', true); return; }
    activeEntry = entry;
    const labels = { ED: 'Expense', MED: 'Mandatory', ID: 'Income' };
    document.getElementById('sheet-title').textContent = `Edit ${labels[sheet]}`;
    document.getElementById('delete-btn').style.display = 'block';
    buildForm();
    // Populate fields
    document.getElementById('f-amount').value = entry.amount || entry.amt || '';
    document.getElementById('f-date').value = entry.date || '';
    document.getElementById('f-desc').value = entry.description || entry.name || entry.desc || '';
    if (sheet === 'ED' || sheet === 'MED') {
        const cat = entry.category || entry.cat || '';
        document.getElementById('f-cat').value = cat;
        document.getElementById('f-cat-display').textContent = (cat ? `${catIcon(cat)} ${cat}` : 'Select Category');
        if (document.getElementById('f-qty')) document.getElementById('f-qty').value = entry.weight || entry.quantity || entry.qty || '';
        if (document.getElementById('f-unit')) document.getElementById('f-unit').value = entry.unit || '';
        if (document.getElementById('f-payment'))
            document.getElementById('f-payment').value = entry.payment_type || entry.pay || '';
    }
    if (sheet === 'MED') {
        document.getElementById('f-biweekly').checked = (entry.repeat_bi_weekly || entry.bw) === 'TRUE';
        document.getElementById('f-monthly').checked = (entry.repeat_monthly || entry.mo) === 'TRUE';
    }
    if (sheet === 'ID') {
        if (document.getElementById('f-company'))
            document.getElementById('f-company').value = entry.company || entry.comp || '';
        if (document.getElementById('f-phone'))
            document.getElementById('f-phone').value = entry.phone_bill || entry.phone || '';
        if (document.getElementById('f-biweekly'))
            document.getElementById('f-biweekly').checked = (entry.repeat_bi_weekly || entry.bw) === 'TRUE';
    }
    openSheet();
}

function buildForm() {
    const body = document.getElementById('form-body');
    const s = activeSheet;
    const amtColor = s === 'ID' ? '#10B981' : s === 'MED' ? '#8B5CF6' : '#EF4444';
    let html = `
        <div class="form-group amount-group">
            <input type="number" id="f-amount" class="amount-input" placeholder="0.00" step="0.01" style="color:${amtColor};">
        </div>
        <div class="form-group">
            <label>DATE</label>
            <input type="date" id="f-date">
        </div>
        <div class="form-group">
            <label>${s === 'ID' ? 'NAME / SOURCE' : 'DESCRIPTION'}</label>
            <input type="text" id="f-desc" placeholder="${s === 'ID' ? 'Salary, Freelance...' : 'What was it for?'}">
        </div>`;

    if (s === 'ED' || s === 'MED') {
        html += `
        <div class="form-group tappable" onclick="showCategoryPicker()">
            <label>CATEGORY</label>
            <div id="f-cat-display" class="form-value">Select Category</div>
            <input type="hidden" id="f-cat">
        </div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div class="form-group">
                <label>${s === 'ED' ? 'WEIGHT' : 'QUANTITY'}</label>
                <input type="number" id="f-qty" placeholder="1.0" step="0.01">
            </div>
            <div class="form-group">
                <label>UNIT</label>
                <select id="f-unit">
                    <option value="">None</option>
                    <option value="G">G - Grams</option>
                    <option value="KG">KG - Kilograms</option>
                    <option value="L">L - Liters</option>
                    <option value="ML">ML - Milliliters</option>
                    <option value="P">P - Pieces</option>
                    <option value="Pe">Pe - Persons</option>
                </select>
            </div>
        </div>
        <div class="form-group">
            <label>PAYMENT TYPE</label>
            <select id="f-payment">
                <option value="">Select Payment Type</option>
                <option value="Account Debit">Account Debit</option>
                <option value="American Express SimplyCash">American Express SimplyCash</option>
                <option value="American Express SimplyCash - Cashback">American Express SimplyCash - Cashback</option>
                <option value="Cash">Cash</option>
                <option value="Costco Mastercard">Costco Mastercard</option>
                <option value="Costco Mastercard - Cashback">Costco Mastercard - Cashback</option>
                <option value="Home Trust Preferred Visa">Home Trust Preferred Visa</option>
                <option value="Rogers Mastercard">Rogers Mastercard</option>
                <option value="Scotiabank Visa Card - Dhruv">Scotiabank Visa Card - Dhruv</option>
                <option value="Scotiabank Visa Card - Mansi">Scotiabank Visa Card - Mansi</option>
            </select>
        </div>`;
    }

    if (s === 'MED') {
        html += `
        <div class="form-group toggle-row">
            <label>REPEAT BI-WEEKLY</label>
            <label class="toggle"><input type="checkbox" id="f-biweekly" onchange="toggleRepeat('biweekly')"><span class="toggle-track"></span></label>
        </div>
        <div class="form-group toggle-row">
            <label>REPEAT MONTHLY</label>
            <label class="toggle"><input type="checkbox" id="f-monthly" onchange="toggleRepeat('monthly')"><span class="toggle-track"></span></label>
        </div>`;
    }

    if (s === 'ID') {
        html += `
        <div class="form-group">
            <label>COMPANY / EMPLOYER</label>
            <input type="text" id="f-company" placeholder="Company name">
        </div>
        <div class="form-group">
            <label>PHONE BILL (optional)</label>
            <input type="number" id="f-phone" placeholder="0.00" step="0.01">
        </div>
        <div class="form-group toggle-row">
            <label>REPEAT BI-WEEKLY</label>
            <label class="toggle"><input type="checkbox" id="f-biweekly"><span class="toggle-track"></span></label>
        </div>`;
    }

    body.innerHTML = html;
}

function resetForm() {
    if (document.getElementById('f-amount')) document.getElementById('f-amount').value = '';
    if (document.getElementById('f-date')) document.getElementById('f-date').value = new Date().toISOString().split('T')[0];
    if (document.getElementById('f-desc')) document.getElementById('f-desc').value = '';
    if (document.getElementById('f-cat')) document.getElementById('f-cat').value = '';
    if (document.getElementById('f-cat-display')) document.getElementById('f-cat-display').textContent = 'Select Category';
    if (document.getElementById('f-qty')) document.getElementById('f-qty').value = '';
    if (document.getElementById('f-unit')) document.getElementById('f-unit').value = '';
    if (document.getElementById('f-payment')) document.getElementById('f-payment').value = '';
}

function toggleRepeat(type) {
    if (type === 'biweekly' && document.getElementById('f-monthly')) document.getElementById('f-monthly').checked = false;
    if (type === 'monthly' && document.getElementById('f-biweekly')) document.getElementById('f-biweekly').checked = false;
}

async function saveEntry() {
    const amount = document.getElementById('f-amount').value;
    const date = document.getElementById('f-date').value;
    const desc = document.getElementById('f-desc').value;
    if (!amount || !date || !desc) { showToast('Fill in required fields', true); return; }

    const payload = {
        amount, date, description: desc, desc, date, amount // support both variations
    };

    if (activeSheet === 'ED') {
        payload.category = document.getElementById('f-cat').value;
        payload.cat = payload.category;
        payload.payment_type = document.getElementById('f-payment').value;
        payload.pay = payload.payment_type;
        payload.quantity = document.getElementById('f-qty').value;
        payload.qty = payload.quantity;
        payload.unit = document.getElementById('f-unit').value;
    } else if (activeSheet === 'MED') {
        payload.category = document.getElementById('f-cat').value;
        payload.cat = payload.category;
        payload.payment_type = document.getElementById('f-payment').value;
        payload.pay = payload.payment_type;
        payload.quantity = document.getElementById('f-qty').value;
        payload.qty = payload.quantity;
        payload.unit = document.getElementById('f-unit').value;
        payload.repeat_bi_weekly = document.getElementById('f-biweekly').checked ? 'TRUE' : 'FALSE';
        payload.bw = payload.repeat_bi_weekly;
        payload.repeat_monthly = document.getElementById('f-monthly').checked ? 'TRUE' : 'FALSE';
        payload.mo = payload.repeat_monthly;
    } else if (activeSheet === 'ID') {
        payload.company = (document.getElementById('f-company')?.value) || '';
        payload.comp = payload.company;
        payload.phone_bill = (document.getElementById('f-phone')?.value) || '';
        payload.phone = payload.phone_bill;
        payload.repeat_bi_weekly = document.getElementById('f-biweekly')?.checked ? 'TRUE' : 'FALSE';
        payload.bw = payload.repeat_bi_weekly;
    }

    const values = DS.mapFieldsToRow(activeSheet, payload);

    showLoader(true);
    try {
        if (activeEntry) {
            await DS.api.updateRow(activeSheet, activeEntry._row, values);
            showToast('✓ Updated in Google Sheets');
        } else {
            await DS.api.appendRow(activeSheet, values);
            showToast('✓ Saved to Google Sheets');
        }
        await DS.refresh();
        closeSheet();
        renderTabContent();
    } catch (err) { showToast(err.message, true); }
    finally { showLoader(false); }
}

async function deleteEntry() {
    if (!activeEntry) return;
    if (!confirm(`Delete this entry? This cannot be undone.`)) return;
    showLoader(true);
    try {
        await DS.api.deleteRow(activeSheet, activeEntry._row);
        showToast('✓ Deleted from Google Sheets');
        await DS.refresh();
        closeSheet();
        renderTabContent();
    } catch (err) { showToast(err.message, true); }
    finally { showLoader(false); }
}

// ── Category Picker ───────────────────────────────────────────────────────────
const CATEGORIES = {
    "Electronics": ["Anti Virus"],
    "Entertainment": ["Games", "Movies", "Others"],
    "Food": ["Coffee", "Dining Out", "Groceries", "Packaged Food"],
    "Home": ["Electronics", "Furniture", "Household Machines", "Household Supplies", "Insurance", "Maintenance", "Mortgage", "Rent", "Taxes"],
    "Life": ["Bank Account Fees", "Business", "Charity", "Clothing", "Credit Card Fees", "Donation", "Education", "Footwear", "Gifts", "Grooming", "India", "Insurance", "Investments", "Makeup & Skincare", "Medical Expenses", "Membership", "Other", "Parcels", "Shein", "Souvenir"],
    "Liquor": ["Liquor"],
    "Transportation": ["Bus", "Car", "Flight", "Gas", "Hotel", "Other", "Parking", "Taxi", "Train"],
    "Utilities": ["Electricity", "Heat", "Internet (Wi-Fi)", "Phone", "TV", "Water"]
};

function showCategoryPicker() {
    const p = document.getElementById('cat-picker');
    p.style.display = 'flex';
    requestAnimationFrame(() => p.classList.add('show'));
    document.getElementById('cat-search').value = '';
    renderCategories('');
}

function closeCategoryPicker() {
    const p = document.getElementById('cat-picker');
    p.classList.remove('show');
    setTimeout(() => { p.style.display = 'none'; }, 350);
}

function renderCategories(q) {
    const body = document.getElementById('picker-body');
    q = q.toLowerCase();
    let html = '';
    for (const group in CATEGORIES) {
        const filtered = CATEGORIES[group].filter(c => c.toLowerCase().includes(q) || group.toLowerCase().includes(q));
        if (filtered.length) {
            html += `<div class="cat-group">${group}</div>`;
            filtered.forEach(cat => {
                html += `<div class="cat-item" onclick="selectCategory('${cat}')">${catIcon(cat)} ${cat}</div>`;
            });
        }
    }
    if (q && !html) {
        html = `<div class="cat-empty">No match.<br><button class="add-cat-btn" onclick="selectCategory('${q}')">Add "${q}"</button></div>`;
    }
    body.innerHTML = html;
}

function selectCategory(cat) {
    document.getElementById('f-cat').value = cat;
    document.getElementById('f-cat-display').textContent = `${catIcon(cat)} ${cat}`;
    closeCategoryPicker();
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('cat-search').addEventListener('input', e => renderCategories(e.target.value));
    init();
});
