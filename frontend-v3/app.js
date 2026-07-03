'use strict';

var API      = 'https://api.dev-lists.elliscode.com'; // TODO: change to api.lists.elliscode.com for prod
var APP_HOST = 'https://lists.elliscode.com';     // TODO: change to lists.elliscode.com for prod

var SETTING_LABELS = {
  listOrder:   { alpha: 'Alphabetical', date: 'Date Added' },
  itemOrder:   { alpha: 'Alphabetical', date: 'Date Updated' },
  displayMode: { light: 'Light',        dark: 'Dark' }
};

var settings = {
  listOrder:   localStorage.getItem('listOrder')   || 'alpha',
  itemOrder:   localStorage.getItem('itemOrder')   || 'alpha',
  displayMode: localStorage.getItem('displayMode') || 'light'
};

var state = {
  email: null,
  csrf: localStorage.getItem('csrf') || null,
  allLists: {},
  listCache: {},
  currentListName: null,
  currentListId: null,
  currentList: {}
};

var pendingShare = null;
var isKaiosShareHandoff = false;
var _listFetchController = null;
var _otpRequestInFlight = false;

if (navigator.mozSetMessageHandler) {
  navigator.mozSetMessageHandler('activity', function (activity) {
    var url = activity.source && activity.source.data && activity.source.data.url;
    if (url) {
      var match = url.match(/[?&]share=([^&]+)/);
      if (match) pendingShare = match[1];
    }
  });
}

// ─── IndexedDB persistence ────────────────────────────────────────────────────

var db = null;
var DB_NAME = 'shared-list-cache';
var DB_VERSION = 1;
var DB_STORE = 'lists';

function openDB(callback) {
  var req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = function (e) {
    e.target.result.createObjectStore(DB_STORE, { keyPath: 'name' });
  };
  req.onsuccess = function (e) {
    db = e.target.result;
    callback(null);
  };
  req.onerror = function () {
    callback(req.error);
  };
}

function dbLoadAll(callback) {
  if (!db) { callback({}); return; }
  var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).getAll();
  req.onsuccess = function () {
    var cache = {};
    (req.result || []).forEach(function (row) { cache[row.name] = row; });
    callback(cache);
  };
  req.onerror = function () { callback({}); };
}

function dbSaveList(name, listId, list) {
  if (!db) return;
  db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put({ name: name, list_id: listId, list: list });
}

function dbDeleteList(name) {
  if (!db) return;
  db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(name);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function post(path, body, signal) {
  return fetch(API + path, {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(body),
    signal: signal || null
  });
}

var _statusTimer = null;
function showStatus(msg, isError) {
  var el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status-toast ' + (isError ? 'error' : 'info');
  el.setAttribute('visible', 'true');
  clearTimeout(_statusTimer);
  _statusTimer = setTimeout(function () {
    el.removeAttribute('visible');
  }, 3000);
}

function applySettings() {
  document.body.classList.toggle('dark', settings.displayMode === 'dark');
}

// ─── Panel & Softkey ──────────────────────────────────────────────────────────

function showPanel(id) {
  var panels = document.querySelectorAll('.panel');
  for (var i = 0; i < panels.length; i++) {
    panels[i].setAttribute('active', 'false');
  }
  var panel = document.getElementById(id);
  panel.setAttribute('active', 'true');
  window.scrollTo(0, 0);
  var first = panel.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
}

function setSoftkeys(left, center, right) {
  document.getElementById('sk-left').textContent = left;
  document.getElementById('sk-center').textContent = center;
  document.getElementById('sk-right').textContent = right;
}

// ─── D-pad Navigation ─────────────────────────────────────────────────────────

function activePanel() {
  return document.querySelector('.panel[active="true"]');
}

function selectables() {
  if (isSheetOpen()) {
    return Array.prototype.slice.call(document.querySelectorAll('#sheet [nav-selectable="true"]'));
  }
  var panel = activePanel();
  if (!panel) return [];
  var navEls = Array.prototype.slice.call(panel.querySelectorAll('[nav-selectable="true"]'));
  var adEls  = Array.prototype.slice.call(panel.querySelectorAll('.nav-selectable-ad'));
  return adEls.concat(navEls);
}

function focused() {
  return document.querySelector('[nav-selected="true"]');
}

var SOFTKEY_H = 30;

function setFocus(el) {
  if (!el) return;
  var prev = focused();
  if (prev) prev.removeAttribute('nav-selected');
  el.setAttribute('nav-selected', 'true');
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  el.focus();
  scrollToVisible(el);
  updateListsSoftkey(el);
}

function updateListsSoftkey(el) {
  if (isSheetOpen()) return;
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-lists') {
    if (el.hasAttribute('data-list-name')) {
      setSoftkeys('Share', 'OPEN', 'Options');
    } else if (el.hasAttribute('data-new-list')) {
      setSoftkeys('', 'CREATE', 'Options');
    } else {
      setSoftkeys('', 'OPEN', 'Options');
    }
  } else if (panel.id === 'panel-list') {
    if (el.classList.contains('sweep-row')) {
      setSoftkeys('Back', 'CLEAR', 'Add');
    } else if (el.classList.contains('delete-list-row')) {
      setSoftkeys('Back', 'DELETE', 'Add');
    } else {
      setSoftkeys('Back', 'CHECK', 'Add');
    }
  } else if (panel.id === 'panel-email') {
    if (el.id === 'btn-email-privacy') {
      setSoftkeys('', 'INFO', '');
    } else {
      setSoftkeys('', 'NEXT', '');
    }
  }
}

