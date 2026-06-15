/* ===== ADW Assistent v3 — Frontend Logic ===== */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/* ── State ──────────────────────────────────── */
let config = null;
let state = null;
let taskActive = false;
let taskRunning = false;
let taskDone = false;
let runMode = 'auto';
let allGroups = [];
let calMonths = {};
let calYears = {};
let calSelected = {};
let calOpen = {};

const MONTHS = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const DAY_LABELS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/* ── Init ───────────────────────────────────── */
async function init() {
  // Ping backend with retries
  let connected = false;
  for (let i = 0; i < 30; i++) {
    try {
      await invoke('ping');
      connected = true;
      break;
    } catch (_) {
      await sleep(300);
    }
  }

  if (!connected) {
    document.getElementById('splashScreen').querySelector('.splash-subtitle').textContent =
      'ERRO DE CONEXAO';
    return;
  }

  try {
    config = await invoke('load_config');
    state = await invoke('load_state');
  } catch (e) {
    console.error('Failed to load initial data:', e);
  }

  // Restore mode from config
  if (config && config.mode) {
    runMode = config.mode;
    setRunMode(runMode);
  }

  // Render schedule UI
  renderDaysRow();
  applyConfigToUI();

  // Check current task
  await checkTask();

  // Load groups
  try {
    allGroups = await invoke('load_cached_groups');
    mergeGroupConfig();
    if (!allGroups || !allGroups.length) {
      document.getElementById('groupsStatusMsg').textContent =
        'Nenhum grupo disponivel. Clique em Atualizar para buscar.';
    } else {
      document.getElementById('groupsStatusMsg').textContent =
        allGroups.length + ' grupo(s) encontrado(s)';
    }
    renderGroupList();
    renderDashGroups();
  } catch (e) {
    console.error('Failed to load groups:', e);
  }

  // Setup event listeners
  setupListeners();

  // Hide splash
  setTimeout(() => {
    document.getElementById('splashScreen').classList.add('hidden');
  }, 600);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ── Tab Navigation ─────────────────────────── */
function showTab(tab) {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(t => t.classList.remove('active'));

  const panes = document.querySelectorAll('.pane');
  panes.forEach(p => p.classList.remove('active'));

  const activeTab = document.querySelector(`.tab[data-tab="${tab}"]`);
  if (activeTab) activeTab.classList.add('active');

  const activePane = document.getElementById('pane-' + tab);
  if (activePane) {
    activePane.classList.add('active');
  }

  // Handle WhatsApp webview
  const content = document.querySelector('.content');
  if (tab === 'whatsapp') {
    content.classList.add('fullview');
    document.getElementById('wppPlaceholder').style.display = 'none';
    try {
      invoke('show_wpp_webview');
      invoke('sync_wpp_window');
    } catch (e) {
      console.error('Failed to show WhatsApp webview:', e);
    }
  } else {
    content.classList.remove('fullview');
    try {
      invoke('hide_wpp_webview');
    } catch (e) {
      // Ignore
    }
  }
}

/* ── Config ─────────────────────────────────── */
async function loadConfig() {
  try {
    config = await invoke('load_config');
    applyConfigToUI();
  } catch (e) {
    console.error('loadConfig error:', e);
  }
}

async function saveConfig() {
  if (!config) return;
  try {
    await invoke('save_config', { config });
  } catch (e) {
    console.error('saveConfig error:', e);
  }
}

function applyConfigToUI() {
  if (!config) return;

  // Output dir
  const outputDir = document.getElementById('outputDir');
  if (config.output_dir) outputDir.value = config.output_dir;

  // Schedule time
  if (config.schedule_hour !== undefined)
    document.getElementById('schedHour').value = config.schedule_hour;
  if (config.schedule_min !== undefined)
    document.getElementById('schedMin').value = config.schedule_min;

  // Media toggles
  const togImage = document.getElementById('tog-image');
  const togVideo = document.getElementById('tog-video');
  if (config.media_types) {
    togImage.classList.toggle('on', config.media_types.includes('image'));
    togVideo.classList.toggle('on', config.media_types.includes('video'));
  }

  // Max retries
  if (config.max_retries)
    document.getElementById('maxRetries').value = config.max_retries;

  // Initial date
  if (config.initial_date) {
    setDateDisplay('init', config.initial_date);
    calSelected['init'] = config.initial_date;
  }

  // Days
  if (config.skip_days) {
    document.querySelectorAll('.day-btn').forEach((btn, i) => {
      btn.classList.toggle('skip', config.skip_days.includes(i));
    });
  }

  // Agent toggle
  const agentToggle = document.getElementById('agentToggle');
  const agentToggleName = document.getElementById('agentToggleName');
  if (config.task_enabled) {
    agentToggle.classList.add('on');
    agentToggleName.textContent = 'Habilitado';
  } else {
    agentToggle.classList.remove('on');
    agentToggleName.textContent = 'Desabilitado';
  }

  // Mode
  if (config.mode) {
    setRunMode(config.mode);
  }
}

/* ── Task ───────────────────────────────────── */
async function checkTask() {
  try {
    const info = await invoke('check_task');
    const badge = document.getElementById('taskBadge');
    const infoEl = document.getElementById('taskInfo');

    if (info.running) {
      taskRunning = true;
      badge.textContent = 'Em execucao';
      badge.className = 'badge badge-ok';
      infoEl.textContent = info.message || 'Executando...';
      document.querySelector('.tb-dot').classList.add('on');
    } else if (info.scheduled) {
      badge.textContent = 'Agendado';
      badge.className = 'badge badge-warn';
      infoEl.textContent = info.message || 'Tarefa agendada';
      document.querySelector('.tb-dot').classList.remove('on');
    } else {
      taskRunning = false;
      badge.textContent = 'Parado';
      badge.className = 'badge';
      infoEl.textContent = info.message || 'Nenhuma tarefa em execucao';
      document.querySelector('.tb-dot').classList.remove('on');
    }

    taskActive = info.running || info.scheduled;
  } catch (e) {
    console.error('checkTask error:', e);
  }
}

/* ── Dashboard Groups ───────────────────────── */
function renderDashGroups() {
  const container = document.getElementById('dashGroups');
  const enabled = allGroups.filter(g => g.enabled !== false);
  if (!enabled.length) {
    container.innerHTML =
      '<div style="color:var(--muted2);font-size:12px;padding:8px;text-align:center">Nenhum grupo ativo</div>';
    return;
  }
  container.innerHTML = enabled.map(g =>
    '<div class="group-row" style="cursor:default">' +
      '<span class="group-row-name">' + esc(g.name || g.id) + '</span>' +
      '<span class="group-row-state">' + esc(g.state || 'pendente') + '</span>' +
    '</div>'
  ).join('');
}

/* ── Mode ───────────────────────────────────── */
function setRunMode(mode) {
  runMode = mode;
  const autoBtn = document.getElementById('modeAuto');
  const manBtn = document.getElementById('modeManual');
  const dateRow = document.getElementById('dateRow');

  autoBtn.classList.toggle('active', mode === 'auto');
  manBtn.classList.toggle('active', mode === 'manual');
  dateRow.style.display = mode === 'manual' ? 'block' : 'none';

  if (config) {
    config.mode = mode;
    saveConfig();
  }
}

/* ── Progress ───────────────────────────────── */
function showProgress() {
  const pc = document.getElementById('progressCard');
  pc.classList.add('visible');
  document.getElementById('progBar').style.width = '0%';
  document.getElementById('progLog').innerHTML = '';
  document.getElementById('btnStop').disabled = false;
}

function hideProgress(finished) {
  const pc = document.getElementById('progressCard');
  if (finished) {
    document.getElementById('progBar').style.width = '100%';
    document.getElementById('progPhase').textContent = 'Concluido';
    const restartBtn = document.getElementById('btnRestart');
    restartBtn.style.display = 'inline-flex';
  }
  document.getElementById('btnStop').disabled = true;
}

function closeProgress() {
  const pc = document.getElementById('progressCard');
  pc.classList.remove('visible');
  document.getElementById('btnRestart').style.display = 'none';
  document.getElementById('btnStop').disabled = true;
}

/* ── Log ────────────────────────────────────── */
function addLogLine(text, type) {
  const log = document.getElementById('progLog');
  const line = document.createElement('div');
  line.className = 'log-' + (type || 'info');
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

/* ── Run / Stop / Restart ───────────────────── */
async function runNow() {
  if (taskRunning) return;
  if (!config || !config.enabled_groups || !config.enabled_groups.length) {
    addLogLine('Nenhum grupo ativo. Ative grupos na aba Grupos.', 'err');
    return;
  }
  if (!config.output_dir) {
    addLogLine('Selecione uma pasta de saida na aba Agendamento.', 'err');
    return;
  }

  // Build list of dates to download
  var dates = [];
  if (runMode === 'manual') {
    var from = calSelected[1];
    var to = calSelected[2] || from;
    if (!from) {
      addLogLine('Selecione a data de inicio.', 'err');
      return;
    }
    // Generate all dates in range
    var cur = new Date(from + 'T00:00:00');
    var end = new Date(to + 'T00:00:00');
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
  } else {
    dates.push(new Date().toISOString().slice(0, 10));
  }

  // Load progress to skip already-downloaded dates
  var progress = {};
  var skippedDates = 0;
  try { progress = await invoke('load_progress_data'); } catch(e) {}

  showProgress();
  addLogLine('Pasta de saida: ' + config.output_dir, 'info');
  taskRunning = true;
  taskDone = false;
  document.getElementById('statDays').textContent = dates.length;

  try {
    var mediaTypes = config.media_types || ['image', 'video'];
    for (var d = 0; d < dates.length; d++) {
      if (!taskRunning) break; // user aborted
      var date = dates[d];
      // Check if all groups already have this date downloaded
      var allDone = config.enabled_groups.every(function(gid) {
        var gp = progress.groups && progress.groups[gid];
        return gp && gp.downloaded_dates && gp.downloaded_dates.indexOf(date) !== -1;
      });
      if (allDone) {
        skippedDates++;
        addLogLine('--- Dia ' + date + ' (' + (d+1) + '/' + dates.length + ') [PULADO] ---', 'info');
        continue;
      }
      addLogLine('--- Dia ' + date + ' (' + (d+1) + '/' + dates.length + ') ---', 'info');
      document.getElementById('progDate').textContent = date;
      await invoke('download_all_media', {
        date: date,
        groupIds: config.enabled_groups,
        outputDir: config.output_dir,
        mediaTypes: mediaTypes
      });
    }
    document.getElementById('progDate').textContent = dates.length + ' dia(s)' + (skippedDates > 0 ? ' (' + skippedDates + ' pulados)' : '');
  } catch (e) {
    addLogLine('Erro: ' + e, 'err');
    taskRunning = false;
  }
}

async function stopNow() {
  try {
    await invoke('abort_download');
    addLogLine('Download interrompido.', 'err');
    taskRunning = false;
  } catch (e) {
    console.error('stopNow error:', e);
  }
}

async function restartDownload() {
  document.getElementById('btnRestart').style.display = 'none';
  closeProgress();
  await sleep(300);
  await runNow();
}

async function openLogs() {
  try {
    await invoke('open_logs');
  } catch (e) {
    console.error('openLogs error:', e);
  }
}

/* ── Event Listeners ────────────────────────── */
function setupListeners() {
  // Tab clicks — recalculate groups card height on tab switch
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      showTab(tab.dataset.tab);
      setTimeout(resizeGroupsCard, 50);
    });
  });
  // Recalculate on window resize
  window.addEventListener('resize', resizeGroupsCard);

  // Mode buttons
  document.getElementById('modeAuto').addEventListener('click', () => setRunMode('auto'));
  document.getElementById('modeManual').addEventListener('click', () => setRunMode('manual'));

  // Gear modal
  document.getElementById('gearBtn').addEventListener('click', openGear);
  document.getElementById('gearOverlay').addEventListener('click', closeGearBg);

  // Media toggles
  document.getElementById('tog-image').addEventListener('click', () => {
    document.getElementById('tog-image').classList.toggle('on');
  });
  document.getElementById('tog-video').addEventListener('click', () => {
    document.getElementById('tog-video').classList.toggle('on');
  });

  // Tauri events
  listen('run-progress', event => {
    const d = event.payload;
    if (d.phase) document.getElementById('progPhase').textContent = d.phase;
    if (d.progress !== undefined) document.getElementById('progBar').style.width = d.progress + '%';
    if (d.date) { _downloadDate = d.date; document.getElementById('progDate').textContent = d.date; }
    if (d.found !== undefined) document.getElementById('statFound').textContent = d.found;
    if (d.saved !== undefined) document.getElementById('statSaved').textContent = d.saved;
    // Only log errors/skips — suppress OK lines
    if (d.log) {
      if (d.log.indexOf('OK ') === 0) { /* silent */ }
      else if (d.log.indexOf('ERR') === 0 || d.log.indexOf('SKIP') === 0 || d.log.indexOf('ABORT') === 0) {
        _downloadErrors.push(d.log);
        addLogLine(d.log, 'err');
      } else {
        addLogLine(d.log, d.log_type || 'info');
      }
    }
  });

  listen('run-now-done', event => {
    const d = event.payload;
    var dateStr = _downloadDate || (d.date || '?');
    var found = d.found || 0;
    var saved = d.saved || 0;
    var errors = _downloadErrors.length;

    // Summary format
    var parts = dateStr.split('-');
    var dateFmt = parts[2] + '-' + parts[1] + '-' + parts[0];
    addLogLine('=== ' + dateFmt + ' (' + found + ' Midias) ===', 'info');
    addLogLine('Baixadas ' + saved + '/' + found, saved === found ? 'ok' : 'err');
    if (errors > 0) {
      addLogLine('Erros:', 'err');
      for (var i = 0; i < _downloadErrors.length; i++) {
        var e = _downloadErrors[i];
        // Extract filename from error message
        var fn = e.replace(/^(ERR|SKIP|ABORT)\s*(write\s*)?(\[.*?\])?\s*/i, '').split(':')[0].trim();
        addLogLine('  ' + fn, 'err');
      }
    } else {
      addLogLine('Erros: 0', 'ok');
    }

    _downloadErrors = [];
    _downloadDate = '';
    taskRunning = false;
    taskDone = true;
    hideProgress(true);
    checkTask();
    renderDashGroups();
  });

  listen('wpp-groups', event => {
    const data = event.payload;
    if (data.groups) {
      allGroups = data.groups;
      mergeGroupConfig();
      var enabledCount = allGroups.filter(function(g) { return g.enabled === true; }).length;
      document.getElementById('groupsStatusMsg').textContent =
        allGroups.length + ' grupo(s) | ' + enabledCount + ' ativo(s)';
      renderGroupList();
      renderDashGroups();
    }
  });

  var _downloadErrors = [];
  var _downloadDate = '';

  listen('fetch-groups-progress', event => {
    const d = event.payload;
    if (d.message) {
      document.getElementById('groupsStatusMsg').textContent = d.message;
    }
  });
}

