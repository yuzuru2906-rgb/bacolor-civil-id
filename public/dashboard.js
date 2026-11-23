// ===========================
// Bacolor Civil ID Portal
// dashboard.js
// ===========================

// Residents, admin accounts and verification now live on the server (see /api/admin/*).
// The browser only keeps the login token for this tab and the display preferences below.
var SESSION_KEY = 'ncrs_session';
var SETTINGS_KEY = 'ncrs_settings';

var DEFAULT_SETTINGS = {
  theme: 'light',
  sortOrder: 'newest',
  compact: false,
  welcome: true,
  idleMinutes: 0,
  maskSensitive: false,
  confirmVerify: false
};

var REGIONS = [
  ['CLB', 'Calibutbut'], ['SIS', 'San Isidro'], ['CBL', 'Cabalantian'], ['CBT', 'Cabetican'],
  ['MLW', 'Maliwalu'], ['TNJ', 'Tinajero'], ['SVT', 'San Vicente'], ['MGL', 'Magliman'],
  ['STB', 'Santa Barbara'], ['STI', 'Santa Ines'], ['SAN', 'San Antonio'], ['MCB', 'Macabacle'],
  ['PRL', 'Parulog'], ['PTR', 'Potrero'], ['DLR', 'Dolores'], ['CBB', 'Cabambangan (Poblacion)'],
  ['BLS', 'Balas'], ['DUA', 'Duat'], ['CON', 'Concepcion'], ['MSL', 'Mesalipit'], ['TLB', 'Talba']
];

var SETTINGS_TITLES = {
  profile: ['My profile', 'Manage your admin account details and contact info.'],
  security: ['Security & password', 'Update your admin login password to protect your account.'],
  appearance: ['Appearance & preferences', 'Customize theme, record sorting, and dashboard behavior.'],
  privacy: ['Privacy & registry data', 'Session security, data masking, and registry data controls.']
};

var allRecords = [];
var shownRecords = [];
var toastTimer;
var currentSession = null;

var idleMinutes = 0;
var lastActivity = Date.now();
var idleChecker = null;

var calViewDate = new Date();


// ---------- LOGIN & ACCOUNT HELPERS ----------

function getSession() {
  var saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return null;
  try { return JSON.parse(saved); } catch (e) { return null; }
}

// Talks to the admin part of the backend. Every call carries this tab's login token.
async function adminApi(path, options) {
  options = options || {};
  var headers = { 'Accept': 'application/json' };
  if (currentSession && currentSession.token) headers.Authorization = 'Bearer ' + currentSession.token;
  var init = { method: options.method || (options.body !== undefined ? 'POST' : 'GET'), headers: headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  var response;
  try {
    response = await fetch('/api/admin' + path, init);
  } catch (e) {
    throw new Error('Could not reach the server. Check your internet connection.');
  }
  var data = null;
  try { data = await response.json(); } catch (e) {}
  if (!response.ok) {
    var error = new Error((data && data.error) || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function goToLogin(notice) {
  sessionStorage.removeItem(SESSION_KEY);
  if (notice) sessionStorage.setItem('ncrs_notice', notice);
  window.location.href = 'index.html';
}

function logout() {
  var finish = function () { goToLogin(); };
  adminApi('/logout', { method: 'POST' }).then(finish, finish);
}

// One place to deal with a failed server call: expired login -> back to sign-in, anything else -> a message.
function handleApiError(error, fallback) {
  if (error && error.status === 401) {
    goToLogin('Your session has ended. Please sign in again.');
    return;
  }
  showToast((error && error.message) || fallback || 'Something went wrong.');
}


// ---------- SMALL HELPERS ----------

function regionName(code) {
  for (var i = 0; i < REGIONS.length; i++) {
    if (REGIONS[i][0] === code) return REGIONS[i][1];
  }
  return code || '—';
}

function escapeHtml(value) {
  if (value === null || value === undefined) value = '';
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, function (ch) { return map[ch]; });
}

function maskId(id) {
  if (!id) return 'No ID number';
  var str = String(id);
  if (str.length <= 4) return '••••';
  return str.slice(0, 4) + '••••' + str.slice(-2);
}

function dateText(value) {
  if (!value) return '—';
  var date = new Date(value);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function initial(name) {
  var words = String(name || '?').trim().split(/\s+/);
  var letters = '';
  for (var i = 0; i < words.length && i < 2; i++) {
    letters += words[i][0] || '';
  }
  return letters.toUpperCase();
}

function hasDocument(value) {
  return typeof value === 'string' && value.length > 0;
}

// Documents a resident has not handed in yet.
function hasDoc(r, field) {
  // The records list leaves photo data out (it is large) and sends yes/no flags instead.
  return !!r[field + 'OnFile'] || hasDocument(r[field]);
}

function missingDocList(r) {
  var out = [];
  if (!hasDoc(r, 'idPhoto')) out.push('Government ID');
  if (!hasDoc(r, 'facePhoto')) out.push('face photo');
  if (!hasDoc(r, 'signaturePhoto')) out.push('signature');
  return out;
}

// Complete registrations are verified automatically by the resident portal.
// Only residents with a missing (or newly uploaded) document are left for staff to review.
function statusInfo(r) {
  if (r.verified === true) return { cls: 'verified', label: 'Verified' };
  if (missingDocList(r).length) return { cls: 'pending', label: 'Missing documents' };
  return { cls: 'pending', label: 'Awaiting review' };
}

function safeImage(value) {
  var ok = typeof value === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value);
  return ok ? value : '';
}

function showToast(message) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toast.classList.add('hidden');
  }, 2800);
}