function scrollToVisible(el) {
  var container = el.closest('.panel-content') || el.closest('#sheet');
  var elRect = el.getBoundingClientRect();
  if (container && getComputedStyle(container).overflowY !== 'visible') {
    var cRect = container.getBoundingClientRect();
    if (elRect.bottom + SOFTKEY_H > cRect.bottom)
      container.scrollTop += elRect.bottom + SOFTKEY_H - cRect.bottom;
    else if (elRect.top < cRect.top)
      container.scrollTop -= cRect.top - elRect.top;
  } else {
    var firstNavEl = document.querySelector('.panel[active="true"] [nav-selectable="true"]');
    if (el.classList.contains('nav-selectable-ad') || el === firstNavEl) {
      window.scrollTo(0, 0);
      return;
    }
    if (elRect.bottom + SOFTKEY_H > window.innerHeight)
      window.scrollBy(0, elRect.bottom + SOFTKEY_H - window.innerHeight);
    else if (elRect.top < 0)
      window.scrollBy(0, elRect.top);
  }
}

function moveFocus(dir) {
  var els = selectables();
  if (!els.length) return;
  var cur = focused();
  var idx = els.indexOf(cur);
  var next;
  if (dir === 'down') {
    next = (idx >= 0 && idx < els.length - 1) ? els[idx + 1] : els[0];
  } else {
    next = (idx > 0) ? els[idx - 1] : els[els.length - 1];
  }
  setFocus(next);
}

// ─── Bottom Sheet ─────────────────────────────────────────────────────────────

var _sheetSavedSoftkeys = ['', '', ''];
var _sheetSavedFocus = null;

function isSheetOpen() {
  return document.getElementById('sheet').getAttribute('active') === 'true';
}

function openSheet(items, header) {
  _sheetSavedFocus = focused();

  var sheetHeader = document.getElementById('sheet-header');
  if (header) {
    document.getElementById('sheet-title').textContent = header.title;
    document.getElementById('sheet-note').textContent = header.note;
    sheetHeader.setAttribute('active', 'true');
  } else {
    sheetHeader.setAttribute('active', 'false');
  }

  var ul = document.getElementById('sheet-ul');
  ul.innerHTML = '';
  items.forEach(function (item) {
    var li = document.createElement('li');
    li.className = 'list-row' + (item.danger ? ' danger' : '');
    li.setAttribute('nav-selectable', 'true');
    li.textContent = item.label;
    li.addEventListener('click', item.action);
    ul.appendChild(li);
  });
  _sheetSavedSoftkeys = [
    document.getElementById('sk-left').textContent,
    document.getElementById('sk-center').textContent,
    document.getElementById('sk-right').textContent
  ];
  document.getElementById('sheet').setAttribute('active', 'true');
  document.getElementById('sheet-overlay').setAttribute('active', 'true');
  setSoftkeys('Back', 'SELECT', '');
  var first = ul.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
}

function closeSheet() {
  document.getElementById('sheet').setAttribute('active', 'false');
  document.getElementById('sheet-overlay').setAttribute('active', 'false');
  document.getElementById('sheet-ul').innerHTML = '';
  setSoftkeys(_sheetSavedSoftkeys[0], _sheetSavedSoftkeys[1], _sheetSavedSoftkeys[2]);
  var restore = _sheetSavedFocus;
  _sheetSavedFocus = null;
  if (!restore) {
    var panel = activePanel();
    if (panel) restore = panel.querySelector('[nav-selectable="true"]');
  }
  if (restore) setFocus(restore);
}

// ─── Key Handling ─────────────────────────────────────────────────────────────

document.addEventListener('mousedown', function () {
  document.body.classList.remove('using-keyboard');
}, true);

document.addEventListener('touchstart', function () {
  document.body.classList.remove('using-keyboard');
}, { passive: true, capture: true });