/* ── Groups ──────────────────────────────────── */
// Merge saved enabled_groups from config into the loaded group list
// Groups not explicitly enabled default to disabled
function mergeGroupConfig() {
  var enabledIds = (config && config.enabled_groups) ? config.enabled_groups : [];
  for (var i = 0; i < allGroups.length; i++) {
    var gid = allGroups[i].id || allGroups[i].name || '';
    // Only enabled if explicitly in the saved list
    allGroups[i].enabled = enabledIds.indexOf(gid) !== -1;
  }
}

async function refreshGroups() {
  document.getElementById('groupsStatusMsg').textContent = 'Buscando grupos...';
  try {
    var result = await invoke('fetch_groups');
    // Backend returns { groups: [...], total: N, source, debug } — extract the array
    allGroups = Array.isArray(result) ? result : (result.groups || []);
    mergeGroupConfig();
    var total = result.total || allGroups.length;
    var src = result.source || '?';
    var debug = result.debug || {};
    var enabledCount = allGroups.filter(function(g) { return g.enabled === true; }).length;
    document.getElementById('groupsStatusMsg').textContent =
      total + ' grupo(s) | ' + enabledCount + ' ativo(s) [fonte: ' + src + ']';
    renderGroupList();
    renderDashGroups();
    // If no groups found and no store is available, offer to reload
    var debugEl = document.getElementById('groupsDebug');
    if (total === 0) {
      var msg = 'Debug: ' + JSON.stringify(debug, null, 2);
      if (src === 'none' && !debug.hasAdwStore && !debug.hasStore) {
        msg += '\n\n⚠ Store do WhatsApp nao encontrado. O modulo interno mudou.\nClique no botao abaixo para recarregar o WhatsApp Web com o capturador de modulos.';
        // Show reload button
        var reloadBtn = document.getElementById('btnReloadWpp');
        if (reloadBtn) reloadBtn.style.display = 'inline-flex';
      }
      if (debugEl) {
        debugEl.textContent = msg;
        debugEl.style.display = 'block';
      }
      console.log('fetch_groups debug:', JSON.stringify(debug, null, 2));
    } else if (debugEl) {
      debugEl.style.display = 'none';
      var reloadBtn = document.getElementById('btnReloadWpp');
      if (reloadBtn) reloadBtn.style.display = 'none';
    }
  } catch (e) {
    document.getElementById('groupsStatusMsg').textContent = 'Erro ao buscar grupos';
    console.error('refreshGroups error:', e);
  }
}

