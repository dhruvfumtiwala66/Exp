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
        sessionStorage.setItem('google_token', tokenFromHash);
        window.history.replaceState({}, document.title, window.location.pathname);
        state.token = tokenFromHash;
        checkSetup(); return;
    }
    const stored = sessionStorage.getItem('google_token');
    if (stored) { state.token = stored; checkSetup(); }
    else { document.getElementById('signin-screen').style.display = 'flex'; }
}

function handleSignIn() {
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}&response_type=token&scope=${encodeURIComponent(CONFIG.SCOPES)}&prompt=consent`;
    window.location.href = url;
}

function handleSignOut() {
    sessionStorage.removeItem('google_token');
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
    async init(token, spreadsheetId) {
        this.api = new SheetsAPI(token, spreadsheetId);
        await this.refresh();
    },
    async refresh() {
        showLoader(true);
        try {
            const [ed, id, med] = await Promise.all([
                this.api.fetchSheet('ED'),
                this.api.fetchSheet('ID'),
                this.api.fetchSheet('MED')
            ]);
            this.ed = this.parse(ed);
            this.id = this.parse(id);
            this.med = this.parse(med);
        } catch (err) { showToast(err.message, true); throw err; }
        finally { showLoader(false); }
    },
    parse(rows) {
        if (rows.length < 2) return [];
        const headers = rows[0];
        return rows.slice(1).map((row, i) => {
            const obj = { _row: i + 2 };
            headers.forEach((h, j) => { obj[h.trim().toLowerCase().replace(/\s+/g, '_')] = (row[j] || '').trim(); });
            return obj;
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
    'Groceries':'🛒','Restaurants':'🍽️','Coffee':'☕','Alcohol':'🍺',
    'Rent':'🏠','Electricity':'⚡','Water':'💧','Gas':'🔥','Internet':'📶','Maintenance':'🔧',
    'Public Transit':'🚌','Uber/Lyft':'🚗','Parking':'🅿️','Insurance':'🛡️',
    'Subscriptions':'📺','Movies':'🎬','Hobbies':'🎨','Games':'🎮','Events':'🎉',
    'Clothing':'👕','Electronics':'💻','Home Goods':'🏡','Pharmacy':'💊','Beauty':'💅',
    'Interest':'📈','Fees':'💸','Savings Transfer':'🏦','Loan Payment':'💳',
    'Office Supplies':'📎','Software':'💾','Travel':'✈️','Meals':'🍱',
    'Gifts':'🎁','Donations':'❤️','Uncategorized':'📦'
};

function catIcon(cat) { return CAT_ICONS[cat] || '💰'; }

function formatDate(d) {
    if (!d) return '';
    try { return new Date(d + 'T00:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }); }
    catch { return d; }
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
    if (!items.length) return `<div class="empty-state"><div class="empty-icon">📭</div><div>No entries yet</div><div class="empty-sub">Tap + to add one</div></div>`;
    const sorted = [...items].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const grouped = {};
    sorted.forEach(item => {
        const key = item.date || 'No Date';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(item);
    });
    let html = '';
    for (const date in grouped) {
        html += `<div class="date-section">
            <div class="date-label">${formatDate(date)}</div>
            <div class="list-card">`;
        grouped[date].forEach((item, idx) => {
            const name = item.description || item.name || item.company || 'Unnamed';
            const sub = getSubtext(item, sheet);
            const icon = sheet === 'ID' ? '💼' : (sheet === 'MED' ? '📅' : catIcon(item.category));
            const amtCls = sheet === 'ID' ? 'amt-income' : (sheet === 'MED' ? 'amt-mandatory' : 'amt-expense');
            const prefix = sheet === 'ID' ? '+' : '-';
            const isLast = idx === grouped[date].length - 1;
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
    if (sheet === 'MED') {
        const parts = [];
        if (item.category) parts.push(item.category);
        if (item.repeat_bi_weekly === 'TRUE') parts.push('Bi-weekly');
        else if (item.repeat_monthly === 'TRUE') parts.push('Monthly');
        return parts.join(' · ');
    }
    const parts = [];
    if (item.category) parts.push(item.category);
    if (item.payment_type) parts.push(item.payment_type);
    return parts.join(' · ');
}

// ── Expenses Tab ──────────────────────────────────────────────────────────────
function renderExpenses(c) {
    const items = DS.ed;
    const total = items.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
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

    if (analyticView === 'Cash Flow') {
        const net = incomeTotal - expTotal - mandTotal;
        const savRate = incomeTotal > 0 ? (net / incomeTotal) * 100 : 0;
        const hColor = savRate > 20 ? '#10B981' : (savRate > 0 ? '#F59E0B' : '#EF4444');
        const maxBar = Math.max(incomeTotal, expTotal, mandTotal, 1);
        body.innerHTML = `
            <div class="an-card">
                ${barRow('Income', incomeTotal, maxBar, '#10B981')}
                ${barRow('Expenses', expTotal, maxBar, '#EF4444')}
                ${barRow('Mandatory', mandTotal, maxBar, '#8B5CF6')}
            </div>
            <div class="an-card">
                <div class="an-card-title">Budget Health — ${Math.round(savRate)}% Saved</div>
                <div class="health-bar-bg"><div class="health-bar-fill" style="width:${Math.max(0,Math.min(100,savRate+50))}%;background:${hColor};"></div></div>
                <p class="an-hint">Savings rate relative to 0% baseline.</p>
            </div>
            <div class="kpi-grid">
                <div class="kpi-card"><div class="kpi-label">NET REMAINING</div><div class="kpi-val" style="color:${net>=0?'#10B981':'#EF4444'}">${CURRENCY.format(net)}</div></div>
                <div class="kpi-card"><div class="kpi-label">SAVINGS RATE</div><div class="kpi-val">${Math.round(savRate)}%</div></div>
                <div class="kpi-card"><div class="kpi-label">TOTAL INCOME</div><div class="kpi-val">${CURRENCY.format(incomeTotal)}</div></div>
                <div class="kpi-card"><div class="kpi-label">TOTAL SPEND</div><div class="kpi-val">${CURRENCY.format(expTotal)}</div></div>
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
    let html = `<div class="an-card">${sorted.map(([label, val], i) => barRow(label||'Other', val, maxVal, COLORS[i % COLORS.length])).join('')}</div>`;

    if (analyticView === 'Category') {
        html += `<div class="kpi-grid">
            <div class="kpi-card"><div class="kpi-label">TOTAL SPENT</div><div class="kpi-val">${CURRENCY.format(expTotal)}</div></div>
            <div class="kpi-card"><div class="kpi-label">TRANSACTIONS</div><div class="kpi-val">${expenses.length}</div></div>
            <div class="kpi-card"><div class="kpi-label">CATEGORIES</div><div class="kpi-val">${sorted.length}</div></div>
            <div class="kpi-card"><div class="kpi-label">AVG TRANS</div><div class="kpi-val">${CURRENCY.format(expTotal/(expenses.length||1))}</div></div>
        </div>`;
    }
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
    document.getElementById('f-amount').value = entry.amount || '';
    document.getElementById('f-date').value = entry.date || '';
    document.getElementById('f-desc').value = entry.description || entry.name || '';
    if (sheet === 'ED' || sheet === 'MED') {
        document.getElementById('f-cat').value = entry.category || '';
        document.getElementById('f-cat-display').textContent = entry.category || 'Select Category';
        if (document.getElementById('f-payment'))
            document.getElementById('f-payment').value = entry.payment_type || 'Credit Card';
    }
    if (sheet === 'MED') {
        document.getElementById('f-biweekly').checked = entry.repeat_bi_weekly === 'TRUE';
        document.getElementById('f-monthly').checked = entry.repeat_monthly === 'TRUE';
    }
    if (sheet === 'ID') {
        if (document.getElementById('f-company'))
            document.getElementById('f-company').value = entry.company || '';
        if (document.getElementById('f-phone'))
            document.getElementById('f-phone').value = entry.phone_bill || '';
        if (document.getElementById('f-biweekly'))
            document.getElementById('f-biweekly').checked = entry.repeat_bi_weekly === 'TRUE';
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
        <div class="form-group">
            <label>PAYMENT TYPE</label>
            <select id="f-payment">
                <option value="Credit Card">Credit Card</option>
                <option value="Debit">Debit</option>
                <option value="Cash">Cash</option>
                <option value="E-Transfer">E-Transfer</option>
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

    let values = [];
    if (activeSheet === 'ED') {
        const cat = document.getElementById('f-cat').value;
        const pay = document.getElementById('f-payment').value;
        values = [cat, date, desc, amount, '', '', pay];
    } else if (activeSheet === 'MED') {
        const cat = document.getElementById('f-cat').value;
        const pay = document.getElementById('f-payment').value;
        const bw = document.getElementById('f-biweekly').checked ? 'TRUE' : 'FALSE';
        const mo = document.getElementById('f-monthly').checked ? 'TRUE' : 'FALSE';
        values = [cat, date, desc, amount, pay, bw, mo];
    } else if (activeSheet === 'ID') {
        const comp = (document.getElementById('f-company')?.value) || '';
        const phone = (document.getElementById('f-phone')?.value) || '';
        const bw = document.getElementById('f-biweekly')?.checked ? 'TRUE' : 'FALSE';
        values = [desc, comp, date, amount, phone, bw];
    }

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
    "Food & Drink": ["Groceries","Restaurants","Coffee","Alcohol","Takeout"],
    "Housing": ["Rent","Electricity","Water","Gas","Internet","Maintenance"],
    "Transport": ["Gas","Public Transit","Uber/Lyft","Parking","Insurance"],
    "Entertainment": ["Subscriptions","Movies","Hobbies","Games","Events"],
    "Shopping": ["Clothing","Electronics","Home Goods","Pharmacy","Beauty"],
    "Finance": ["Interest","Fees","Savings Transfer","Loan Payment"],
    "Work": ["Office Supplies","Software","Travel","Meals"],
    "Health": ["Gym","Doctor","Dentist","Vitamins"],
    "Misc": ["Gifts","Donations","Uncategorized"]
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