document.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
      e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    document.body.classList.add('using-keyboard');
  }
  if (isSheetOpen()) {
    switch (e.key) {
      case 'ArrowUp':   e.preventDefault(); moveFocus('up');   break;
      case 'ArrowDown': e.preventDefault(); moveFocus('down'); break;
      case 'Enter':     e.preventDefault(); interact(focused()); break;
      case 'SoftLeft':
      case 'Backspace': e.preventDefault(); closeSheet(); break;
    }
    return;
  }
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault();
      if (isTextInput(document.activeElement)) {
        var _el = document.activeElement;
        try {
          if (_el.selectionStart === 0 && _el.selectionEnd === 0) {
            moveFocus('up');
          } else {
            _el.setSelectionRange(0, 0);
          }
        } catch (_e) { moveFocus('up'); }
      } else {
        moveFocus('up');
      }
      break;
    case 'ArrowDown':
      e.preventDefault();
      if (isTextInput(document.activeElement)) {
        var _el = document.activeElement;
        try {
          var _len = _el.value.length;
          if (_el.selectionStart === _len && _el.selectionEnd === _len) {
            moveFocus('down');
          } else {
            _el.setSelectionRange(_len, _len);
          }
        } catch (_e) { moveFocus('down'); }
      } else {
        moveFocus('down');
      }
      break;
    case 'Enter':
      // Let Enter work normally inside text inputs
      if (!isTextInput(document.activeElement)) {
        e.preventDefault();
        interact(focused());
      }
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      if (activePanel() && activePanel().id === 'panel-options') {
        e.preventDefault();
        var cur = focused();
        if (cur) cycleOption(cur);
      }
      break;
    case 'SoftLeft':
      e.preventDefault();
      handleSoftLeft();
      break;
    case 'SoftRight':
      e.preventDefault();
      handleSoftRight();
      break;
    case 'Backspace':
      if (!isTextInput(document.activeElement)) {
        var bp = activePanel();
        if (bp && bp.id !== 'panel-lists' && bp.id !== 'panel-email') {
          e.preventDefault();
          handleSoftLeft();
        }
        // else: no preventDefault — OS handles back gesture to exit app
      }
      break;
  }
});

function isTextInput(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function interact(el) {
  if (!el) return;
  el.click();
}

function handleSoftLeft() {
  if (isSheetOpen()) { closeSheet(); return; }
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-otp') {
    showEmailPanel();
  } else if (panel.id === 'panel-lists') {
    var cur = focused();
    var name = cur ? cur.getAttribute('data-list-name') : null;
    if (name) openShareSheet(name);
  } else if (panel.id === 'panel-new-list') {
    showListsPanel();
  } else if (panel.id === 'panel-new-item') {
    showListPanel(state.currentListName);
  } else if (panel.id === 'panel-list') {
    showListsPanel(state.currentListName);
  } else if (panel.id === 'panel-options') {
    showListsPanel();
  } else if (panel.id === 'panel-faq') {
    showOptionsPanel();
  }
}

function handleSoftRight() {
  if (isSheetOpen()) { return; }
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-lists') {
    showOptionsPanel();
  } else if (panel.id === 'panel-list') {
    showNewItemPanel();
  }
}

// ─── Screen: Email ────────────────────────────────────────────────────────────

function showEmailPanel() {
  document.body.classList.remove('authenticated');
  document.getElementById('email-hint').textContent = pendingShare
    ? 'Sign in to join the shared list.'
    : "We'll send a one-time code to your email.";
  showPanel('panel-email');
  setSoftkeys('', 'NEXT', '');
}

function resetEmailForm() {
  _otpRequestInFlight = false;
  document.getElementById('input-email').disabled = false;
  document.getElementById('btn-email-next').disabled = false;
}

function submitEmail() {
  if (_otpRequestInFlight) return;
  var email = document.getElementById('input-email').value.trim();
  if (!email) {
    showStatus('Enter your email address', true);
    return;
  }
  _otpRequestInFlight = true;
  document.getElementById('input-email').disabled = true;
  document.getElementById('btn-email-next').disabled = true;
  post('/otp', { email: email }).then(function (res) {
    if (res.ok) {
      state.email = email;
      resetEmailForm();
      showOtpPanel(email);
    } else {
      return res.json().catch(function () { return {}; }).then(function (data) {
        showStatus(data.message || 'Failed to send code', true);
        resetEmailForm();
      });
    }
  }).catch(function () {
    showStatus('Network error', true);
    resetEmailForm();
  });
}

document.getElementById('input-email').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitEmail();
  }
});

// ─── Screen: OTP ──────────────────────────────────────────────────────────────

function showOtpPanel(email) {
  document.getElementById('otp-hint').textContent = 'Code sent to ' + email;
  document.getElementById('input-otp').value = '';
  showPanel('panel-otp');
  setSoftkeys('Back', 'VERIFY', '');
}

function submitOtp() {
  var otp = document.getElementById('input-otp').value.trim();
  if (!otp) {
    showStatus('Enter the code from your email', true);
    return;
  }
  post('/login', { email: state.email, otp: otp }).then(function (res) {
    if (res.ok) {
      var csrf = res.headers.get('x-csrf-token');
      if (csrf) {
        state.csrf = csrf;
        localStorage.setItem('csrf', csrf);
      }
      showListsPanel();
    } else {
      return res.json().catch(function () { return {}; }).then(function (data) {
        showStatus(data.message || 'Incorrect code', true);
      });
    }
  }).catch(function () {
    showStatus('Network error', true);
  });
}

document.getElementById('input-otp').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitOtp();
  }
});

// ─── Screen: Lists ────────────────────────────────────────────────────────────

var COOKIE_REFRESH_KEY = 'shared-lists-cookie-refresh-time';