async function reloadWpp() {
  var btn = document.getElementById('btnReloadWpp');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Recarregando...';
  }
  document.getElementById('groupsStatusMsg').textContent = 'Recarregando WhatsApp Web...';
  try {
    await invoke('reload_wpp_webview');
    document.getElementById('groupsStatusMsg').textContent =
      'WhatsApp Web recarregado. Aguarde o login e clique em Atualizar.';
  } catch (e) {
    document.getElementById('groupsStatusMsg').textContent = 'Erro ao recarregar: ' + e;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Recarregar WhatsApp Web';
  }
}

function resizeGroupsCard() {
  const card = document.getElementById('groupsCard');
  if (!card) return;
  // Available height = viewport - titlebar(48) - tabs(40) - header row(~44) - content padding(40) - debug pre(~0)
  const h = window.innerHeight - 48 - 40 - 44 - 40;
  card.style.height = h + 'px';
  card.style.overflowY = 'auto';
}

function filterGroups() {
  // Rerender with current search filter — no state change, just UI
  renderGroupList();
}

function renderGroupList() {
  const container = document.getElementById('groupList');
  resizeGroupsCard();
  var searchText = (document.getElementById('groupSearch').value || '').toLowerCase().trim();
  var filtered = allGroups;
  if (searchText && allGroups && allGroups.length) {
    filtered = allGroups.filter(function(g) {
      var name = (g.name || g.id || '').toLowerCase();
      var id = (g.id || '').toLowerCase();
      return name.indexOf(searchText) !== -1 || id.indexOf(searchText) !== -1;
    });
  }
  if (!filtered || !filtered.length) {
    container.innerHTML =
      '<div style="color:var(--muted2);font-size:12px;padding:16px;text-align:center">Nenhum grupo disponivel</div>';
    return;
  }
  var matching = searchText ? new Set(filtered.map(function(g) { return g.id || g.name; })) : null;
  container.innerHTML = allGroups.map(function(g, i) {
    var isEnabled = g.enabled !== false;
    var hidden = '';
    if (matching && !matching.has(g.id || g.name)) hidden = ' style="display:none"';
    return '<div class="group-row" id="groupRow' + i + '"' + hidden + '>' +
      '<span class="group-row-name">' + esc(g.name || g.id) + '</span>' +
      '<button class="btn btn-sm group-toggle-btn ' + (isEnabled ? 'btn-green' : 'btn-ghost') + '" id="groupToggle' + i + '" onclick="event.stopPropagation(); toggleGroup(' + i + ')">' +
        (isEnabled ? 'Ativo' : 'Desativado') +
      '</button>' +
      '<button class="group-row-reset" onclick="event.stopPropagation(); resetGroup(' + i + ')" title="Resetar grupo">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<polyline points="1 4 1 10 7 10" />' +
          '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />' +
        '</svg>' +
      '</button>' +
    '</div>';
  }).join('');
}

