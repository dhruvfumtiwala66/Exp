const CONFIG = {
    CLIENT_ID: '303192971315-dve5s629u293ggs9lnnan376iug70dsc.apps.googleusercontent.com',
    SCOPES: 'profile email https://www.googleapis.com/auth/spreadsheets',
    REDIRECT_URI: window.location.origin + window.location.pathname
};

const DEFAULT_SHEET_ID = "1Zq5vZZGtHN--a8qa8bfREJxSMjtD4UDgfmX1vYpj-Y8";
const state = { token: null, spreadsheetId: DEFAULT_SHEET_ID };

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
async function init() {
    const savedToken = localStorage.getItem('spendly_token');
    if (savedToken) {
        state.token = savedToken;
        state.spreadsheetId = DEFAULT_SHEET_ID;
        localStorage.setItem('spendly_sheet_id', state.spreadsheetId);
        
        showLoader(true);
        try {
            await bootstrapApp(); 
            document.getElementById('signin-screen').style.display = 'none';
            document.getElementById('main-app').style.display = 'flex';
            switchTab('expenses'); 
        } catch (e) {
            localStorage.removeItem('spendly_token');
            document.getElementById('signin-screen').style.display = 'flex';
        } finally {
            showLoader(false);
        }
    } else {
        document.getElementById('signin-screen').style.display = 'flex';
    }
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

// After successful token
async function handleAfterToken() {
    showLoader(true);
    localStorage.setItem('spendly_token', state.token);
    
    // Automatically use the default ID
    state.spreadsheetId = DEFAULT_SHEET_ID;
    localStorage.setItem('spendly_sheet_id', state.spreadsheetId);
    
    try {
        await bootstrapApp();
        document.getElementById('signin-screen').style.display = 'none';
        document.getElementById('main-app').style.display = 'flex';
        switchTab('expenses'); // Land on home page
    } catch (err) {
        console.error(err);
        showToast('Error initializing data. Please retry.');
        document.getElementById('signin-screen').style.display = 'flex';
    } finally {
        showLoader(false);
    }
}

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
        renderSidebar();
        switchTab('expenses');
    } catch (err) {
        showToast('Failed to load data. Try again.', true);
        showSetupScreen();
    }
}

// ── Tab Navigation ────────────────────────────────────────────────────────────
let currentTab = 'expenses';
let analyticsSubTab = 'expenses-cat'; // Default analytics view
const CURRENCY = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

const filters = {
    categories: ['All'],
    startDate: '',
    endDate: '',
    search: '',
    show: false,
    activeSub: 'date' // 'date' or 'cat'
};

function toggleFilterBar() {
    filters.show = !filters.show;
    document.getElementById('filter-container').classList.toggle('show', filters.show);
    // document.querySelector('.filter-toggle-icon').textContent = filters.show ? '✕' : '🔍'; // Optional
    if (filters.show) {
        document.getElementById('global-search').focus();
        renderFilterBarControls();
    }
}

function handleSearch(val) {
    filters.search = val.toLowerCase();
    renderTabContent();
}

function setFilterSub(sub) {
    filters.activeSub = sub;
    renderTabContent();
}

function setFilter(type, val) {
    if (type === 'category') {
        if (val === 'All') {
            filters.categories = ['All'];
        } else {
            const idxAll = filters.categories.indexOf('All');
            if (idxAll > -1) filters.categories.splice(idxAll, 1);

            const idx = filters.categories.indexOf(val);
            if (idx > -1) {
                filters.categories.splice(idx, 1);
                if (filters.categories.length === 0) filters.categories = ['All'];
            } else {
                filters.categories.push(val);
            }
        }
        renderFilterBarControls(); // Refresh the multi-select UI
    } else {
        filters[type] = val;
    }
    renderTabContent();
}

function setFilterSub(sub) {
    filters.activeSub = sub;
    renderFilterBarControls();
}

function renderFilterBarControls() {
    const items = (currentTab === 'expenses' || currentTab === 'analytics' && analyticsSubTab.startsWith('expenses')) ? DS.ed : 
                 (currentTab === 'mandatory' ? DS.med : DS.id);
    renderFilterBar(items, currentTab === 'expenses' ? 'ED' : (currentTab === 'mandatory' ? 'MED' : 'ID'));
}

function getFilteredData(items) {
    return items.filter(item => {
        // Search Filter
        if (filters.search) {
            const desc = (item.description || item.name || item.company || '').toLowerCase();
            if (!desc.includes(filters.search)) return false;
        }

        // Multi-Category Filter
        if (!filters.categories.includes('All')) {
            if (!filters.categories.includes(item.category)) return false;
        }
        
        // Date Range Filter
        if (filters.startDate || filters.endDate) {
            const itemDate = robustParseDate(item.date);
            if (!itemDate) return false;
            
            if (filters.startDate) {
                const s = new Date(filters.startDate);
                s.setHours(0,0,0,0);
                if (itemDate < s) return false;
            }
            if (filters.endDate) {
                const e = new Date(filters.endDate);
                e.setHours(23,59,59,999);
                if (itemDate > e) return false;
            }
        }

        return true;
    });
}