// Strict digits-only enforcement helper for phone numbers
function enforceNumericOnly(inputElement) {
  if (!inputElement) return;
  inputElement.addEventListener('input', function () {
    this.value = this.value.replace(/[^0-9]/g, '');
  });
  inputElement.addEventListener('keydown', function (e) {
    if (
      [8, 9, 13, 27, 46, 37, 38, 39, 40].indexOf(e.keyCode) !== -1 ||
      (e.ctrlKey || e.metaKey)
    ) {
      return;
    }
    if (!/^[0-9]$/.test(e.key)) {
      e.preventDefault();
    }
  });
}


// ---------- DATA (loaded from the server) ----------

var recordsCache = [];

function readRecords() {
  return recordsCache;
}

async function loadRecords(quiet) {
  try {
    var result = await adminApi('/residents');
    recordsCache = Array.isArray(result.residents) ? result.residents : [];
  } catch (e) {
    if (!quiet) handleApiError(e, 'Could not load the resident records.');
    else if (e && e.status === 401) handleApiError(e);
    return;
  }
  refreshDashboard();
}

function filteredRecords() {
  var searchInput = document.getElementById('search');
  var query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  var statusSelect = document.getElementById('statusFilter');
  var status = statusSelect ? statusSelect.value : 'all';
  var regionSelect = document.getElementById('regionFilter');
  var region = regionSelect ? regionSelect.value : 'all';
  var result = [];

  for (var i = 0; i < allRecords.length; i++) {
    var r = allRecords[i];
    var text = String(r.name || '') + ' ' + String(r.id || '') + ' ' + String(r.phone || '');
    var matchesQuery = text.toLowerCase().indexOf(query) !== -1;

    var matchesStatus = true;
    if (status === 'verified') matchesStatus = (r.verified === true);
    if (status === 'pending') matchesStatus = (r.verified !== true);
    if (status === 'missing') matchesStatus = (r.verified !== true && missingDocList(r).length > 0);
    if (status === 'submitted') matchesStatus = (r.verified !== true && missingDocList(r).length === 0);

    var matchesRegion = (region === 'all' || r.region === region);

    if (matchesQuery && matchesStatus && matchesRegion) {
      result.push(r);
    }
  }

  var sortOrder = getSettings().sortOrder;
  result.sort(function (a, b) {
    if (sortOrder === 'name') {
      return String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
    }
    var newestFirst = new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0);
    if (sortOrder === 'oldest') return -newestFirst;
    return newestFirst;
  });
  return result;
}


// ---------- DYNAMIC CALENDAR WIDGET ----------

function renderCalendar() {
  var calGrid = document.getElementById('calGrid');
  var calMonthTitle = document.getElementById('calMonthTitle');
  if (!calGrid || !calMonthTitle) return;

  var year = calViewDate.getFullYear();
  var month = calViewDate.getMonth();

  var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  calMonthTitle.textContent = monthNames[month] + ' ' + year;

  var html = '<div class="cal-dow">SU</div>' +
             '<div class="cal-dow">MO</div>' +
             '<div class="cal-dow">TU</div>' +
             '<div class="cal-dow">WE</div>' +
             '<div class="cal-dow">TH</div>' +
             '<div class="cal-dow">FR</div>' +
             '<div class="cal-dow">SA</div>';

  var firstDayIndex = new Date(year, month, 1).getDay();
  var totalDays = new Date(year, month + 1, 0).getDate();
  var prevTotalDays = new Date(year, month, 0).getDate();

  var today = new Date();
  var isCurrentMonth = (today.getFullYear() === year && today.getMonth() === month);

  for (var i = firstDayIndex - 1; i >= 0; i--) {
    var dayNum = prevTotalDays - i;
    html += '<div class="cal-day muted">' + dayNum + '</div>';
  }

  for (var d = 1; d <= totalDays; d++) {
    var isToday = (isCurrentMonth && today.getDate() === d);
    var activeClass = isToday ? ' active-date' : '';
    html += '<div class="cal-day' + activeClass + '">' + d + '</div>';
  }

  var totalCellsSoFar = firstDayIndex + totalDays;
  var nextMonthDays = (totalCellsSoFar <= 35) ? (35 - totalCellsSoFar) : (42 - totalCellsSoFar);
  
  for (var n = 1; n <= nextMonthDays; n++) {
    html += '<div class="cal-day muted">' + n + '</div>';
  }

  calGrid.innerHTML = html;
}