async function saveGroupsSelection() {
  if (!config) return;
  config.enabled_groups = allGroups
    .filter(function(g) { return g.enabled === true; })
    .map(function(g) { return g.id || g.name; });
  await saveConfig();
  document.getElementById('groupsStatusMsg').textContent =
    allGroups.length + ' grupo(s) | ' + config.enabled_groups.length + ' ativo(s) — Salvo!';
  setTimeout(function() {
    document.getElementById('groupsStatusMsg').textContent =
      allGroups.length + ' grupo(s) | ' + config.enabled_groups.length + ' ativo(s)';
  }, 1500);
}

async function toggleGroup(id) {
  if (!allGroups || !allGroups[id]) return;
  // Toggle enabled state
  allGroups[id].enabled = allGroups[id].enabled === false ? true : false;
  var isEnabled = allGroups[id].enabled;

  // Update just the button (no full re-render)
  var btn = document.getElementById('groupToggle' + id);
  if (btn) {
    btn.textContent = isEnabled ? 'Ativo' : 'Desativado';
    btn.className = 'btn btn-sm group-toggle-btn ' + (isEnabled ? 'btn-green' : 'btn-ghost');
  }

  // Update state badge if it exists
  var stateEl = document.getElementById('groupState' + id);
  if (stateEl) {
    stateEl.textContent = isEnabled ? 'ativo' : 'inativo';
    stateEl.className = 'group-row-state' + (isEnabled ? ' on' : '');
  }

  renderDashGroups();

  // Save to config
  if (config) {
    config.enabled_groups = allGroups
      .filter(g => g.enabled !== false)
      .map(g => g.id || g.name);
    await saveConfig();
  }
}