function renderFilterBar(items, sheet) {
    const cats = [...new Set(items.map(i => i.category).filter(Boolean))].sort();

    const tabHtml = `
        <button class="filter-tab-btn ${filters.activeSub==='date'?'active':''}" onclick="setFilterSub('date')">📅 Date Range</button>
        <button class="filter-tab-btn ${filters.activeSub==='cat'?'active':''}" onclick="setFilterSub('cat')">🏷️ Categories</button>
    `;

    let optionsHtml = '';
    if (filters.activeSub === 'date') {
        optionsHtml = `
            <div class="date-range-section active">
                <div class="date-range-inputs">
                    <div class="date-input-group">
                        <label>Start Date</label>
                        <input type="date" class="date-picker" value="${filters.startDate}" onchange="setFilter('startDate', this.value)">
                    </div>
                    <div class="date-input-group">
                        <label>End Date</label>
                        <input type="date" class="date-picker" value="${filters.endDate}" onchange="setFilter('endDate', this.value)">
                    </div>
                </div>
            </div>
        `;
    } else {
        optionsHtml = `
            <div class="category-select-section active">
                <div class="multi-select-dropdown">
                    <div class="multi-select-item all" onclick="setFilter('category', 'All')">
                        <input type="checkbox" ${filters.categories.includes('All') ? 'checked' : ''} readonly>
                        <div class="label">All Categories</div>
                    </div>
                    ${cats.map(c => `
                        <div class="multi-select-item" onclick="setFilter('category', '${c}')">
                            <input type="checkbox" ${filters.categories.includes(c) ? 'checked' : ''} readonly>
                            <div class="label">${c}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    document.getElementById('filter-tab-bar').innerHTML = tabHtml;
    document.getElementById('filter-options-content').innerHTML = optionsHtml;
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
    renderSidebar();
}

// ── Render Helpers ────────────────────────────────────────────────────────────
const CAT_ICONS = {
    'Anti Virus':'🛡️','Games':'🎮','Movies':'🎬','Others':'🎭','Coffee':'☕','Dining Out':'🍽️','Groceries':'🛒','Packaged Food':'🍱',
    'Electronics':'💻','Furniture':'🛋️','Household Machines':'🧺','Household Supplies':'🧻','Insurance':'🛡️','Maintenance':'🔧','Mortgage':'🏦','Rent':'🏠','Taxes':'📄',
    'Bank Account Fees':'💸','Business':'💼','Charity':'❤️','Clothing':'👕','Credit Card Fees':'💳','Donation':'🎁','Education':'🎓','Footwear':'👟','Gifts':'🎁','Grooming':'🪮','India':'🇮🇳','Investments':'📈','Makeup & Skincare':'💄','Medical Expenses':'🏥','Membership':'💳','Other':'📦','Parcels':'📦','Shein':'🛍️','Souvenir':'🧸',
    'Liquor':'🍺','Bus':'🚌','Car':'🚗','Flight':'✈️','Gas':'⛽','Hotel':'🏨','Parking':'🅿️','Taxi':'🚕','Train':'🚆',
    'Electricity':'⚡','Heat':'🔥','Internet (Wi-Fi)':'📶','Phone':'📱','TV':'📺','Water':'💧'
};

function catIcon(cat) { 
    if (!cat) return '💰';
    const clean = cat.split(' - ').pop();
    return CAT_ICONS[clean] || '💰'; 
}

function renderHeader(title, hasFilters = true) {
    return `
        <div class="page-header">
            <div class="header-left">
                <button class="menu-btn" onclick="toggleSidebar(true)" title="Menu">☰</button>
                <h1 class="page-title">${title}</h1>
            </div>
            <div class="header-right">
                ${hasFilters ? `<button class="refresh-btn ${filters.show ? 'active' : ''}" onclick="toggleFilterBar()" title="Filter" style="margin-right:8px; font-size:16px;">
                    <svg viewBox="0 0 24 24" style="width:20px; height:20px;"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
                </button>` : ''}
                <button class="refresh-btn" onclick="syncData()" title="Sync">↻</button>
            </div>
        </div>`;
}

function robustParseDate(d) {
    if (!d || d === 'Invalid Date') return null;
    let dateObj = new Date(d);
    if (!isNaN(dateObj.getTime())) return dateObj;

    // Handle DD/MM/YYYY or MM/DD/YYYY or YYYY/MM/DD
    const parts = String(d).split(/[ \-/.]/);
    if (parts.length === 3) {
        let y, m, day;
        if (parts[0].length === 4) { // YYYY-MM-DD
            y = parseInt(parts[0]); m = parseInt(parts[1]) - 1; day = parseInt(parts[2]);
        } else if (parts[2].length === 4) { // DD/MM/YYYY or MM/DD/YYYY
            y = parseInt(parts[2]);
            const p0 = parseInt(parts[0]);
            const p1 = parseInt(parts[1]);
            if (p0 > 12) { day = p0; m = p1 - 1; }
            else { m = p0 - 1; day = p1; }
        }
        if (y !== undefined) {
            dateObj = new Date(y, m, day);
            if (!isNaN(dateObj.getTime())) return dateObj;
        }
    }
    return null;
}

function formatDate(d) {
    const dateObj = robustParseDate(d);
    if (!dateObj) return d || '';
    return dateObj.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
}

function parseToTime(d) {
    const dateObj = robustParseDate(d);
    return dateObj ? dateObj.getTime() : 0;
}

function renderChartSection(filtered, type) {
    return `
        <div class="chart-card">
            <div class="chart-container"><canvas id="mainChart"></canvas></div>
            <div id="mainLegend" class="chart-legend"></div>
        </div>
    `;
}

function updateChart(data, subTab) {
    const ctx = document.getElementById('mainChart')?.getContext('2d');
    if (!ctx) return;
    
    const groups = {};
    if (subTab === 'expenses' || subTab === 'mandatory') {
        data.forEach(r => { const k = r.category || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (subTab === 'income') {
        data.forEach(r => { const k = r.company || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else { // Analytics views
        if (subTab === 'expenses-cat') data.forEach(r => { const k = r.category || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
        else if (subTab === 'expenses-card') data.forEach(r => { const k = r.payment_type || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
        else if (subTab.includes('month')) data.forEach(r => { const k = (r.date || '').substring(0, 7) || 'Unknown'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
        else if (subTab === 'income-company') data.forEach(r => { const k = r.company || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    }

    const sorted = Object.entries(groups).sort((a,b) => b[1] - a[1]).slice(0, 8);
    const labels = sorted.map(s => s[0]);
    const values = sorted.map(s => s[1]);
    const COLORS = ['#6366F1','#8B5CF6','#EC4899','#EF4444','#F59E0B','#10B981','#06B6D4','#3B82F6'];
    const isPie = !subTab.includes('month');

    if (window.activeChart) window.activeChart.destroy();
    window.activeChart = new Chart(ctx, {
        type: isPie ? 'doughnut' : 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: COLORS, borderWidth: 0, borderRadius: isPie ? 0 : 6 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: isPie ? {} : {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(240,240,255,0.3)', font: { size: 10 } } },
                x: { grid: { display: false }, ticks: { color: 'rgba(240,240,255,0.3)', font: { size: 10 } } }
            }
        }
    });

    const legend = document.getElementById('mainLegend');
    if (legend) legend.innerHTML = sorted.map(([label, val], i) => `
        <div class="legend-item">
            <div class="legend-color" style="background:${COLORS[i % COLORS.length]}"></div>
            <div class="legend-label">${label}</div>
            <div class="legend-val">${CURRENCY.format(val)}</div>
        </div>
    `).join('');
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

            html += `
            <div class="item-wrapper">
                <div class="swipe-actions">
                    <div class="swipe-action-right">Copy 📋</div>
                    <div class="swipe-action-left">Delete 🗑️</div>
                </div>
                <div class="list-item${isLast ? ' last' : ''}" 
                     data-row="${item._row}" data-sheet="${sheet}"
                     onclick="editEntry('${sheet}', ${item._row})"
                     ontouchstart="handleTouchStart(event)"
                     ontouchmove="handleTouchMove(event)"
                     ontouchend="handleTouchEnd(event)">
                    <div class="item-icon">${icon}</div>
                    <div class="item-body">
                        <div class="item-name">${name}</div>
                        ${sub ? `<div class="item-sub">${sub}</div>` : ''}
                    </div>
                    <div class="item-right">
                        <div class="${amtCls}">${prefix}${CURRENCY.format(parseFloat(item.amount)||0)}</div>
                        <div class="item-chevron">›</div>
                    </div>
                </div>
            </div>`;
        });
        html += `</div></div>`;
    }
    return html;
}

function getSubtext(item, sheet) {
    const parts = [];
    if (item.category) parts.push(item.category);
    if (item.payment_type) parts.push(item.payment_type);
    return parts.join(' · ');
}

// ── Main Page Tabs (No charts here now) ──────────────────────────────────────
function renderExpenses(c) {
    const items = DS.ed;
    renderFilterBar(items, 'ED');
    c.innerHTML = `
        ${renderHeader('Expenses')}
        ${renderItemList(items, 'ED')}`;
}

function renderMandatory(c) {
    const items = DS.med;
    renderFilterBar(items, 'MED');
    c.innerHTML = `
        ${renderHeader('Mandatory')}
        ${renderItemList(items, 'MED')}`;
}

function renderIncome(c) {
    const items = DS.id;
    renderFilterBar(items, 'ID');
    c.innerHTML = `
        ${renderHeader('Income')}
        ${renderItemList(items, 'ID')}`;
}

// ── Analytics Tab ─────────────────────────────────────────────────────────────
function renderAnalytics(c) {
    const labels = {
        'expenses-cat': 'Expense / Categories', 'expenses-card': 'Expense / Card',
        'expenses-month': 'Expense / Month', 'income-company': 'Income / Company', 'income-month': 'Income / Month'
    };
    
    const sourceData = (analyticsSubTab.startsWith('income') ? DS.id : DS.ed);
    const filtered = getFilteredData(sourceData);
    renderFilterBar(sourceData, analyticsSubTab.startsWith('income') ? 'ID' : 'ED');
    
    c.innerHTML = `
        ${renderHeader(labels[analyticsSubTab] || 'Analytics')}
        <div class="chart-card">
            <div class="chart-container"><canvas id="analyticsChart"></canvas></div>
            <div id="analyticsLegend" class="chart-legend"></div>
        </div>
    `;
    setTimeout(() => renderChartInAnalytics(filtered), 100);
}

function renderChartInAnalytics(data) {
    const ctx = document.getElementById('analyticsChart')?.getContext('2d');
    if (!ctx) return;
    
    const groups = {};
    if (analyticsSubTab === 'expenses-cat') {
        data.forEach(r => { const k = r.category || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (analyticsSubTab === 'expenses-card') {
        data.forEach(r => { const k = r.payment_type || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (analyticsSubTab.includes('month')) {
        data.forEach(r => { const k = (r.date || '').substring(0, 7) || 'Unknown'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (analyticsSubTab === 'income-company') {
        data.forEach(r => { const k = r.company || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    }

    const sorted = Object.entries(groups).sort((a,b) => b[1] - a[1]).slice(0, 8);
    const labels = sorted.map(s => s[0]);
    const values = sorted.map(s => s[1]);
    const COLORS = ['#6366F1','#8B5CF6','#EC4899','#EF4444','#F59E0B','#10B981','#06B6D4','#3B82F6'];
    const isPie = !analyticsSubTab.includes('month');

    if (window.activeAnalyticsChart) window.activeAnalyticsChart.destroy();
    
    window.activeAnalyticsChart = new Chart(ctx, {
        type: isPie ? 'doughnut' : 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: COLORS,
                borderWidth: 0,
                borderRadius: isPie ? 0 : 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: isPie ? {} : {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(240,240,255,0.4)', font:{size:10} } },
                x: { grid: { display: false }, ticks: { color: 'rgba(240,240,255,0.4)', font:{size:10} } }
            }
        }
    });
    
    const legend = document.getElementById('analyticsLegend');
    if (legend) legend.innerHTML = sorted.map(([label, val], i) => `
        <div class="legend-item">
            <div class="legend-color" style="background:${COLORS[i % COLORS.length]}"></div>
            <div class="legend-label">${label}</div>
            <div class="legend-val">${CURRENCY.format(val)}</div>
        </div>
    `).join('');
}

function renderChart(data) {
    const ctx = document.getElementById('analyticsChart')?.getContext('2d');
    if (!ctx) return;
    
    const groups = {};
    if (analyticsSubTab === 'expenses-cat') {
        data.forEach(r => { const k = r.category || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (analyticsSubTab === 'expenses-card') {
        data.forEach(r => { const k = r.payment_type || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (analyticsSubTab === 'expenses-month' || analyticsSubTab === 'income-month') {
        data.forEach(r => { const k = (r.date || '').substring(0, 7) || 'Unknown'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    } else if (analyticsSubTab === 'income-company') {
        data.forEach(r => { const k = r.company || 'Other'; groups[k] = (groups[k]||0) + (parseFloat(r.amount)||0); });
    }
    
    const sorted = Object.entries(groups).sort((a,b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const values = sorted.map(s => s[1]);
    const COLORS = ['#6366F1','#8B5CF6','#EC4899','#EF4444','#F59E0B','#10B981','#06B6D4','#3B82F6'];
    
    const isPie = analyticsSubTab.includes('cat') || analyticsSubTab.includes('card') || analyticsSubTab.includes('company');
    
    if (window.activeChart) window.activeChart.destroy();
    
    window.activeChart = new Chart(ctx, {
        type: isPie ? 'doughnut' : 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: COLORS,
                borderWidth: 0,
                borderRadius: isPie ? 0 : 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { 
                legend: { display: false }
            },
            scales: isPie ? {} : {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, border: { display: false }, ticks: { color: 'rgba(240,240,255,0.4)' } },
                x: { grid: { display: false }, ticks: { color: 'rgba(240,240,255,0.4)' } }
            }
        }
    });
    
    const legend = document.getElementById('chartLegend');
    legend.innerHTML = sorted.map(([label, val], i) => `
        <div class="legend-item">
            <div class="legend-color" style="background:${COLORS[i % COLORS.length]}"></div>
            <div style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</div>
            <div style="font-weight:700;">${CURRENCY.format(val)}</div>
        </div>
    `).join('');
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
    
    // Populate fields based on sheet mapping
    const dateObj = robustParseDate(entry.date);
    if (document.getElementById('f-date')) document.getElementById('f-date').value = dateObj ? dateObj.toISOString().split('T')[0] : '';
    if (document.getElementById('f-amount')) document.getElementById('f-amount').value = entry.amount || '';
    if (document.getElementById('f-desc')) document.getElementById('f-desc').value = entry.description || entry.desc || '';

    if (sheet === 'ED' || sheet === 'MED') {
        const cat = entry.category || '';
        document.getElementById('f-cat').value = cat;
        document.getElementById('f-cat-display').textContent = (cat ? `${catIcon(cat)} ${cat}` : 'Select Category');
        if (document.getElementById('f-payment')) document.getElementById('f-payment').value = entry.payment_type || '';
        if (document.getElementById('f-weight')) document.getElementById('f-weight').value = entry.weight || entry.quantity || '';
        if (document.getElementById('f-unit')) document.getElementById('f-unit').value = entry.unit || '';
    }
    
    if (sheet === 'MED') {
        if (document.getElementById('f-biweekly')) document.getElementById('f-biweekly').checked = entry.repeat_bi_weekly === 'TRUE';
        if (document.getElementById('f-monthly')) document.getElementById('f-monthly').checked = entry.repeat_monthly === 'TRUE';
    }
    
    if (sheet === 'ID') {
        if (document.getElementById('f-name')) document.getElementById('f-name').value = entry.name || '';
        if (document.getElementById('f-company')) document.getElementById('f-company').value = entry.company || '';
        if (document.getElementById('f-phone')) document.getElementById('f-phone').value = entry.phone_bill || '';
        if (document.getElementById('f-biweekly')) document.getElementById('f-biweekly').checked = entry.repeat_bi_weekly === 'TRUE';
    }
    
    openSheet();
}

const PAYMENT_TYPES = [
    "Account Debit", "American Express SimplyCash", "American Express SimplyCash - Cashback", "Cash",
    "Costco Mastercard", "Costco Mastercard - Cashback", "Home Trust Preferred Visa", "Rogers Mastercard",
    "Scotiabank Visa Card - Dhruv", "Scotiabank Visa Card - Mansi"
];

const UNITS = [
    {v:"G", l:"G - Grams"}, {v:"KG", l:"KG - Kilograms"}, {v:"L", l:"L - Liters"},
    {v:"ML", l:"ML - Milliliters"}, {v:"P", l:"P - Pieces"}, {v:"Pe", l:"Pe - Persons"}
];

const ID_NAMES = ["Dhruv", "Mansi", "Mansi & Dhruv"];

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
        </div>`;

    if (s === 'ID') {
        html += `
        <div class="form-group">
            <label>NAME</label>
            <select id="f-name">
                <option value="">Select Name</option>
                ${ID_NAMES.map(n => `<option value="${n}">${n}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label>COMPANY</label>
            <input type="text" id="f-company" placeholder="Company name">
        </div>`;
    } else {
        html += `
        <div class="form-group tappable" onclick="showCategoryPicker()">
            <label>CATEGORY</label>
            <div id="f-cat-display" class="form-value">Select Category</div>
            <input type="hidden" id="f-cat">
        </div>
        <div class="form-group">
            <label>DESCRIPTION</label>
            <input type="text" id="f-desc" placeholder="What was it for?">
        </div>`;
    }

    if (activeSheet !== 'ID') {
        html += `
        <div class="sc-grid" style="margin-bottom:10px;">
            <div class="form-group">
                <label>Weight</label>
                <input type="number" id="f-weight" step="any" placeholder="0.00">
            </div>
            <div class="form-group">
                <label>Unit</label>
                <select id="f-unit">
                    <option value="">None</option>
                    <option value="kg">kg</option>
                    <option value="g">g</option>
                    <option value="lbs">lbs</option>
                    <option value="pcs">pcs</option>
                    <option value="ml">ml</option>
                    <option value="l">l</option>
                </select>
            </div>
        </div>`;
    }
    if (s === 'ED' || s === 'MED') {
        html += `
        <div class="form-group">
            <label>PAYMENT TYPE</label>
            <select id="f-payment">
                <option value="">Select Payment Type</option>
                ${PAYMENT_TYPES.map(p => `<option value="${p}">${p}</option>`).join('')}
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
    if (document.getElementById('f-weight')) document.getElementById('f-weight').value = '';
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
    if (!amount || !date) { showToast('Fill in required fields', true); return; }

    const payload = { amount, date };

    if (activeSheet === 'ED') {
        payload.category = document.getElementById('f-cat').value;
        payload.description = document.getElementById('f-desc').value;
        payload.weight = document.getElementById('f-weight').value;
        payload.unit = document.getElementById('f-unit').value;
        payload.payment_type = document.getElementById('f-payment').value;
    } else if (activeSheet === 'MED') {
        payload.category = document.getElementById('f-cat').value;
        payload.description = document.getElementById('f-desc').value;
        payload.payment_type = document.getElementById('f-payment').value;
        payload.repeat_bi_weekly = document.getElementById('f-biweekly').checked ? 'TRUE' : 'FALSE';
        payload.repeat_monthly = document.getElementById('f-monthly').checked ? 'TRUE' : 'FALSE';
    } else if (activeSheet === 'ID') {
        payload.name = document.getElementById('f-name').value;
        payload.company = document.getElementById('f-company').value;
        payload.phone_bill = document.getElementById('f-phone').value;
        payload.repeat_bi_weekly = document.getElementById('f-biweekly').checked ? 'TRUE' : 'FALSE';
    }

    // Manual mapping to ensure specific order
    let values = [];
    if (activeSheet === 'ED') {
        // Category, Date, Description, Amount, Weight, Unit, Payment Type
        values = [payload.category, payload.date, payload.description, payload.amount, payload.weight, payload.unit, payload.payment_type];
    } else if (activeSheet === 'ID') {
        // Name, Company, Date, Amount, Phone Bill, Repeat Bi Weekly
        values = [payload.name, payload.company, payload.date, payload.amount, payload.phone_bill, payload.repeat_bi_weekly];
    } else if (activeSheet === 'MED') {
        // Category, Date, Description, Amount, Payment Type, Repeat Bi Weekly, Repeat Monthly
        values = [payload.category, payload.date, payload.description, payload.amount, payload.payment_type, payload.repeat_bi_weekly, payload.repeat_monthly];
    }

    showLoader(true);
    try {
        if (activeEntry) {
            await DS.api.updateRow(activeSheet, activeEntry._row, values);
            showToast('✓ Updated');
        } else {
            await DS.api.appendRow(activeSheet, values);
            showToast('✓ Saved');
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

// ── Sidebar & Categories ───────────────────────────────────────────────────
let CATEGORIES = {
    "Electronics": ["Anti Virus"],
    "Entertainment": ["Games", "Movies", "Others"],
    "Food": ["Coffee", "Dining Out", "Groceries", "Packaged Food"],
    "Home": ["Electronics", "Furniture", "Household Machines", "Household Supplies", "Insurance", "Maintenance", "Mortgage", "Rent", "Taxes"],
    "Life": ["Bank Account Fees", "Business", "Charity", "Clothing", "Credit Card Fees", "Donation", "Education", "Footwear", "Gifts", "Grooming", "India", "Insurance", "Investments", "Makeup & Skincare", "Medical Expenses", "Membership", "Other", "Parcels", "Shein", "Souvenir"],
    "Liquor": [],
    "Transportation": ["Bus", "Car", "Flight", "Gas", "Hotel", "Other", "Parking", "Taxi", "Train"],
    "Utilities": ["Electricity", "Heat", "Internet (Wi-Fi)", "Phone", "TV", "Water"]
};

// Load custom categories from local storage
const storedCats = localStorage.getItem('custom_categories');
if (storedCats) {
    const parsed = JSON.parse(storedCats);
    for (const group in parsed) {
        if (!CATEGORIES[group]) CATEGORIES[group] = [];
        CATEGORIES[group] = [...new Set([...CATEGORIES[group], ...parsed[group]])];
    }
}

function toggleSidebar(show) {
    const s = document.getElementById('sidebar');
    const o = document.getElementById('sidebar-overlay');
    if (show) {
        o.style.display = 'block';
        requestAnimationFrame(() => {
            o.classList.add('show');
            s.classList.add('show');
        });
    } else {
        o.classList.remove('show');
        s.classList.remove('show');
        setTimeout(() => { o.style.display = 'none'; }, 300);
    }
}

function switchSidebarTab(tab, sub = null) {
    if (tab === 'analytics') {
        currentTab = 'analytics';
        analyticsSubTab = sub;
    } else {
        currentTab = tab;
    }
    renderTabContent();
    toggleSidebar(false);
}

function renderSidebar() {
    const container = document.getElementById('sidebar-categories');
    let html = `
        <div class="side-label">Navigation</div>
        <div class="side-item ${currentTab==='expenses'?'active':''}" onclick="switchSidebarTab('expenses')"><div class="side-item-icon">💸</div>Expenses</div>
        <div class="side-item ${currentTab==='mandatory'?'active':''}" onclick="switchSidebarTab('mandatory')"><div class="side-item-icon">🗓️</div>Mandatory</div>
        <div class="side-item ${currentTab==='income'?'active':''}" onclick="switchSidebarTab('income')"><div class="side-item-icon">💰</div>Income</div>

        <div class="side-label">Analytics</div>
        <div class="side-item ${analyticsSubTab==='expenses-cat'&&currentTab==='analytics'?'active':''}" onclick="switchSidebarTab('analytics', 'expenses-cat')"><div class="side-item-icon">📊</div>Expense / Categories</div>
        <div class="side-item ${analyticsSubTab==='expenses-card'&&currentTab==='analytics'?'active':''}" onclick="switchSidebarTab('analytics', 'expenses-card')"><div class="side-item-icon">💳</div>Expense / Card</div>
        <div class="side-item ${analyticsSubTab==='expenses-month'&&currentTab==='analytics'?'active':''}" onclick="switchSidebarTab('analytics', 'expenses-month')"><div class="side-item-icon">📅</div>Expense / Month</div>
        <div class="side-item ${analyticsSubTab==='income-company'&&currentTab==='analytics'?'active':''}" onclick="switchSidebarTab('analytics', 'income-company')"><div class="side-item-icon">🏢</div>Income / Company</div>
        <div class="side-item ${analyticsSubTab==='income-month'&&currentTab==='analytics'?'active':''}" onclick="switchSidebarTab('analytics', 'income-month')"><div class="side-item-icon">📈</div>Income / Month</div>

        <div class="side-label">Account</div>
        <div class="side-item" onclick="toggleCategoryManage(true)"><div class="side-item-icon">🏷️</div>Manage Categories</div>
        <div class="side-item" onclick="handleSignOut()"><div class="side-item-icon">🚪</div>Sign Out</div>
    `;
    container.innerHTML = html;
}

function toggleCategoryManage(show) {
    const view = document.getElementById('cat-manage-view');
    view.classList.toggle('show', show);
    if (show) {
        toggleSidebar(false);
        renderCategoryManageList();
    }
}

function renderCategoryManageList() {
    const list = document.getElementById('cat-manage-list');
    let html = '';
    for (const group in CATEGORIES) {
        html += `<div class="side-label">${group}</div>`;
        const cats = CATEGORIES[group];
        if (cats.length === 0) {
             html += `<div class="side-item"><div class="side-item-icon">${catIcon(group)}</div><div class="side-name">${group}</div></div>`;
        } else {
            cats.forEach(cat => {
                const full = `${group} - ${cat}`;
                html += `<div class="side-item"><div class="side-item-icon">${catIcon(full)}</div><div class="side-name">${cat}</div></div>`;
            });
        }
    }
    list.innerHTML = html;
}

// ── Swipe Logic ───────────────────────────────────────────────────────────────
let touchStartX = 0;
let currentSwipeItem = null;

function handleTouchStart(e) {
    touchStartX = e.touches[0].clientX;
    currentSwipeItem = e.currentTarget;
}

function handleTouchMove(e) {
    if (!currentSwipeItem) return;
    const diff = e.touches[0].clientX - touchStartX;
    if (Math.abs(diff) > 20) {
        const trans = Math.max(-100, Math.min(100, diff));
        currentSwipeItem.style.transform = `translateX(${trans}px)`;
        currentSwipeItem.style.transition = 'none';
    }
}

async function handleTouchEnd(e) {
    if (!currentSwipeItem) return;
    const diff = e.changedTouches[0].clientX - touchStartX;
    const sheet = currentSwipeItem.dataset.sheet;
    const row = parseInt(currentSwipeItem.dataset.row);

    if (diff > 60) { // Swipe Right - Copy
        currentSwipeItem.style.transform = `translateX(100%)`;
        setTimeout(() => {
            currentSwipeItem.style.transform = '';
            copyEntry(sheet, row);
        }, 200);
    } else if (diff < -60) { // Swipe Left - Delete
        currentSwipeItem.style.transform = `translateX(-100%)`;
        setTimeout(async () => {
            currentSwipeItem.style.transform = '';
            if (confirm('Delete this transaction?')) {
                activeSheet = sheet;
                await deleteEntry(row);
            }
        }, 200);
    } else {
        currentSwipeItem.style.transform = '';
        currentSwipeItem.style.transition = 'transform 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28)';
    }
    currentSwipeItem = null;
}

function renderSidebar() {
    const container = document.getElementById('sidebar-categories');
    let html = `
        <div class="side-label">Navigation</div>
        <div class="side-item ${currentTab==='expenses'?'active':''}" onclick="switchSidebarTab('expenses')"><div class="side-item-icon">💸</div>Expenses</div>
        <div class="side-item ${currentTab==='mandatory'?'active':''}" onclick="switchSidebarTab('mandatory')"><div class="side-item-icon">🗓️</div>Mandatory</div>
        <div class="side-item ${currentTab==='income'?'active':''}" onclick="switchSidebarTab('income')"><div class="side-item-icon">💰</div>Income</div>

        <div class="side-label">Account</div>
        <div class="side-item" onclick="toggleCategoryManage(true)"><div class="side-item-icon">🏷️</div>Manage Categories</div>
        <div class="side-item" onclick="handleSignOut()"><div class="side-item-icon">🚪</div>Sign Out</div>
    `;
    container.innerHTML = html;
}

function toggleCategoryManage(show) {
    const view = document.getElementById('cat-manage-view');
    view.classList.toggle('show', show);
    if (show) {
        toggleSidebar(false);
        renderCategoryManageList();
    }
}

function renderCategoryManageList() {
    const list = document.getElementById('cat-manage-list');
    let html = '';
    for (const group in CATEGORIES) {
        html += `<div class="side-label">${group}</div>`;
        const cats = CATEGORIES[group];
        if (cats.length === 0) {
             html += `<div class="side-item"><div class="side-item-icon">${catIcon(group)}</div><div class="side-name">${group}</div></div>`;
        } else {
            cats.forEach(cat => {
                const full = `${group} - ${cat}`;
                html += `<div class="side-item"><div class="side-item-icon">${catIcon(full)}</div><div class="side-name">${cat}</div></div>`;
            });
        }
    }
    list.innerHTML = html;
}

function copyEntry(sheet, rowIndex) {
    const store = sheet === 'ED' ? DS.ed : sheet === 'MED' ? DS.med : DS.id;
    const entry = store.find(r => r._row === rowIndex);
    if (!entry) return;
    
    // Open as Add but with populate values
    activeSheet = sheet;
    activeEntry = null; // Important: this is a NEW entry
    const labels = { ED: 'Expense', MED: 'Mandatory', ID: 'Income' };
    document.getElementById('sheet-title').textContent = `Copy ${labels[activeSheet]}`;
    document.getElementById('delete-btn').style.display = 'none';
    buildForm();
    
    // Populate
    if (document.getElementById('f-amount')) document.getElementById('f-amount').value = entry.amount || '';
    if (document.getElementById('f-date')) document.getElementById('f-date').value = new Date().toISOString().split('T')[0];
    if (document.getElementById('f-desc')) document.getElementById('f-desc').value = entry.description || entry.desc || '';
    if (document.getElementById('f-cat')) {
        document.getElementById('f-cat').value = entry.category || '';
        document.getElementById('f-cat-display').textContent = (entry.category ? `${catIcon(entry.category)} ${entry.category}` : 'Select Category');
    }
    if (document.getElementById('f-payment')) document.getElementById('f-payment').value = entry.payment_type || '';
    if (document.getElementById('f-name')) document.getElementById('f-name').value = entry.name || '';
    if (document.getElementById('f-company')) document.getElementById('f-company').value = entry.company || '';
    if (document.getElementById('f-weight')) document.getElementById('f-weight').value = entry.weight || '';
    if (document.getElementById('f-unit')) document.getElementById('f-unit').value = entry.unit || '';
    
    openSheet();
    showToast('Transaction copied. Ready to save.');
}

function promptAddCategory() {
    const name = prompt("Enter new category name (e.g. Life - Hobby):");
    if (!name) return;
    const parts = name.split(' - ');
    const group = parts[0];
    const cat = parts[1] || '';
    
    if (!CATEGORIES[group]) CATEGORIES[group] = [];
    if (cat && !CATEGORIES[group].includes(cat)) CATEGORIES[group].push(cat);
    
    // Save to local storage
    const custom = JSON.parse(localStorage.getItem('custom_categories') || '{}');
    if (!custom[group]) custom[group] = [];
    if (cat && !custom[group].includes(cat)) custom[group].push(cat);
    localStorage.setItem('custom_categories', JSON.stringify(custom));
    
    renderSidebar();
    showToast(`Category "${name}" added`);
}

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
        const groupMatch = group.toLowerCase().includes(q);
        const cats = CATEGORIES[group];
        
        if (cats.length === 0) {
            if (groupMatch) {
                html += `<div class="cat-group">${group}</div>`;
                html += `<div class="cat-item" onclick="selectCategory('${group}')">${catIcon(group)} ${group}</div>`;
            }
        } else {
            const filtered = cats.filter(c => c.toLowerCase().includes(q) || groupMatch);
            if (filtered.length) {
                html += `<div class="cat-group">${group}</div>`;
                filtered.forEach(cat => {
                    const full = `${group} - ${cat}`;
                    html += `<div class="cat-item" onclick="selectCategory('${full}')">${catIcon(full)} ${full}</div>`;
                });
            }
        }
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