function setupCalendarNav() {
  var prevBtn = document.getElementById('prevMonthBtn');
  var nextBtn = document.getElementById('nextMonthBtn');

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      calViewDate.setMonth(calViewDate.getMonth() - 1);
      renderCalendar();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      calViewDate.setMonth(calViewDate.getMonth() + 1);
      renderCalendar();
    });
  }
}


// ---------- RENDER DASHBOARD & TABLES ----------

function refreshDashboard() {
  allRecords = readRecords();
  updateClearInfo();

  var pending = 0;
  var verified = 0;
  var phoneConfirmed = 0;
  var missingDocs = 0;
  var thisMonth = 0;
  var now = new Date();

  for (var i = 0; i < allRecords.length; i++) {
    var r = allRecords[i];
    if (r.verified === true) verified++;
    else pending++;

    if (r.otpConfirmed) phoneConfirmed++;

    if (missingDocList(r).length) missingDocs++;

    var d = new Date(r.registeredAt || '');
    if (!isNaN(d.getTime()) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      thisMonth++;
    }
  }

  document.getElementById('totalCount').textContent = allRecords.length;
  document.getElementById('pendingCount').textContent = pending;
  document.getElementById('verifiedCount').textContent = verified;
  document.getElementById('phoneConfirmedCount').textContent = phoneConfirmed;
  document.getElementById('missingDocCount').textContent = missingDocs;
  document.getElementById('monthCount').textContent = thisMonth;
  document.getElementById('reviewBadge').textContent = pending;

  var dashRecentBody = document.getElementById('dashRecentBody');
  var recentSorted = allRecords.slice().sort(function(a, b) {
    return new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0);
  }).slice(0, 7);

  if (recentSorted.length === 0) {
    dashRecentBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--muted); padding: 30px;">No recent registrations yet.</td></tr>';
  } else {
    var recentRows = '';
    for (var j = 0; j < recentSorted.length; j++) {
      var rec = recentSorted[j];
      var info = statusInfo(rec);
      var statusDot = '<span class="status ' + info.cls + '">' + info.label + '</span>';

      recentRows += '<tr>' +
        '<td><div class="person">' +
          '<span class="person-mark">' + escapeHtml(initial(rec.name)) + '</span>' +
          '<span class="person-name">' + escapeHtml(rec.name || 'Unnamed resident') + '</span>' +
        '</div></td>' +
        '<td>' + escapeHtml(rec.id || 'BAC-2026-XXXX') + '</td>' +
        '<td>' + escapeHtml(dateText(rec.registeredAt)) + '</td>' +
        '<td>' + statusDot + '</td>' +
        '</tr>';
    }
    dashRecentBody.innerHTML = recentRows;
  }

  var attentionFeed = document.getElementById('attentionFeed');
  var pendingList = allRecords.filter(function(r) { return !r.verified; }).slice(0, 4);

  if (pendingList.length === 0) {
    attentionFeed.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--muted);">Nothing needs review. Complete registrations are verified automatically.</div>';
  } else {
    var feedHtml = '';
    for (var k = 0; k < pendingList.length; k++) {
      var p = pendingList[k];
      feedHtml += '<div class="attention-item">' +
        '<div class="att-top">' +
          '<span class="att-mark">' + escapeHtml(initial(p.name)) + '</span>' +
          '<div class="att-info">' +
            '<h4>' + escapeHtml(p.name || 'Resident') + '</h4>' +
            '<div class="att-date">' + escapeHtml(dateText(p.registeredAt)) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="att-desc">' + escapeHtml(missingDocList(p).length ? 'Missing: ' + missingDocList(p).join(', ') : 'Documents submitted, ready for review') + '</div>' +
        '<div class="att-btn-wrap"><button class="btn btn-primary btn-sm" type="button" data-review-id="' + escapeHtml(p.id) + '">Review</button></div>' +
        '</div>';
    }
    attentionFeed.innerHTML = feedHtml;

    var reviewButtons = attentionFeed.querySelectorAll('[data-review-id]');
    for (var b = 0; b < reviewButtons.length; b++) {
      reviewButtons[b].addEventListener('click', function() {
        var idToReview = this.getAttribute('data-review-id');
        var foundRecord = null;
        for (var idx = 0; idx < allRecords.length; idx++) {
          if (allRecords[idx].id === idToReview) {
            foundRecord = allRecords[idx];
            break;
          }
        }
        if (foundRecord) openRecord(foundRecord);
      });
    }
  }

  renderRecordsTable();
}