async function resetGroup(id) {
  if (!allGroups || !allGroups[id]) return;
  try {
    await invoke('reset_group_state', { group_id: allGroups[id].id || allGroups[id].name });
    allGroups[id].state = 'pendente';
    renderGroupList();
    renderDashGroups();
  } catch (e) {
    console.error('resetGroup error:', e);
  }
}

/* ── Schedule ────────────────────────────────── */
async function pickFolder() {
  try {
    const path = await invoke('pick_folder');
    if (path) {
      document.getElementById('outputDir').value = path;
      if (config) {
        config.output_dir = path;
        await saveConfig();
      }
    }
  } catch (e) {
    console.error('pickFolder error:', e);
  }
}

function renderDaysRow() {
  const container = document.getElementById('daysRow');
  container.innerHTML = DAY_LABELS.map((label, i) =>
    '<div class="day-btn" onclick="toggleDay(' + i + ')">' + label + '</div>'
  ).join('');
}

function toggleDay(i) {
  const btns = document.querySelectorAll('.day-btn');
  btns[i].classList.toggle('skip');
}

async function saveSchedule() {
  const outputDir = document.getElementById('outputDir').value.trim();
  if (!outputDir) {
    showSchedMsg('Selecione uma pasta de saida.', 'err');
    return;
  }

  const hour = parseInt(document.getElementById('schedHour').value) || 0;
  const min = parseInt(document.getElementById('schedMin').value) || 0;

  const skipDays = [];
  document.querySelectorAll('.day-btn').forEach((btn, i) => {
    if (btn.classList.contains('skip')) skipDays.push(i);
  });

  const mediaTypes = [];
  if (document.getElementById('tog-image').classList.contains('on')) mediaTypes.push('image');
  if (document.getElementById('tog-video').classList.contains('on')) mediaTypes.push('video');

  const maxRetries = parseInt(document.getElementById('maxRetries').value) || 5;

  if (!mediaTypes.length) {
    showSchedMsg('Selecione ao menos um tipo de midia.', 'err');
    return;
  }

  const scheduleConfig = {
    output_dir: outputDir,
    schedule_hour: hour,
    schedule_min: min,
    skip_days: skipDays,
    media_types: mediaTypes,
    max_retries: maxRetries,
    mode: runMode
  };

  // Also save to main config
  if (config) {
    Object.assign(config, scheduleConfig);
    await saveConfig();
  }

  try {
    await invoke('schedule_task', { hour: scheduleConfig.schedule_hour, minute: scheduleConfig.schedule_min });
    showSchedMsg('Tarefa agendada com sucesso!', 'ok');
    await checkTask();
  } catch (e) {
    showSchedMsg('Erro: ' + e, 'err');
  }
}