function refreshCookieIfNeeded() {
  var lastRefresh = localStorage.getItem(COOKIE_REFRESH_KEY);
  if (!lastRefresh || parseInt(lastRefresh) < Date.now()) {
    post('/refresh', { csrf: state.csrf })
      .then(function () {
        localStorage.setItem(COOKIE_REFRESH_KEY, (Date.now() + 86400000).toString());
      })
      .catch(function () {});
  }
}

function showListsPanel(focusName) {
  document.body.classList.add('authenticated');
  Object.keys(state.listCache).forEach(function (name) {
    state.allLists[name] = state.listCache[name].list_id;
  });
  showPanel('panel-lists');
  setSoftkeys('', 'OPEN', 'Options');
  renderLists(focusName);
  loadLists();
  if (!navigator.userAgent.includes('Chrome') && navigator.userAgent.includes('Safari')) {
    refreshCookieIfNeeded();
  }
  if (window.location.hostname.endsWith('.localhost')) displayAd();
  if (pendingShare) acceptShare();
}

function showFaqPanel() {
  showPanel('panel-faq');
  setSoftkeys('Back', '', '');
}

function showOptionsPanel() {
  document.getElementById('opt-user-id').textContent = localStorage.getItem('user_id') || '—';
  document.getElementById('opt-list-order').textContent = SETTING_LABELS.listOrder[settings.listOrder];
  document.getElementById('opt-item-order').textContent = SETTING_LABELS.itemOrder[settings.itemOrder];
  document.getElementById('opt-display-mode').textContent = SETTING_LABELS.displayMode[settings.displayMode];
  showPanel('panel-options');
  setSoftkeys('Back', 'SELECT', '');
}

function logOut() {
  state.csrf = null;
  state.allLists = {};
  localStorage.removeItem('csrf');
  document.body.classList.remove('authenticated', 'list-open');
  showEmailPanel();
  showStatus('Logged out', false);
}

function logOutAll() {
  post('/log-out-all', { csrf: state.csrf }).then(function (res) {
    if (res.ok) {
      logOut();
    } else {
      return res.json().catch(function () { return {}; }).then(function (data) {
        showStatus(data.message || 'Could not log out', true);
      });
    }
  }).catch(function () {
    showStatus('Network error', true);
  });
}

function cycleOption(el) {
  var key = el.getAttribute('data-setting');
  if (key === 'none') return;
  var values = el.getAttribute('data-values').split(',');
  var idx = values.indexOf(settings[key]);
  var next = values[(idx + 1) % values.length];
  settings[key] = next;
  localStorage.setItem(key, next);
  el.querySelector('.options-value').textContent = SETTING_LABELS[key][next];
  applySettings();
}

function openShareSheet(name) {
  var listId = name ? state.allLists[name] : null;
  if (!listId) {
    closeSheet();
    showStatus('Select a list first', true);
    return;
  }
  var url = APP_HOST + '/?share=' + listId;
  var msg = 'Join my list "' + name + '": ' + url;
  var items = [
    {
      label: 'Messages',
      action: function () {
        closeSheet();
        var a = document.createElement('a');
        a.href = 'sms://?&body=' + encodeURIComponent(msg);
        a.click();
      }
    },
    {
      label: 'Email',
      action: function () {
        closeSheet();
        var a = document.createElement('a');
        a.href = 'mailto:?subject=' + encodeURIComponent('Shared list: ' + name)
               + '&body=' + encodeURIComponent(msg);
        a.click();
      }
    }
  ];
  if (window.innerWidth > 240) {
    items.push({
      label: 'Copy link',
      action: function () {
        closeSheet();
        navigator.clipboard.writeText(url).then(function () {
          showStatus('Link copied!');
        });
      }
    });
  }
  openSheet(items, { title: 'Share "' + name + '"', note: 'Choose how to share your list' });
}

function acceptShare() {
  var listId = pendingShare;
  pendingShare = null;
  post('/share', { csrf: state.csrf, list_id: listId }).then(function (res) {
    if (res.status === 403) {
      state.csrf = null;
      localStorage.removeItem('csrf');
      pendingShare = listId;
      showEmailPanel();
      return;
    }
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.ok) {
        var name = data.name;
        state.allLists[name] = data.list_id;
        state.listCache[name] = { name: name, list_id: data.list_id, list: data.list || {} };
        dbSaveList(name, data.list_id, data.list || {});
        if (isKaiosShareHandoff) {
          var banner = document.getElementById('open-in-app-banner');
          banner.removeAttribute('href');
          banner.textContent = 'Success! Joined the list "' + name + '". Please open the app.';
          banner.style.display = 'flex';
        } else {
          openList(name);
        }
      } else if (res.status === 404) {
        showStatus('Share link not found', true);
      } else {
        showStatus('Could not join list', true);
      }
    });
  }).catch(function () {
    showStatus('Network error', true);
  });
}

// ─── Screen: New List ─────────────────────────────────────────────────────────

function showNewListPanel() {
  document.getElementById('input-list-name').value = '';
  showPanel('panel-new-list');
  setSoftkeys('Back', 'CREATE', '');
}