function renderRecordsTable() {
  var settings = getSettings();
  shownRecords = filteredRecords();

  var body = document.getElementById('recordsBody');
  var word = shownRecords.length === 1 ? 'record' : 'records';
  var resultCountEl = document.getElementById('resultCount');
  if (resultCountEl) {
    resultCountEl.textContent = shownRecords.length + ' ' + word;
  }

  if (!body) return;

  if (shownRecords.length === 0) {
    body.innerHTML = '<tr><td colspan="6"><div class="empty">' +
      '<div class="empty-icon" aria-hidden="true">⌕</div>' +
      '<h3>No matching residents</h3><p>Try changing search or filters.</p></div></td></tr>';
    return;
  }

  var rows = '';
  for (var j = 0; j < shownRecords.length; j++) {
    var rec = shownRecords[j];
    var docs = 3 - missingDocList(rec).length;

    var info = statusInfo(rec);
    var statusClass = info.cls;
    var statusLabel = info.label;
    var docWord = docs === 1 ? 'document' : 'documents';
    var displayId = settings.maskSensitive ? maskId(rec.id) : (rec.id || 'No ID number');

    rows += '<tr>' +
      '<td><div class="person">' +
        '<span class="person-mark">' + escapeHtml(initial(rec.name)) + '</span>' +
        '<div><div class="person-name">' + escapeHtml(rec.name || 'Unnamed resident') + '</div>' +
        '<div class="person-id">' + escapeHtml(displayId) + '</div></div>' +
      '</div></td>' +
      '<td>' + escapeHtml(regionName(rec.region)) + '</td>' +
      '<td>' + escapeHtml(dateText(rec.registeredAt)) + '</td>' +
      '<td>' + docs + ' of 3 ' + docWord + '</td>' +
      '<td><span class="status ' + statusClass + '">' + statusLabel + '</span></td>' +
      '<td><button class="row-action" type="button" data-record-index="' + j + '">Review <span aria-hidden="true">→</span></button></td>' +
      '</tr>';
  }
  body.innerHTML = rows;

  var buttons = body.querySelectorAll('[data-record-index]');
  for (var k = 0; k < buttons.length; k++) {
    buttons[k].addEventListener('click', function () {
      var index = Number(this.getAttribute('data-record-index'));
      openRecord(shownRecords[index]);
    });
  }
}


// ---------- POPUP (DIALOG) ----------

function closeDialog() {
  document.getElementById('dialogRoot').innerHTML = '';
}

function photoHtml(value, label) {
  var src = safeImage(value);
  if (src) {
    return '<img src="' + src + '" alt="' + label + '">';
  }
  return '<div class="photo-missing">No document submitted</div>';
}