function showSchedMsg(msg, type) {
  const el = document.getElementById('schedMsg');
  el.innerHTML = '<div class="log-' + (type || 'info') + '">' + esc(msg) + '</div>';
}

async function deleteTask() {
  if (!confirm('Deletar tarefa agendada?')) return;
  try {
    await invoke('delete_task');
    showSchedMsg('Tarefa deletada.', 'info');
    await checkTask();
  } catch (e) {
    showSchedMsg('Erro: ' + e, 'err');
  }
}

/* ── Gear Modal ─────────────────────────────── */
function openGear() {
  // Hide WhatsApp WebView so it doesn't cover the modal (native window z-order)
  try { invoke('hide_wpp_webview'); } catch (_) {}
  document.getElementById('gearOverlay').classList.add('open');
}

function closeGear() {
  document.getElementById('gearOverlay').classList.remove('open');
  // Restore WhatsApp WebView if the WhatsApp tab is active
  const wppPane = document.getElementById('pane-whatsapp');
  if (wppPane && wppPane.classList.contains('active')) {
    try { invoke('show_wpp_webview'); invoke('sync_wpp_window'); } catch (_) {}
  }
}

function closeGearBg(e) {
  if (e.target === document.getElementById('gearOverlay')) {
    closeGear();
  }
}