function submitNewList() {
  var name = document.getElementById('input-list-name').value.trim();
  if (!name) {
    showStatus('Enter a list name', true);
    return;
  }
  state.allLists[name] = state.allLists[name] || null;
  showPanel('panel-lists');
  setSoftkeys('', 'OPEN', 'Options');
  renderLists();

  post('/list', { csrf: state.csrf, name: name, list: {} }).then(function (res) {
    if (res.status === 403) {
      state.csrf = null;
      localStorage.removeItem('csrf');
      showEmailPanel();
      return;
    }
    return res.json().then(function (data) {
      state.allLists[data.name] = data.list_id;
      state.listCache[data.name] = { name: data.name, list_id: data.list_id, list: data.list || {} };
      dbSaveList(data.name, data.list_id, data.list || {});
      if (activePanel() && activePanel().id === 'panel-lists') renderLists();
    });
  }).catch(function () {
    showStatus('Could not create list', true);
  });
}

document.getElementById('input-list-name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitNewList();
  }
});

function refreshListsFromLocalCache() {
  dbLoadAll(function (cache) {
    state.listCache = cache;
    state.allLists = {};
    Object.keys(cache).forEach(function (name) {
      state.allLists[name] = cache[name].list_id;
    });
    if (activePanel() && activePanel().id === 'panel-lists') {
      var cur = focused();
      var focusedName = cur ? cur.getAttribute('data-list-name') : null;
      renderLists(focusedName);
    }
  });
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && state.csrf) {
    refreshListsFromLocalCache();
  }
});

function loadLists() {
  post('/me', { csrf: state.csrf }).then(function (res) {
    if (res.status === 403) {
      state.csrf = null;
      localStorage.removeItem('csrf');
      showEmailPanel();
      return;
    }
    return res.json().then(function (data) {
      if (data.user_id) localStorage.setItem('user_id', data.user_id);
      state.allLists = data.list_names || {};
      Object.keys(state.allLists).forEach(function (name) {
        if (!state.listCache[name]) {
          state.listCache[name] = { name: name, list_id: state.allLists[name], list: {} };
          dbSaveList(name, state.allLists[name], {});
        }
      });
      Object.keys(state.listCache).forEach(function (name) {
        if (!(name in state.allLists)) {
          dbDeleteList(name);
          delete state.listCache[name];
        }
      });
      if (activePanel() && activePanel().id === 'panel-lists') {
        var cur = focused();
        var focusedName = cur ? cur.getAttribute('data-list-name') : null;
        var focusedNewList = cur ? cur.hasAttribute('data-new-list') : false;
        renderLists();
        if (focusedName) {
          var el = document.querySelector('[data-list-name="' + focusedName + '"]');
          if (el) setFocus(el);
        } else if (focusedNewList) {
          var el = document.querySelector('[data-new-list]');
          if (el) setFocus(el);
        }
      }
    });
  }).catch(function () {
    showStatus('Could not load lists', true);
  });
}

function renderLists(focusName) {
  var ul = document.getElementById('lists-ul');
  var empty = document.getElementById('lists-empty');
  ul.innerHTML = '';

  empty.style.display = 'none';

  var names = Object.keys(state.allLists);
  if (settings.listOrder === 'alpha') names.sort();

  if (!names.length) {
    var emptyLi = document.createElement('li');
    emptyLi.className = 'list-row-empty';
    emptyLi.textContent = 'No lists yet.';
    ul.appendChild(emptyLi);
  }

  names.forEach(function (name) {
    var li = document.createElement('li');
    li.className = 'list-row';
    li.setAttribute('nav-selectable', 'true');
    li.setAttribute('data-list-name', name);

    var nameSpan = document.createElement('span');
    nameSpan.className = 'list-row-name';
    nameSpan.textContent = name;
    li.appendChild(nameSpan);

    var shareBtn = document.createElement('button');
    shareBtn.className = 'row-share-btn';
    shareBtn.textContent = '⬆';
    shareBtn.title = 'Share';
    shareBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openShareSheet(name);
    });
    li.appendChild(shareBtn);

    li.addEventListener('click', function () { openList(name); });
    ul.appendChild(li);
  });

  var newLi = document.createElement('li');
  newLi.className = 'list-row new-list-row';
  newLi.setAttribute('nav-selectable', 'true');
  newLi.setAttribute('data-new-list', 'true');
  newLi.textContent = '+ New List';
  newLi.addEventListener('click', showNewListPanel);
  ul.appendChild(newLi);

  var target = focusName ? ul.querySelector('[data-list-name="' + focusName + '"]') : null;
  if (!target) target = ul.querySelector('[nav-selectable="true"]');
  if (target) setFocus(target);
}

