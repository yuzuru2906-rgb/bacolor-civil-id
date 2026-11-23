// ===========================
// Bacolor Civil ID Portal
// script.js  (admin sign-in + register page)
// ===========================

var SESSION_KEY = 'ncrs_session';
var DASHBOARD_PAGE = 'admin-dashboard.html';

// ---------- talking to the server ----------

async function adminRequest(path, options) {
  options = options || {};
  var headers = { 'Accept': 'application/json' };
  var init = { method: options.method || (options.body !== undefined ? 'POST' : 'GET'), headers: headers };
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  var response;
  try {
    response = await fetch('/api/admin' + path, init);
  } catch (e) {
    throw new Error('Could not reach the server. Check your internet connection and try again.');
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

function showToast(msg) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 2800);
}

function loginAndGoToDashboard(result) {
  var session = {
    name: result.admin.name,
    role: 'admin',
    username: result.admin.username,
    token: result.token
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  window.location.href = DASHBOARD_PAGE;
}

// Digits-only helper for the mobile number box
function enforceNumericOnly(inputElement) {
  if (!inputElement) return;

  // Clean the value if anything non-numeric gets through (e.g. pasting)
  inputElement.addEventListener('input', function () {
    this.value = this.value.replace(/[^0-9]/g, '');
  });

  // Block non-digit keypresses before they appear in the field
  inputElement.addEventListener('keydown', function (e) {
    var allowedKeys = [8, 9, 13, 27, 46, 37, 38, 39, 40];
    if (allowedKeys.indexOf(e.keyCode) !== -1 || e.ctrlKey || e.metaKey) return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  });
}

function setupAuthHandlers() {
  var tabLogin = document.getElementById('tabLogin');
  var tabRegister = document.getElementById('tabRegister');
  var formLogin = document.getElementById('formLogin');
  var formRegister = document.getElementById('formRegister');

  tabLogin.addEventListener('click', function () {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    formLogin.classList.add('active-form');
    formRegister.classList.remove('active-form');
  });

  tabRegister.addEventListener('click', function () {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    formRegister.classList.add('active-form');
    formLogin.classList.remove('active-form');
  });

  // Password visibility toggle buttons
  var toggleBtns = document.querySelectorAll('.toggle-pass-btn');
  for (var t = 0; t < toggleBtns.length; t++) {
    toggleBtns[t].addEventListener('click', function () {
      var inputField = document.getElementById(this.getAttribute('data-target'));
      if (!inputField) return;
      if (inputField.type === 'password') {
        inputField.type = 'text';
        this.textContent = '👁‍🗨';
        this.setAttribute('aria-label', 'Hide password');
      } else {
        inputField.type = 'password';
        this.textContent = '👁';
        this.setAttribute('aria-label', 'Show password');
      }
    });
  }

  formLogin.addEventListener('submit', async function (e) {
    e.preventDefault();
    var button = formLogin.querySelector('button[type="submit"]');
    var username = document.getElementById('loginUser').value.trim();
    var password = document.getElementById('loginPass').value;

    button.disabled = true;
    try {
      var result = await adminRequest('/login', { body: { username: username, password: password } });
      loginAndGoToDashboard(result);
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });

  formRegister.addEventListener('submit', async function (e) {
    e.preventDefault();
    var button = formRegister.querySelector('button[type="submit"]');
    var name = document.getElementById('regName').value.trim();
    var username = document.getElementById('regUsername').value.trim();
    var phone = document.getElementById('regPhone').value.trim();
    var password = document.getElementById('regPass').value;
    var confirmPass = document.getElementById('regPassConfirm').value;
    var code = document.getElementById('regCode').value.trim();

    if (password !== confirmPass) {
      alert('Passwords do not match. Please try again.');
      return;
    }

    button.disabled = true;
    try {
      var result = await adminRequest('/register', {
        body: { name: name, username: username, phone: phone, password: password, code: code }
      });
      formRegister.reset();
      document.getElementById('loginUser').value = result.username;
      document.getElementById('loginPass').value = '';
      tabLogin.click();
      showToast('Admin account created for ' + result.name + '. You can now sign in.');
    } catch (error) {
      alert(error.message);
    }
    button.disabled = false;
  });
}

document.addEventListener('DOMContentLoaded', async function () {
  // Already signed in? Check with the server before skipping the login page.
  var saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
  if (saved && saved.token) {
    try {
      await adminRequest('/me', { token: saved.token });
      window.location.href = DASHBOARD_PAGE;
      return;
    } catch (error) {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  setupAuthHandlers();
  enforceNumericOnly(document.getElementById('regPhone'));

  var notice = sessionStorage.getItem('ncrs_notice');
  if (notice) {
    showToast(notice);
    sessionStorage.removeItem('ncrs_notice');
  }
});
