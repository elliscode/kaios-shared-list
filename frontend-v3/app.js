'use strict';

var API = 'https://api.dev-lists.elliscode.com';

var state = {
  email: null,
  csrf: localStorage.getItem('csrf') || null,
  allLists: {},
  listCache: {},
  currentListName: null,
  currentListId: null,
  currentList: {}
};

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
  var panel = activePanel();
  if (!panel) return [];
  return Array.prototype.slice.call(panel.querySelectorAll('[nav-selectable="true"]'));
}

function focused() {
  return document.querySelector('[nav-selected="true"]');
}

function setFocus(el) {
  if (!el) return;
  var prev = focused();
  if (prev) prev.removeAttribute('nav-selected');
  el.setAttribute('nav-selected', 'true');
  el.focus();
  el.scrollIntoView({ block: 'nearest' });
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

// ─── Key Handling ─────────────────────────────────────────────────────────────

document.addEventListener('keydown', function (e) {
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
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-otp') {
    showEmailPanel();
  } else if (panel.id === 'panel-new-list') {
    showListsPanel();
  } else if (panel.id === 'panel-new-item') {
    showListPanel(state.currentListName);
  } else if (panel.id === 'panel-list') {
    showListsPanel();
  }
}

function handleSoftRight() {
  var panel = activePanel();
  if (!panel) return;
  if (panel.id === 'panel-lists') {
    showNewListPanel();
  } else if (panel.id === 'panel-list') {
    showNewItemPanel();
  }
}

// ─── Screen: Email ────────────────────────────────────────────────────────────

function showEmailPanel() {
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
  setSoftkeys('', 'OPEN', 'New');
  renderLists();
  loadLists();
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
      state.allLists = data.list_names || {};
      if (activePanel() && activePanel().id === 'panel-lists') {
        var cur = focused();
        var focusedName = cur ? cur.getAttribute('data-list-name') : null;
        renderLists();
        if (focusedName) {
          var el = document.querySelector('[data-list-name="' + focusedName + '"]');
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

  var names = Object.keys(state.allLists).sort();
  if (!names.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

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

  var first = ul.querySelector('[nav-selectable="true"]');
  if (first) setFocus(first);
}

function openList(name) {
  var cached = state.listCache[name];
  state.currentListName = name;
  state.currentListId = cached ? cached.list_id : state.allLists[name];
  state.currentList = cached ? cached.list : {};
  showListPanel(name);

  post('/list', { csrf: state.csrf, name: name, list: {} }).then(function (res) {
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

function softRenderListItems() {
  var cur = focused();
  var focusedKey = cur ? cur.getAttribute('data-item-key') : null;
  renderListItems();
  if (focusedKey) {
    var el = document.querySelector('[data-item-key="' + focusedKey + '"]');
    if (el) setFocus(el);
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
      var ia = a[1], ib = b[1];
      // Uncrossed first, then alphabetical by display name
      if (ia.crossed !== ib.crossed) return ia.crossed ? 1 : -1;
      return ia.display.localeCompare(ib.display);
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
    sweep.textContent = 'Sweep crossed items';
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
  renderListItems();
  syncList();
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
  renderListItems();
  syncList();
  showStatus('Swept!', false);
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
  var key = 'item_' + nowSec() + '_' + Math.random().toString(36).slice(2, 6);
  state.currentList[key] = { display: display, crossed: false, deleted: false, updated: nowSec() };
  syncList();
  showListPanel(state.currentListName);
}

document.getElementById('input-item-name').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitNewItem();
  }
});

function syncList() {
  var name = state.currentListName;
  post('/list', {
    csrf: state.csrf,
    name: name,
    list: state.currentList
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
        }
      });
    }
  }).catch(function () {
    showStatus('Sync failed', true);
  });
}

// ─── Softkey click handlers ───────────────────────────────────────────────────

document.getElementById('sk-left').addEventListener('click', handleSoftLeft);
document.getElementById('sk-right').addEventListener('click', handleSoftRight);
document.getElementById('sk-center').addEventListener('click', function () {
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
    case 'panel-lists':
    case 'panel-list':
      interact(focused());
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

openDB(function () {
  dbLoadAll(function (cache) {
    state.listCache = cache;
    if (state.csrf) {
      showListsPanel();
    } else {
      showEmailPanel();
    }
  });
});