function openList(name) {
  var cached = state.listCache[name];
  state.currentListName = name;
  state.currentListId = cached ? cached.list_id : state.allLists[name];
  state.currentList = cached ? cached.list : {};
  showListPanel(name);

  if (_listFetchController) _listFetchController.abort();
  _listFetchController = new AbortController();
  var requestedName = name;
  post('/list', { csrf: state.csrf, name: name, list: state.currentList }, _listFetchController.signal)
    .then(function (res) {
      if (res.status === 403) {
        state.csrf = null;
        localStorage.removeItem('csrf');
        showEmailPanel();
        return;
      }
      return res.json().then(function (data) {
        if (requestedName !== state.currentListName) return;
        var serverList = data.list || {};
        var merged = Object.assign({}, serverList);
        Object.keys(state.currentList).forEach(function (key) {
          var localItem = state.currentList[key];
          var serverItem = serverList[key];
          if (!serverItem || localItem.updated >= serverItem.updated) {
            merged[key] = localItem;
          }
        });
        state.currentListId = data.list_id;
        state.currentList = merged;
        state.listCache[name] = { name: name, list_id: data.list_id, list: merged };
        dbSaveList(name, data.list_id, merged);
        if (activePanel() && activePanel().id === 'panel-list') {
          softRenderListItems();
        }
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      showStatus('Could not sync list', true);
    });
}

// ─── Screen: List ─────────────────────────────────────────────────────────────

function showListPanel(name) {
  document.getElementById('list-title').textContent = name;
  showPanel('panel-list');
  setSoftkeys('Back', 'CHECK', 'Add');
  document.getElementById('list-ul').innerHTML = '';
  softRenderListItems();
}

function softRenderListItems(focusKey) {
  var cur = focused();
  var prevKey = cur ? cur.getAttribute('data-item-key') : null;
  var prevSweep = cur ? cur.classList.contains('sweep-row') : false;
  var prevDelete = cur ? cur.classList.contains('delete-list-row') : false;
  var hadFocus = !!cur;

  renderListItems();

  if (!hadFocus) {
    var first = document.querySelector('#list-ul [nav-selectable="true"]');
    if (first) setFocus(first);
    return;
  }

  // If the element that was focused before re-rendering still exists, leave
  // focus and scroll position completely untouched — no setFocus call means
  // no scrollToVisible call. Only when it's actually gone do we need to pick
  // a new focus target (which legitimately may require scrolling).
  var stillThere =
    (prevKey && document.querySelector('[data-item-key="' + prevKey + '"]')) ||
    (prevSweep && document.querySelector('.sweep-row')) ||
    (prevDelete && document.querySelector('.delete-list-row'));

  if (stillThere) return;

  var el = focusKey ? document.querySelector('[data-item-key="' + focusKey + '"]') : null;
  if (!el) el = document.querySelector('#list-ul [nav-selectable="true"]');
  if (el) setFocus(el);
}

function renderListItems() {
  var ul = document.getElementById('list-ul');
  var empty = document.getElementById('list-empty');

  var items = Object.keys(state.currentList)
    .filter(function (key) { return !state.currentList[key].deleted; })
    .map(function (key) { return [key, state.currentList[key]]; })
    .sort(function (a, b) {
      if (settings.itemOrder === 'date') return a[1].updated - b[1].updated;
      return a[1].display.localeCompare(b[1].display);
    });

  empty.style.display = 'none';

  var existingEls = {};
  Array.prototype.slice.call(ul.querySelectorAll('[data-item-key]')).forEach(function (li) {
    existingEls[li.getAttribute('data-item-key')] = li;
  });

  var emptyLi = ul.querySelector('.list-row-empty');

  if (!items.length) {
    Object.keys(existingEls).forEach(function (key) { existingEls[key].remove(); });
    if (!emptyLi) {
      emptyLi = document.createElement('li');
      emptyLi.className = 'list-row-empty';
      emptyLi.textContent = 'Nothing here.';
      ul.insertBefore(emptyLi, ul.firstChild);
    }
  } else {
    if (emptyLi) emptyLi.remove();
    var seenKeys = {};
    var refNode = ul.firstChild;
    items.forEach(function (pair) {
      var key = pair[0], item = pair[1];
      seenKeys[key] = true;
      var li = existingEls[key];
      if (!li) {
        li = document.createElement('li');
        li.setAttribute('nav-selectable', 'true');
        li.setAttribute('data-item-key', key);
        li.addEventListener('click', function () {
          toggleItem(key);
        });
      }
      li.className = 'list-row' + (item.crossed ? ' crossed' : '');
      li.textContent = item.display;
      if (li !== refNode) ul.insertBefore(li, refNode);
      refNode = li.nextSibling;
    });
    Object.keys(existingEls).forEach(function (key) {
      if (!seenKeys[key]) existingEls[key].remove();
    });
  }

  if (!ul.querySelector('.list-actions-label')) {
    var actionsLabel = document.createElement('li');
    actionsLabel.className = 'list-actions-label';
    actionsLabel.textContent = 'List Actions';
    ul.appendChild(actionsLabel);
  }

  if (!ul.querySelector('.sweep-row')) {
    var sweep = document.createElement('li');
    sweep.className = 'list-row sweep-row';
    sweep.setAttribute('nav-selectable', 'true');
    sweep.textContent = 'Clear Completed';
    sweep.addEventListener('click', doSweep);
    ul.appendChild(sweep);
  }

  if (!ul.querySelector('.delete-list-row')) {
    var deleteRow = document.createElement('li');
    deleteRow.className = 'list-row delete-list-row';
    deleteRow.setAttribute('nav-selectable', 'true');
    deleteRow.textContent = 'Delete List';
    deleteRow.addEventListener('click', confirmDeleteList);
    ul.appendChild(deleteRow);
  }
}

function toggleItem(key) {
  var item = state.currentList[key];
  if (!item) return;
  item.crossed = !item.crossed;
  item.updated = nowSec();
  dbSaveList(state.currentListName, state.currentListId, state.currentList);
  softRenderListItems();
  queueSync();
}

function confirmDeleteList() {
  var name = state.currentListName;
  openSheet(
    [
      {
        label: 'Yes, delete "' + name + '"',
        danger: true,
        action: function () { closeSheet(); doDeleteList(); }
      },
      {
        label: 'No, keep list',
        action: function () { closeSheet(); }
      }
    ],
    {
      title: 'Delete "' + name + '"?',
      note: 'This only removes the list from your account. Anyone you\'ve shared it with will still have access until they delete it themselves.'
    }
  );
}

function doDeleteList() {
  var name = state.currentListName;
  post('/delete', { csrf: state.csrf, name: name }).then(function (res) {
    if (res.ok) {
      delete state.allLists[name];
      delete state.listCache[name];
      dbDeleteList(name);
      document.body.classList.remove('list-open');
      showListsPanel();
      showStatus('"' + name + '" deleted', false);
    } else {
      return res.json().catch(function () { return {}; }).then(function (data) {
        showStatus(data.message || 'Could not delete list', true);
      });
    }
  }).catch(function () {
    showStatus('Network error', true);
  });
}

function doSweep() {
  var ts = nowSec();
  var changed = false;
  Object.keys(state.currentList).forEach(function (key) {
    var item = state.currentList[key];
    if (item.crossed && !item.deleted) {
      item.deleted = true;
      item.updated = ts;
      changed = true;
    }
  });
  if (!changed) {
    showStatus('Nothing to clear', false);
    return;
  }
  dbSaveList(state.currentListName, state.currentListId, state.currentList);
  softRenderListItems();
  queueSync();
  showStatus('Cleared!', false);
}

// ─── Screen: New Item ─────────────────────────────────────────────────────────

function showNewItemPanel() {
  document.getElementById('new-item-title').textContent = 'Add to ' + state.currentListName;
  document.getElementById('input-item-name').value = '';
  showPanel('panel-new-item');
  setSoftkeys('Back', 'ADD', '');
}

function submitNewItem() {
  var display = document.getElementById('input-item-name').value.trim();
  if (!display) {
    showStatus('Enter an item name', true);
    return;
  }
  var key = display.toLowerCase().trim().replace(/\s+/g, '_');
  var existing = state.currentList[key];
  if (existing && !existing.deleted) {
    existing.display = display;
    existing.crossed = false;
    existing.updated = nowSec();
  } else {
    state.currentList[key] = { display: display, crossed: false, deleted: false, updated: nowSec() };
  }
  dbSaveList(state.currentListName, state.currentListId, state.currentList);
  queueSync();
  showStatus('Added \'' + display + '\' to \'' + state.currentListName + '\'!');
  document.getElementById('input-item-name').value = '';
  document.getElementById('input-item-name').focus();
}

document.getElementById('input-item-name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitNewItem();
  }
});

