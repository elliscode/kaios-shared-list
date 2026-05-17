'use strict';

var API      = 'https://api.dev-lists.elliscode.com'; // TODO: change to api.lists.elliscode.com for prod
var APP_HOST = 'https://dev-lists.elliscode.com';     // TODO: change to lists.elliscode.com for prod

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

function post(path, body) {
  return fetch(API + path, {
    method: 'POST',
    credentials: 'include',
    body: JSON.stringify(body)
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
  panel.scrollTop = 0;
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
  return Array.prototype.slice.call(panel.querySelectorAll('[nav-selectable="true"]'));
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
    } else {
      setSoftkeys('Back', 'CHECK', 'Add');
    }
  }
}

function scrollToVisible(el) {
  var container = el.closest('.panel-content') || el.closest('#sheet');
  if (!container) return;
  var elRect = el.getBoundingClientRect();
  var cRect = container.getBoundingClientRect();
  if (elRect.bottom + SOFTKEY_H > cRect.bottom) {
    container.scrollTop += elRect.bottom + SOFTKEY_H - cRect.bottom;
  } else if (elRect.top < cRect.top) {
    container.scrollTop -= cRect.top - elRect.top;
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

function openSheet(items) {
  _sheetSavedFocus = focused();
  var ul = document.getElementById('sheet-ul');
  ul.innerHTML = '';
  items.forEach(function (item) {
    var li = document.createElement('li');
    li.className = 'list-row';
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

document.addEventListener('keydown', function (e) {
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
      moveFocus('up');
      break;
    case 'ArrowDown':
      e.preventDefault();
      moveFocus('down');
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
        e.preventDefault();
        handleSoftLeft();
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
    showListsPanel();
  } else if (panel.id === 'panel-options') {
    showListsPanel();
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
  document.getElementById('email-hint').textContent = pendingShare
    ? 'Sign in to join the shared list.'
    : 'We’ll send a one-time code to your email.';
  showPanel('panel-email');
  setSoftkeys('', 'NEXT', '');
}

function submitEmail() {
  var email = document.getElementById('input-email').value.trim();
  if (!email) {
    showStatus('Enter your email address', true);
    return;
  }
  post('/otp', { email: email }).then(function (res) {
    if (res.ok) {
      state.email = email;
      showOtpPanel(email);
    } else {
      return res.json().catch(function () { return {}; }).then(function (data) {
        showStatus(data.message || 'Failed to send code', true);
      });
    }
  }).catch(function () {
    showStatus('Network error', true);
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

function showListsPanel() {
  Object.keys(state.listCache).forEach(function (name) {
    state.allLists[name] = state.listCache[name].list_id;
  });
  showPanel('panel-lists');
  setSoftkeys('', 'OPEN', 'Options');
  renderLists();
  loadLists();
  if (pendingShare) acceptShare();
}

function showOptionsPanel() {
  document.getElementById('opt-user-id').textContent = localStorage.getItem('user_id') || '—';
  document.getElementById('opt-list-order').textContent = SETTING_LABELS.listOrder[settings.listOrder];
  document.getElementById('opt-item-order').textContent = SETTING_LABELS.itemOrder[settings.itemOrder];
  document.getElementById('opt-display-mode').textContent = SETTING_LABELS.displayMode[settings.displayMode];
  showPanel('panel-options');
  setSoftkeys('Back', '', '');
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
  openSheet([
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
  ]);
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
        openList(name);
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
  openList(name);
}

document.getElementById('input-list-name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitNewList();
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

function renderLists() {
  var ul = document.getElementById('lists-ul');
  var empty = document.getElementById('lists-empty');
  ul.innerHTML = '';

  var names = Object.keys(state.allLists);
  if (settings.listOrder === 'alpha') names.sort();
  if (!names.length) {
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
  }

  names.forEach(function (name) {
    var li = document.createElement('li');
    li.className = 'list-row';
    li.setAttribute('nav-selectable', 'true');
    li.setAttribute('data-list-name', name);
    li.textContent = name;
    li.addEventListener('click', function () {
      openList(name);
    });
    ul.appendChild(li);
  });

  var newLi = document.createElement('li');
  newLi.className = 'list-row new-list-row';
  newLi.setAttribute('nav-selectable', 'true');
  newLi.setAttribute('data-new-list', 'true');
  newLi.textContent = '+ New List';
  newLi.addEventListener('click', showNewListPanel);
  ul.appendChild(newLi);

  var first = ul.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
}

function openList(name) {
  var cached = state.listCache[name];
  state.currentListName = name;
  state.currentListId = cached ? cached.list_id : state.allLists[name];
  state.currentList = cached ? cached.list : {};
  showListPanel(name);

  post('/list', { csrf: state.csrf, name: name, list: state.currentList }).then(function (res) {
    if (res.status === 403) {
      state.csrf = null;
      localStorage.removeItem('csrf');
      showEmailPanel();
      return;
    }
    return res.json().then(function (data) {
      state.currentListId = data.list_id;
      state.currentList = data.list || {};
      state.listCache[name] = { name: name, list_id: data.list_id, list: state.currentList };
      dbSaveList(name, data.list_id, state.currentList);
      if (activePanel() && activePanel().id === 'panel-list') {
        softRenderListItems();
      }
    });
  }).catch(function () {
    showStatus('Could not sync list', true);
  });
}

// ─── Screen: List ─────────────────────────────────────────────────────────────

function showListPanel(name) {
  document.getElementById('list-title').textContent = name;
  showPanel('panel-list');
  setSoftkeys('Back', 'CHECK', 'Add');
  renderListItems();
}

function softRenderListItems(focusKey) {
  var cur = focused();
  var targetKey = focusKey || (cur ? cur.getAttribute('data-item-key') : null);
  var sweepFocused = cur ? cur.classList.contains('sweep-row') : false;
  var container = document.querySelector('#panel-list .panel-content');
  var savedScrollTop = container ? container.scrollTop : 0;
  renderListItems();
  if (container) container.scrollTop = savedScrollTop;
  if (targetKey) {
    var el = document.querySelector('[data-item-key="' + targetKey + '"]');
    if (el) setFocus(el);
  } else if (sweepFocused) {
    var sweep = document.querySelector('.sweep-row');
    if (sweep) setFocus(sweep);
  }
}

function renderListItems() {
  var ul = document.getElementById('list-ul');
  var empty = document.getElementById('list-empty');
  ul.innerHTML = '';

  var items = Object.keys(state.currentList)
    .filter(function (key) { return !state.currentList[key].deleted; })
    .map(function (key) { return [key, state.currentList[key]]; })
    .sort(function (a, b) {
      if (settings.itemOrder === 'date') return a[1].updated - b[1].updated;
      return a[1].display.localeCompare(b[1].display);
    });

  if (!items.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  items.forEach(function (pair) {
    var key = pair[0], item = pair[1];
    var li = document.createElement('li');
    li.className = 'list-row' + (item.crossed ? ' crossed' : '');
    li.setAttribute('nav-selectable', 'true');
    li.setAttribute('data-item-key', key);
    li.textContent = item.display;
    li.addEventListener('click', function () {
      toggleItem(key);
    });
    ul.appendChild(li);
  });

  var hasCrossed = items.some(function (pair) { return pair[1].crossed; });
  if (hasCrossed) {
    var sweep = document.createElement('li');
    sweep.className = 'list-row sweep-row';
    sweep.setAttribute('nav-selectable', 'true');
    sweep.textContent = 'Clear Crossed Items';
    sweep.addEventListener('click', doSweep);
    ul.appendChild(sweep);
  }

  var first = ul.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
}

function toggleItem(key) {
  var item = state.currentList[key];
  if (!item) return;
  item.crossed = !item.crossed;
  item.updated = nowSec();
  softRenderListItems();
  queueSync();
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
    showStatus('Nothing to sweep', false);
    return;
  }
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
  queueSync();
  showListPanel(state.currentListName);
  var newEl = document.querySelector('[data-item-key="' + key + '"]');
  if (newEl) setFocus(newEl);
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
        var merged = data.list || state.currentList;
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
      submitEmail();
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
      var f = focused();
      if (f) cycleOption(f);
      break;
    case 'panel-lists':
    case 'panel-list':
      interact(focused());
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

openDB(function () {
  applySettings();
  var _shareMatch = window.location.search.match(/[?&]share=([^&]+)/);
  if (_shareMatch) pendingShare = decodeURIComponent(_shareMatch[1]);
  dbLoadAll(function (cache) {
    state.listCache = cache;
    if (state.csrf) {
      showListsPanel();
    } else {
      showEmailPanel();
    }
  });
});