async function openRecord(summary) {
  if (!summary) return;
  var record = summary;
  try {
    // The list has no photo data, so the full record (ID, face, signature) is fetched when it is opened.
    record = (await adminApi('/residents/' + encodeURIComponent(summary.id))).resident;
  } catch (e) {
    handleApiError(e, 'Could not open this record.');
    return;
  }

  var root = document.getElementById('dialogRoot');
  var missingList = missingDocList(record);
  var verifyText = record.verified
    ? (record.verificationSource === 'auto-verified' ? 'Verified automatically (complete registration)' : 'Verified' + (record.verifiedBy ? ' by ' + record.verifiedBy : ''))
    : (missingList.length ? 'Missing documents: ' + missingList.join(', ') : 'Awaiting staff review');
  var buttonClass = record.verified ? 'btn' : 'btn btn-primary';
  var buttonText = record.verified ? 'Mark as awaiting review' : 'Confirm resident identity';

  root.innerHTML =
    '<div class="overlay" id="overlay">' +
      '<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialogTitle">' +
        '<header class="dialog-head">' +
          '<div><h2 id="dialogTitle">Resident verification</h2><p>' + escapeHtml(record.id || 'No civil ID number') + '</p></div>' +
          '<button class="close" type="button" aria-label="Close details">×</button>' +
        '</header>' +
        '<div class="dialog-body">' +
          '<div class="detail-grid">' +
            '<div><div class="detail-label">Full name</div><div class="detail-value">' + escapeHtml(record.name || '—') + '</div></div>' +
            '<div><div class="detail-label">Date of birth</div><div class="detail-value">' + escapeHtml(dateText(record.dob)) + '</div></div>' +
            '<div><div class="detail-label">Sex</div><div class="detail-value">' + escapeHtml(record.sex || '—') + '</div></div>' +
            '<div><div class="detail-label">Barangay</div><div class="detail-value">' + escapeHtml(regionName(record.region)) + '</div></div>' +
            '<div><div class="detail-label">Address</div><div class="detail-value">' + escapeHtml(record.address || '—') + '</div></div>' +
            '<div><div class="detail-label">Phone</div><div class="detail-value">' + escapeHtml(record.phone || '—') + '</div></div>' +
            '<div><div class="detail-label">Registered</div><div class="detail-value">' + escapeHtml(dateText(record.registeredAt)) + '</div></div>' +
            '<div><div class="detail-label">Verification</div><div class="detail-value">' + escapeHtml(verifyText) + '</div></div>' +
          '</div>' +
          '<div class="photos">' +
            '<div class="photo-box"><h3>Government ID document</h3>' + photoHtml(record.idPhoto, 'Submitted government ID') + '</div>' +
            '<div class="photo-box"><h3>Resident face photo</h3>' + photoHtml(record.facePhoto, 'Submitted face photo') + '</div>' +
          '</div>' +
        '</div>' +
        '<footer class="dialog-foot">' +
          '<span class="dialog-foot-note">Changes are saved to the registry database.</span>' +
          '<button class="' + buttonClass + '" type="button" id="verificationAction">' + buttonText + '</button>' +
        '</footer>' +
      '</section>' +
    '</div>';

  root.querySelector('.close').addEventListener('click', closeDialog);
  root.querySelector('#overlay').addEventListener('click', function (event) {
    if (event.target.id === 'overlay') closeDialog();
  });
  root.querySelector('#verificationAction').addEventListener('click', function () {
    if (getSettings().confirmVerify) {
      var promptMsg = record.verified
        ? 'Return ' + (record.name || 'this resident') + ' to awaiting review?'
        : 'Confirm identity verification for ' + (record.name || 'this resident') + '?';
      if (!confirm(promptMsg)) return;
    }
    updateVerification(record.id, !record.verified);
  });
  root.querySelector('.close').focus();
}

async function updateVerification(id, verified) {
  var updated;
  try {
    updated = (await adminApi('/residents/' + encodeURIComponent(id) + '/verify', { body: { verified: verified } })).resident;
  } catch (e) {
    if (e && e.status === 404) {
      showToast('Record no longer exists.');
      closeDialog();
      loadRecords();
      return;
    }
    handleApiError(e, 'Could not save the updated record.');
    return;
  }

  for (var i = 0; i < recordsCache.length; i++) {
    if (recordsCache[i].id === id) { recordsCache[i] = updated; break; }
  }

  closeDialog();
  refreshDashboard();
  showToast(verified ? 'Resident marked as verified.' : 'Verification status returned to review.');
}


// ---------- EXPORT CSV ----------