/* ── Agent Toggle ───────────────────────────── */
async function toggleAgent() {
  const toggle = document.getElementById('agentToggle');
  const name = document.getElementById('agentToggleName');
  const isOn = toggle.classList.contains('on');

  try {
    if (isOn) {
      await invoke('disable_task');
      toggle.classList.remove('on');
      name.textContent = 'Desabilitado';
    } else {
      await invoke('enable_task');
      toggle.classList.add('on');
      name.textContent = 'Habilitado';
    }
    if (config) {
      config.task_enabled = !isOn;
      await saveConfig();
    }
    await checkTask();
  } catch (e) {
    console.error('toggleAgent error:', e);
  }
}

/* ── Initial Date ───────────────────────────── */
async function saveInitialDate() {
  const ds = calSelected['init'];
  if (!ds) {
    addLogLine('Selecione uma data inicial.', 'err');
    return;
  }
  try {
    await invoke('apply_initial_date', { date: ds });
    if (config) {
      config.initial_date = ds;
      await saveConfig();
    }
    addLogLine('Data inicial salva: ' + fmtBR(ds), 'ok');
  } catch (e) {
    addLogLine('Erro: ' + e, 'err');
  }
}

/* ── Danger Zone ────────────────────────────── */
async function disconnectWpp() {
  if (!confirm('Desconectar WhatsApp Web?')) return;
  try {
    await invoke('wpp_logout');
    addLogLine('WhatsApp desconectado.', 'ok');
  } catch (e) {
    addLogLine('Erro: ' + e, 'err');
  }
}

async function clearSession() {
  if (!confirm('Limpar sessao do WhatsApp?')) return;
  try {
    await invoke('wpp_clear_session');
    addLogLine('Sessao limpa.', 'info');
  } catch (e) {
    addLogLine('Erro: ' + e, 'err');
  }
}

async function factoryReset() {
  if (!confirm('TEM CERTEZA? Isso vai apagar TODOS os dados e configuracoes!')) return;
  if (!confirm('Esta acao nao pode ser desfeita. Continuar?')) return;
  try {
    await invoke('factory_reset');
    addLogLine('Factory reset executado. Recarregando...', 'info');
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    addLogLine('Erro: ' + e, 'err');
  }
}

/* ── Window Controls ────────────────────────── */
async function winMin() {
  try { await invoke('win_minimize'); } catch (_) {}
}

async function winMax() {
  try { await invoke('win_maximize'); } catch (_) {}
}

async function winClose() {
  try { await invoke('win_close'); } catch (_) {}
}

/* ── Calendar ───────────────────────────────── */
function initCal(key) {
  const now = new Date();
  calMonths[key] = now.getMonth();
  calYears[key] = now.getFullYear();
  calSelected[key] = null;
  calOpen[key] = false;
  renderCal(key);
}