var _syncTimer = null;

function queueSync() {
  var snapName = state.currentListName;
  var snapList = state.currentList;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(function () { syncList(snapName, snapList); }, 1000);
}

function syncList(name, list) {
  post('/list', {
    csrf: state.csrf,
    name: name,
    list: list
  }).then(function (res) {
    if (res.status === 403) {
      state.csrf = null;
      localStorage.removeItem('csrf');
      showEmailPanel();
      return;
    }
    if (res.ok) {
      return res.json().then(function (data) {
        var serverList = data.list || {};
        var merged = Object.assign({}, serverList);
        Object.keys(state.currentList).forEach(function (key) {
          var localItem = state.currentList[key];
          var serverItem = serverList[key];
          if (!serverItem || localItem.updated >= serverItem.updated) {
            merged[key] = localItem;
          }
        });
        state.listCache[name] = { name: name, list_id: data.list_id, list: merged };
        dbSaveList(name, data.list_id, merged);
        if (state.currentListName === name) {
          state.currentList = merged;
          if (activePanel() && activePanel().id === 'panel-list') {
            softRenderListItems();
          }
        }
      });
    }
  }).catch(function () {
    showStatus('Sync failed', true);
  });
}

// ─── Softkey click handlers ───────────────────────────────────────────────────

document.getElementById('sk-left').addEventListener('click', function () {
  if (isSheetOpen()) { closeSheet(); } else { handleSoftLeft(); }
});
document.getElementById('sk-right').addEventListener('click', handleSoftRight);
document.getElementById('sk-center').addEventListener('click', function () {
  if (isSheetOpen()) { interact(focused()); return; }
  var panel = activePanel();
  if (!panel) return;
  switch (panel.id) {
    case 'panel-email':
      if (focused() && focused().id === 'btn-email-privacy') {
        interact(focused());
      } else {
        submitEmail();
      }
      break;
    case 'panel-otp':
      submitOtp();
      break;
    case 'panel-new-list':
      submitNewList();
      break;
    case 'panel-new-item':
      submitNewItem();
      break;
    case 'panel-options':
      interact(focused());
      break;
    case 'panel-lists':
    case 'panel-list':
      interact(focused());
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.options-row').forEach(function (row) {
  row.addEventListener('click', function () { cycleOption(row); });
});

document.getElementById('opt-faq').addEventListener('click', showFaqPanel);
document.getElementById('btn-faq-back').addEventListener('click', showOptionsPanel);
document.getElementById('opt-log-out').addEventListener('click', logOut);
document.getElementById('opt-log-out-all').addEventListener('click', logOutAll);

document.getElementById('btn-settings').addEventListener('click', showOptionsPanel);
document.getElementById('btn-email-next').addEventListener('click', submitEmail);
document.getElementById('btn-email-privacy').addEventListener('click', function () {
  openSheet([{ label: 'Got it', action: function () { closeSheet(); } }], {
    title: 'What do we do with your email?',
    note: 'We only use it to send you a one-time sign-in code. The address itself is not stored in our database — only a cryptographic hash is kept so we can recognize you on future visits. After your code is sent, the email address is no longer retained and is not logged.'
  });
});
document.getElementById('btn-otp-back').addEventListener('click', handleSoftLeft);
document.getElementById('btn-otp-verify').addEventListener('click', submitOtp);
document.getElementById('btn-new-list-back').addEventListener('click', handleSoftLeft);
document.getElementById('btn-new-list-create').addEventListener('click', submitNewList);
document.getElementById('btn-new-item-back').addEventListener('click', handleSoftLeft);
document.getElementById('btn-new-item-add').addEventListener('click', submitNewItem);
document.getElementById('btn-list-back').addEventListener('click', handleSoftLeft);
// ─── KaiOS Ads ────────────────────────────────────────────────────────────────

var _preloadedAd = null;
var _lastAdTime = 0;
var _preloadPending = false;

function preloadAd() {
  if (_preloadPending) return;
  _preloadPending = true;
  getKaiAd({
    publisher: '91b81d86-37cf-4a2f-a895-111efa5b36bb',
    app: 'kaiosshaaredlist',
    slot: 'topbarad',
    h: 60,
    w: 240,
    container: document.getElementById('ad-container'),
    onerror: function (err) { console.log('Ad error', err); _preloadPending = false; },
    onready: function (ad) { _preloadPending = false; _preloadedAd = ad; }
  });
}

function displayAd() {
  var now = Date.now();
  if (now - _lastAdTime < 5 * 60 * 1000) return;
  _lastAdTime = Date.now();

  var container = document.getElementById('ad-container');
  container.innerHTML = '';

  if (_preloadedAd) {
    var ad = _preloadedAd;
    _preloadedAd = null;
    ad.call('display', { tabindex: -1, navClass: 'nav-selectable-ad', display: 'block' });
    preloadAd();
  } else {
    getKaiAd({
      publisher: '91b81d86-37cf-4a2f-a895-111efa5b36bb',
      app: 'kaiosshaaredlist',
      slot: 'topbarad',
      h: 60,
      w: 240,
      container: container,
      onerror: function (err) { console.log('Ad error', err); },
      onready: function (ad) {
        ad.call('display', { tabindex: -1, navClass: 'nav-selectable-ad', display: 'block' });
        preloadAd();
      }
    });
  }
}

if (window.location.hostname.endsWith('.localhost')) {
  document.addEventListener('DOMContentLoaded', preloadAd);
}

document.getElementById('btn-list-add').addEventListener('click', showNewItemPanel);
document.getElementById('btn-list-share').addEventListener('click', function () {
  openShareSheet(state.currentListName);
});
document.getElementById('btn-options-back').addEventListener('click', handleSoftLeft);
document.getElementById('sheet-overlay').addEventListener('click', closeSheet);

openDB(function () {
  applySettings();
  var _shareMatch = window.location.search.match(/[?&]share=([^&]+)/);
  var shareIdFromUrl = _shareMatch ? decodeURIComponent(_shareMatch[1]) : null;
  if (shareIdFromUrl) pendingShare = shareIdFromUrl;

  isKaiosShareHandoff = /[?&]handoff=1(&|$)/.test(window.location.search);

  var showShareIntroBanner = shareIdFromUrl &&
      !isKaiosShareHandoff &&
      !window.location.hostname.endsWith('.localhost') &&
      /kaios/i.test(navigator.userAgent);

  function startNormalBootstrap() {
    dbLoadAll(function (cache) {
      state.listCache = cache;
      if (state.csrf) {
        showListsPanel();
      } else {
        showEmailPanel();
      }
    });
  }

  if (showShareIntroBanner) {
    var banner = document.getElementById('open-in-app-banner');
    banner.textContent = 'Click to add list →';
    banner.href = 'http://sharedlists.localhost/index.html?share=' + encodeURIComponent(shareIdFromUrl) + '&handoff=1';
    banner.style.display = 'flex';
    return;
  }

  startNormalBootstrap();
});