function exportCsv() {
  var records = filteredRecords();
  if (records.length === 0) {
    records = readRecords();
  }
  if (records.length === 0) {
    showToast('There are no records to export.');
    return;
  }

  var columns = ['Civil ID', 'Full name', 'Date of birth', 'Sex', 'Barangay', 'Address', 'Phone', 'Phone confirmed', 'ID document submitted', 'Face photo submitted', 'Verified', 'Registered'];
  var lines = [columns.join(',')];

  for (var i = 0; i < records.length; i++) {
    var r = records[i];
    var row = [
      r.id, r.name, r.dob, r.sex, regionName(r.region),
      r.address, r.phone, r.otpConfirmed ? 'Yes' : 'No',
      hasDoc(r, 'idPhoto') ? 'Yes' : 'No', hasDoc(r, 'facePhoto') ? 'Yes' : 'No',
      r.verified ? 'Yes' : 'No', r.registeredAt
    ];

    var cells = [];
    for (var j = 0; j < row.length; j++) {
      var value = (row[j] === null || row[j] === undefined) ? '' : String(row[j]);
      cells.push('"' + value.replace(/"/g, '""') + '"');
    }
    lines.push(cells.join(','));
  }

  var csv = lines.join('\r\n');
  var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);

  var link = document.createElement('a');
  link.href = url;
  link.download = 'bacolor-civil-id-records.csv';
  link.click();
  URL.revokeObjectURL(url);

  showToast(records.length + ' records exported.');
}


// ---------- SETTINGS & THEME ----------

function getSettings() {
  var settings = {};
  for (var key in DEFAULT_SETTINGS) {
    settings[key] = DEFAULT_SETTINGS[key];
  }

  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (var name in saved) {
      if (name in DEFAULT_SETTINGS) {
        settings[name] = saved[name];
      }
    }
  } catch (e) {}
  return settings;
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applyTheme(theme) {
  var isDark = (theme === 'dark');
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  var themeIcon = document.getElementById('themeIcon');
  var themeLabel = document.getElementById('themeLabel');
  var themeSelect = document.getElementById('setTheme');

  if (themeIcon) themeIcon.textContent = isDark ? '☀' : '☾';
  if (themeLabel) themeLabel.textContent = isDark ? 'Light mode' : 'Dark mode';
  if (themeSelect) themeSelect.value = isDark ? 'dark' : 'light';
}

function toggleTheme() {
  var settings = getSettings();
  settings.theme = (settings.theme === 'dark') ? 'light' : 'dark';
  saveSettings(settings);
  applyTheme(settings.theme);
  showToast(settings.theme === 'dark' ? 'Dark mode enabled.' : 'Light mode enabled.');
}

function applySettings() {
  var settings = getSettings();
  applyTheme(settings.theme);

  if (settings.compact) {
    document.body.classList.add('compact');
  } else {
    document.body.classList.remove('compact');
  }

  var sortLabels = {
    newest: 'newest registration',
    oldest: 'oldest registration',
    name: 'name (A to Z)'
  };
  var sortNoteEl = document.getElementById('sortNote');
  if (sortNoteEl) {
    sortNoteEl.textContent = 'Sorted by ' + (sortLabels[settings.sortOrder] || sortLabels.newest);
  }

  setupIdleTimer(settings.idleMinutes);
}

function showUser() {
  var avatarEl = document.getElementById('avatar');
  var loggedInEl = document.getElementById('loggedInText');
  var sidebarAdminEl = document.getElementById('sidebarAdminName');
  var welcomeBackEl = document.getElementById('welcomeBackText');

  if (avatarEl) avatarEl.textContent = initial(currentSession.name);
  if (loggedInEl) loggedInEl.textContent = 'Logged in as ' + currentSession.name;
  if (sidebarAdminEl) sidebarAdminEl.textContent = currentSession.name;
  if (welcomeBackEl) welcomeBackEl.textContent = ('WELCOME BACK, ' + currentSession.name).toUpperCase();
}


// ---------- VIEW & NAVIGATION LOGIC ----------

function showSettingsTab(tabKey) {
  var tabs = document.querySelectorAll('.settings-tab');
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    if (t.getAttribute('data-settings-tab') === tabKey) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  }

  var panes = document.querySelectorAll('.settings-pane');
  for (var j = 0; j < panes.length; j++) {
    panes[j].classList.add('hidden');
  }

  var activePane = document.getElementById('pane' + tabKey.charAt(0).toUpperCase() + tabKey.slice(1));
  if (activePane) {
    activePane.classList.remove('hidden');
  }
}

function updateRecordsHeaderTitle() {
  var statusFilter = document.getElementById('statusFilter');
  var titleEl = document.getElementById('recordsTitle');
  var subtitleEl = document.getElementById('recordsSubtitle');
  if (!statusFilter || !titleEl || !subtitleEl) return;

  if (statusFilter.value === 'pending') {
    titleEl.textContent = 'Review desk';
    subtitleEl.textContent = 'Review pending resident registrations and verification documents.';
  } else {
    titleEl.textContent = 'Resident records';
    subtitleEl.textContent = 'Review registration details and verification documents.';
  }
}

function showView(viewName, filterStatus) {
  var overview = document.getElementById('viewOverview');
  var recordsView = document.getElementById('viewRecords');
  var settingsView = document.getElementById('viewSettings');

  if (overview) overview.classList.add('hidden');
  if (recordsView) recordsView.classList.add('hidden');
  if (settingsView) settingsView.classList.add('hidden');

  if (viewName === 'overview') {
    if (overview) overview.classList.remove('hidden');
    refreshDashboard();
  } else if (viewName === 'records') {
    if (recordsView) recordsView.classList.remove('hidden');
    if (filterStatus) {
      var statusSelect = document.getElementById('statusFilter');
      if (statusSelect) statusSelect.value = filterStatus;
    }
    updateRecordsHeaderTitle();
    renderRecordsTable();
  } else if (viewName === 'settings') {
    if (settingsView) settingsView.classList.remove('hidden');
    showSettingsTab('profile');
    fillSettingsForms();
  }
}