function renderCal(key) {
  const calId = key === 'init' ? 'calInit' : 'cal' + key;
  const container = document.getElementById(calId);
  if (!container) return;

  const year = calYears[key];
  const month = calMonths[key];
  const sel = calSelected[key];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrev = new Date(year, month, 0).getDate();

  const today = new Date();
  const todayStr = fmtISO(today);

  // Build header
  let html = '<div class="cal-nav-row">' +
    '<button class="cal-nav" onclick="moveCal(\'' + key + '\', -1)">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>' +
    '</button>' +
    '<span class="cal-month">' + MONTHS[month] + ' ' + year + '</span>' +
    '<button class="cal-nav" onclick="moveCal(\'' + key + '\', 1)">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>' +
    '</button>' +
  '</div>';

  // Weekday headers
  html += '<div class="cal-weekdays">';
  DAY_NAMES.forEach(d => { html += '<span>' + d + '</span>'; });
  html += '</div>';

  // Days grid
  html += '<div class="cal-days">';

  // Previous month days
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrev - i;
    html += '<div class="cal-day other-month">' + day + '</div>';
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = year + '-' + pad(month + 1) + '-' + pad(d);
    let cls = 'cal-day';
    if (ds === todayStr) cls += ' today';
    if (ds === sel) cls += ' selected';
    html += '<div class="' + cls + '" onclick="pickDate(\'' + key + '\', \'' + ds + '\')">' + d + '</div>';
  }

  // Next month days (fill remaining cells)
  const totalCells = firstDay + daysInMonth;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    html += '<div class="cal-day other-month">' + d + '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function moveCal(key, dir) {
  calMonths[key] += dir;
  if (calMonths[key] < 0) {
    calMonths[key] = 11;
    calYears[key]--;
  } else if (calMonths[key] > 11) {
    calMonths[key] = 0;
    calYears[key]++;
  }
  renderCal(key);
}

function toggleCal(key) {
  // Close all other calendars
  Object.keys(calOpen).forEach(k => {
    if (k != key) {
      calOpen[k] = false;
      var otherEl = document.getElementById(k === 'init' ? 'calInit' : 'cal' + k);
      if (otherEl) otherEl.classList.remove('open');
    }
  });

  calOpen[key] = !calOpen[key];
  var calId = key === 'init' ? 'calInit' : 'cal' + key;
  var triggerId = key === 'init' ? 'ddInit' : 'dd' + key;
  var el = document.getElementById(calId);
  if (!el) return;

  if (calOpen[key]) {
    // Initialize if needed
    if (!calYears[key]) initCal(key);
    // Position fixed to avoid clipping by overflow:hidden/auto ancestors
    var trigger = document.getElementById(triggerId);
    if (trigger) {
      var rect = trigger.getBoundingClientRect();
      el.style.position = 'fixed';
      el.style.top = (rect.bottom + 4) + 'px';
      el.style.left = rect.left + 'px';
      el.style.width = '260px';
    }
    el.classList.add('open');
    renderCal(key);
  } else {
    el.classList.remove('open');
  }
}

function pickDate(key, ds) {
  calSelected[key] = ds;
  setDateDisplay(key, ds);
  calOpen[key] = false;
  document.getElementById('cal' + key)?.classList.remove('open');
}

function setDateDisplay(key, ds) {
  const el = document.getElementById('dt' + (key === 'init' ? 'Init' : key));
  if (el) {
    el.textContent = fmtBR(ds);
    el.classList.remove('placeholder');
  }
}

/* ── Utilities ──────────────────────────────── */
function fmtBR(s) {
  if (!s || s.length < 10) return s;
  const parts = s.split('-');
  if (parts.length < 3) return s;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function fmtISO(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function esc(s) {
  if (typeof s !== 'string') return String(s || '');
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return s.replace(/[&<>"']/g, c => map[c]);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/* ── Boot ────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Calendar init placeholders
  // Will be fully initialized on first open

  // Tab click setup is done in setupListeners
  // Window controls
  document.getElementById('btnMin').addEventListener('click', winMin);
  document.getElementById('btnMax').addEventListener('click', winMax);
  document.getElementById('btnClose').addEventListener('click', winClose);

  // Boot
  init();
});