function fillSettingsForms() {
  document.getElementById('setName').value = currentSession.name || '';
  document.getElementById('setUsername').value = currentSession.username || '';
  document.getElementById('setPhone').value = currentSession.phone || '';

  var settings = getSettings();
  document.getElementById('setTheme').value = settings.theme;
  document.getElementById('setSort').value = settings.sortOrder;
  document.getElementById('setCompact').checked = settings.compact;
  document.getElementById('setWelcome').checked = settings.welcome;

  document.getElementById('setIdle').value = String(settings.idleMinutes);
  document.getElementById('setMaskSensitive').checked = settings.maskSensitive;
  document.getElementById('setConfirmVerify').checked = settings.confirmVerify;

  updateClearInfo();
}

function updateClearInfo() {
  var count = readRecords().length;
  var word = count === 1 ? 'resident record is' : 'resident records are';
  var clearInfoEl = document.getElementById('clearInfo');
  if (clearInfoEl) {
    clearInfoEl.textContent = count + ' ' + word + ' saved in the registry database.';
  }
}


// ---------- SETTINGS FORM HANDLERS ----------

async function saveProfile(event) {
  event.preventDefault();
  var name = document.getElementById('setName').value.trim();
  var phone = document.getElementById('setPhone').value.trim();
  if (name === '') {
    showToast('Please enter your full name.');
    return;
  }

  try {
    var admin = (await adminApi('/profile', { body: { name: name, phone: phone } })).admin;
    currentSession.name = admin.name;
    currentSession.phone = admin.phone;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    showUser();
    showToast('Profile updated.');
  } catch (e) {
    handleApiError(e, 'Could not update your profile.');
  }
}

async function changePassword(event) {
  event.preventDefault();
  var currentPass = document.getElementById('setCurrentPass').value;
  var newPass = document.getElementById('setNewPass').value;
  var confirmPass = document.getElementById('setConfirmPass').value;

  if (newPass.length < 8) {
    showToast('New password must be at least 8 characters.');
    return;
  }
  if (newPass !== confirmPass) {
    showToast('New passwords do not match.');
    return;
  }

  try {
    await adminApi('/change-password', { body: { current: currentPass, password: newPass } });
    document.getElementById('passwordForm').reset();
    showToast('Password updated.');
  } catch (e) {
    handleApiError(e, 'Could not update your password.');
  }
}

function savePreferences(event) {
  event.preventDefault();
  var settings = getSettings();
  settings.theme = document.getElementById('setTheme').value;
  settings.sortOrder = document.getElementById('setSort').value;
  settings.compact = document.getElementById('setCompact').checked;
  settings.welcome = document.getElementById('setWelcome').checked;
  saveSettings(settings);
  applySettings();
  refreshDashboard();
  showToast('Appearance & preferences saved.');
}

function savePrivacy(event) {
  event.preventDefault();
  var settings = getSettings();
  settings.idleMinutes = Number(document.getElementById('setIdle').value);
  settings.maskSensitive = document.getElementById('setMaskSensitive').checked;
  settings.confirmVerify = document.getElementById('setConfirmVerify').checked;
  saveSettings(settings);
  applySettings();
  refreshDashboard();
  showToast('Privacy settings saved.');
}

function resetAllSettings() {
  if (!confirm('Reset all settings to their defaults?')) return;
  saveSettings(DEFAULT_SETTINGS);
  applySettings();
  fillSettingsForms();
  refreshDashboard();
  showToast('Settings reset to default.');
}

async function clearAllRecords() {
  var count = readRecords().length;
  if (count === 0) {
    showToast('There are no records to clear.');
    return;
  }
  if (!confirm('Permanently delete all ' + count + ' resident records from the registry database? This cannot be undone.')) return;
  try {
    await adminApi('/clear-residents', { body: {} });
  } catch (e) {
    handleApiError(e, 'Could not clear the records.');
    return;
  }
  recordsCache = [];
  refreshDashboard();
  showToast('All resident records were cleared.');
}


// ---------- INACTIVITY TIMER ----------

function resetIdle() { lastActivity = Date.now(); }

function setupIdleTimer(minutes) {
  idleMinutes = Number(minutes) || 0;
  lastActivity = Date.now();
  if (idleChecker) { clearInterval(idleChecker); idleChecker = null; }
  if (idleMinutes > 0) {
    idleChecker = setInterval(function() {
      if ((Date.now() - lastActivity) / 60000 >= idleMinutes) {
        sessionStorage.setItem('ncrs_notice', 'You were logged out because of inactivity.');
        logout();
      }
    }, 10000);
  }
}


// ---------- START EVERYTHING ----------

function startDashboard() {
  showUser();

  var sealImg = document.getElementById('sealImg');
  var sealFallback = document.getElementById('sealFallback');
  function showFallbackSeal() {
    if (sealImg) sealImg.style.display = 'none';
    if (sealFallback) sealFallback.classList.add('show');
  }
  if (sealImg) {
    sealImg.addEventListener('error', showFallbackSeal);
    if (sealImg.complete && sealImg.naturalWidth === 0) showFallbackSeal();
  }

  var regionSelect = document.getElementById('regionFilter');
  if (regionSelect) {
    for (var i = 0; i < REGIONS.length; i++) {
      var option = document.createElement('option');
      option.value = REGIONS[i][0];
      option.textContent = REGIONS[i][1];
      regionSelect.appendChild(option);
    }
  }

  // Enforce numbers-only strictly on mobile input field
  enforceNumericOnly(document.getElementById('setPhone'));

  var searchInput = document.getElementById('search');
  if (searchInput) searchInput.addEventListener('input', renderRecordsTable);

  var statusSelect = document.getElementById('statusFilter');
  if (statusSelect) {
    statusSelect.addEventListener('change', function() {
      updateRecordsHeaderTitle();
      renderRecordsTable();
    });
  }

  if (regionSelect) regionSelect.addEventListener('change', renderRecordsTable);

  var exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);

  var sidebarExportBtn = document.getElementById('sidebarExportBtn');
  if (sidebarExportBtn) sidebarExportBtn.addEventListener('click', exportCsv);

  var themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

  var setThemeSelect = document.getElementById('setTheme');
  if (setThemeSelect) {
    setThemeSelect.addEventListener('change', function () {
      var selectedTheme = this.value;
      var settings = getSettings();
      settings.theme = selectedTheme;
      saveSettings(settings);
      applyTheme(selectedTheme);
      showToast(selectedTheme === 'dark' ? 'Dark mode enabled.' : 'Light mode enabled.');
    });
  }

  var navButtons = document.querySelectorAll('.nav-item[data-view]');
  for (var n = 0; n < navButtons.length; n++) {
    navButtons[n].addEventListener('click', function () {
      var all = document.querySelectorAll('.nav-item');
      for (var m = 0; m < all.length; m++) all[m].classList.remove('active');
      this.classList.add('active');

      var viewTarget = this.getAttribute('data-view');
      var filterStatus = this.getAttribute('data-filter');
      showView(viewTarget, filterStatus);
    });
  }

  var settingsTabs = document.querySelectorAll('[data-settings-tab]');
  for (var s = 0; s < settingsTabs.length; s++) {
    settingsTabs[s].addEventListener('click', function () {
      showSettingsTab(this.getAttribute('data-settings-tab'));
    });
  }

  var profileForm = document.getElementById('profileForm');
  if (profileForm) profileForm.addEventListener('submit', saveProfile);

  var passwordForm = document.getElementById('passwordForm');
  if (passwordForm) passwordForm.addEventListener('submit', changePassword);

  var prefsForm = document.getElementById('prefsForm');
  if (prefsForm) prefsForm.addEventListener('submit', savePreferences);

  var privacyForm = document.getElementById('privacyForm');
  if (privacyForm) privacyForm.addEventListener('submit', savePrivacy);

  var resetSettingsBtn = document.getElementById('resetSettingsBtn');
  if (resetSettingsBtn) resetSettingsBtn.addEventListener('click', resetAllSettings);

  var clearRecordsBtn = document.getElementById('clearRecordsBtn');
  if (clearRecordsBtn) clearRecordsBtn.addEventListener('click', clearAllRecords);

  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDialog(); });
  document.addEventListener('mousemove', resetIdle);
  document.addEventListener('keydown', resetIdle);
  document.addEventListener('click', resetIdle);

  window.addEventListener('storage', function (event) {
    if (event.key === SETTINGS_KEY) { applySettings(); refreshDashboard(); }
  });

  // Only the main administrator may wipe the registry.
  var clearBtn = document.getElementById('clearRecordsBtn');
  if (clearBtn && currentSession.role !== 'superadmin') clearBtn.style.display = 'none';

  // Pick up new registrations without a page reload.
  setInterval(function () {
    if (!document.hidden) loadRecords(true);
  }, 60000);

  setupCalendarNav();
  renderCalendar();

  applySettings();
  refreshDashboard();
  loadRecords();

  if (getSettings().welcome) {
    showToast('WELCOME BACK, ' + currentSession.name.toUpperCase() + '!');
  }
}

currentSession = getSession();
if (currentSession && currentSession.token) {
  adminApi('/me').then(function (result) {
    currentSession.name = result.admin.name;
    currentSession.username = result.admin.username;
    currentSession.phone = result.admin.phone;
    currentSession.role = result.admin.role;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    startDashboard();
  }, function (error) {
    if (error && error.status === 401) {
      goToLogin('Your session has ended. Please sign in again.');
    } else {
      document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">Could not reach the server. Please refresh the page.</p>';
    }
  });
} else {
  goToLogin();
}
