// =============================================================================
// ADW Assistent v3 -- Agent de Download (WhatsApp Media Downloader)
// =============================================================================
// Spawned pelo Rust backend para baixar mídias do WhatsApp Web.
// Usa whatsapp-web.js com Puppeteer, compartilhando perfil do WebView2.
// =============================================================================

const { Client, NoAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// =============================================================================
// CONSTANTES GLOBAIS
// =============================================================================
const MAX_RETRIES_DEFAULT = 3;
const RETRY_DELAYS_DEFAULT = [3000, 10000, 30000];
const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas
const MAX_BACKUPS = 10;
const PENDING_EXPIRE_DAYS = 30;
const MAX_FILENAME_LEN = 200;
const CONNECT_TIMEOUT = 120000;
const MAX_CONNECT_ATTEMPTS = 3;
const MSGS_PER_PAGE = 50;
const WINDOW_DAYS = 14; // dias por janela de processamento

// =============================================================================
// CLI ARGS
// =============================================================================
const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
    if (arg.startsWith('--')) {
        const key = arg.slice(2);
        const val = arr[i + 1];
        if (val !== undefined && !val.startsWith('--')) {
            args[key] = val;
        } else {
            args[key] = true;
        }
    }
});

const DATA_DIR = args['data-dir'] || '';
const PROFILE_PATH = args['profile'] || '';
const DATE_FROM = args['from'] || '';
const DATE_TO = args['to'] || '';
const GROUP_FILTER = args['group'] || '';

// =============================================================================
// PATHS
// =============================================================================
const ROOT = DATA_DIR;
const CONFIG_F = path.join(ROOT, 'config.json');
const STATE_F = path.join(ROOT, 'state.json');
const PENDING_F = path.join(ROOT, 'pending.json');
const LOGS_DIR = path.join(ROOT, 'logs');
const BACKUP_DIR = path.join(ROOT, 'backups');
const LOCK_FILE = path.join(ROOT, 'agent.lock');
const PROFILE_ROOT = PROFILE_PATH;
const PROFILE_DEFAULT = path.join(PROFILE_ROOT, 'Default');

// =============================================================================
// LOGGING HELPERS
// =============================================================================
function logInfo(msg) {
    console.log(`[AGENTE] ${msg}`);
}

function logOk(msg) {
    console.log(`[OK] ${msg}`);
}

function logPending(msg) {
    console.log(`[PENDENTE] ${msg}`);
}

function logError(msg) {
    console.log(`[ERRO] ${msg}`);
}

function logWarn(msg) {
    console.log(`[AVISO] ${msg}`);
}

function logDiag(msg) {
    console.log(`[DIAG] ${msg}`);
}

function logEvent(eventType, payload) {
    console.log(`[ADW-EVT] ${eventType} ${JSON.stringify(payload)}`);
}

// =============================================================================
// JSON HELPERS
// =============================================================================
function readJson(filePath, fallback) {
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            if (raw.trim().length === 0) return fallback !== undefined ? fallback : null;
            return JSON.parse(raw);
        }
    } catch (err) {
        logWarn(`Erro ao ler ${filePath}: ${err.message}`);
    }
    return fallback !== undefined ? fallback : null;
}

function writeJson(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        logError(`Erro ao escrever ${filePath}: ${err.message}`);
    }
}

function writeJsonWithBackup(filePath, data) {
    try {
        if (fs.existsSync(filePath)) {
            if (!fs.existsSync(BACKUP_DIR)) {
                fs.mkdirSync(BACKUP_DIR, { recursive: true });
            }
            const baseName = path.basename(filePath);
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const backupName = `${baseName}.${ts}.bak`;
            const backupPath = path.join(BACKUP_DIR, backupName);
            fs.copyFileSync(filePath, backupPath);

            // Limitar a MAX_BACKUPS backups
            const backups = fs.readdirSync(BACKUP_DIR)
                .filter(f => f.startsWith(baseName + '.') && f.endsWith('.bak'))
                .sort()
                .reverse();
            if (backups.length > MAX_BACKUPS) {
                backups.slice(MAX_BACKUPS).forEach(f => {
                    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) { }
                });
            }
        }
        writeJson(filePath, data);
    } catch (err) {
        logError(`Erro ao fazer backup de ${filePath}: ${err.message}`);
        writeJson(filePath, data);
    }
}

// =============================================================================
// DATE UTILS
// =============================================================================
function dateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDays(s, n) {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return dateStr(d);
}

function yesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return dateStr(d);
}

function labelOf(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const parts = s.split('-');
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function daysBetween(from, to) {
    const days = [];
    let cur = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    while (cur <= end) {
        days.push(dateStr(cur));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

function sanitize(name) {
    if (typeof name !== 'string') return 'unknown';
    let s = name.replace(/[<>:"/\\|?*]/g, '_');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > MAX_FILENAME_LEN) {
        s = s.substring(0, MAX_FILENAME_LEN).trim();
    }
    return s || 'unknown';
}

// =============================================================================
// LOCK SYSTEM
// =============================================================================
function readLockMeta() {
    return readJson(LOCK_FILE, null);
}

function isLockStale(meta) {
    if (!meta || !meta.startedAt) return true;
    const elapsed = Date.now() - meta.startedAt;
    return elapsed > LOCK_TIMEOUT_MS;
}

function acquireLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const meta = readLockMeta();
            if (meta && !isLockStale(meta)) {
                logWarn(`Outra instância do agente está em execução (PID ${meta.pid}, iniciado em ${new Date(meta.startedAt).toISOString()})`);
                return false;
            }
            if (meta && isLockStale(meta)) {
                logWarn(`Lock expirado (PID ${meta.pid}, ${Math.round((Date.now() - meta.startedAt) / 60000)}min atrás). Removendo...`);
            }
        }
        writeJson(LOCK_FILE, {
            pid: process.pid,
            startedAt: Date.now()
        });
        logInfo(`Lock adquirido (PID ${process.pid})`);
        return true;
    } catch (err) {
        logError(`Erro ao adquirir lock: ${err.message}`);
        return false;
    }
}

function releaseLock() {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
            logInfo('Lock liberado.');
        }
    } catch (err) {
        logError(`Erro ao liberar lock: ${err.message}`);
    }
}

// =============================================================================
// SESSION
// =============================================================================
function cleanupChromiumProfile() {
    const locks = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'SingletonConnectivity',
        'SingletonViz',
        'TransportSecurity',
        'TrustTokenKeyCommitments',
        'CertificateRevocation',
        'optimization_guide_hint_cache_store',
        'CrowdDeny',
        'DownloadMetadata',
        'FileTypePolicies',
        'HyphenDictionary',
        'LegacyTLSDeprecationConfig',
        'OnDeviceHeadSuggestModel',
        'RecoveryImprovedStore',
        'SubresourceFilter',
        'WebAppStore',
        'first_party_sets'
    ];

    const dirs = [PROFILE_ROOT, PROFILE_DEFAULT];
    let removed = 0;
    dirs.forEach(dir => {
        locks.forEach(name => {
            const p = path.join(dir, name);
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    removed++;
                }
            } catch (_) { }
        });
    });

    // Limpar pastas de cache
    const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'Service Worker'];
    cacheDirs.forEach(name => {
        const p = path.join(PROFILE_DEFAULT, name);
        try {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                removed++;
            }
        } catch (_) { }
    });

    logDiag(`Profile cleanup: ${removed} arquivos/pastas removidos.`);
}

function checkSession() {
    const prefsFile = path.join(PROFILE_DEFAULT, 'Preferences');
    if (!fs.existsSync(prefsFile)) {
        logWarn('Sessão não encontrada. Preferences não existe no perfil.');
        return false;
    }
    try {
        const prefs = readJson(prefsFile, {});
        if (prefs.profile && prefs.profile.content_settings) {
            logDiag('Sessão verificada: Preferences contém content_settings.');
        } else {
            logDiag('Preferences encontrado, mas pode estar incompleto.');
        }
        return true;
    } catch (_) {
        logWarn('Preferences existe mas não pôde ser lido.');
        return false;
    }
}

// =============================================================================
// DOWNLOAD WITH RETRY
// =============================================================================
async function downloadWithRetry(msg, filePath) {
    const config = readJson(CONFIG_F, {});
    const maxRetries = config.max_retries || MAX_RETRIES_DEFAULT;
    const retryDelays = config.retry_delays || RETRY_DELAYS_DEFAULT;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const media = await msg.downloadMedia();
            if (!media) {
                if (attempt < maxRetries) {
                    const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] || retryDelays[0];
                    logWarn(`Tentativa ${attempt}/${maxRetries}: media vazio para ${path.basename(filePath)}. Aguardando ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                return { ok: false, reason: 'downloadMedia retornou vazio', permanent: false };
            }

            const buffer = Buffer.from(media.data, 'base64');
            fs.writeFileSync(filePath, buffer);

            const sizeKb = (buffer.length / 1024).toFixed(1);
            logDiag(`Download OK: ${path.basename(filePath)} (${sizeKb} KB, tentativa ${attempt})`);
            return { ok: true };
        } catch (err) {
            const isPermanent = err.message && (
                err.message.includes('not found') ||
                err.message.includes('403') ||
                err.message.includes('401') ||
                err.message.includes('Media not available')
            );

            if (isPermanent) {
                logError(`Falha permanente no download de ${path.basename(filePath)}: ${err.message}`);
                return { ok: false, reason: err.message, permanent: true };
            }

            if (attempt < maxRetries) {
                const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] || retryDelays[0];
                logWarn(`Tentativa ${attempt}/${maxRetries} falhou para ${path.basename(filePath)}: ${err.message}. Aguardando ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                logError(`Todas as ${maxRetries} tentativas falharam para ${path.basename(filePath)}: ${err.message}`);
                return { ok: false, reason: err.message, permanent: false };
            }
        }
    }
    return { ok: false, reason: 'max retries exceeded', permanent: false };
}

// =============================================================================
// MESSAGE LOADING (cursor-based pagination)
// =============================================================================
async function loadMessagesUntil(client, chatId, tsIni) {
    const allMessages = [];
    let cursor = undefined;
    let loaded = 0;
    let emptyBatches = 0;
    const MAX_EMPTY_BATCHES = 3;

    try {
        while (emptyBatches < MAX_EMPTY_BATCHES) {
            const opts = { limit: MSGS_PER_PAGE };
            if (cursor) {
                opts.before = cursor;
            }

            const chat = await client.getChatById(chatId);
            const messages = await chat.fetchMessages(opts);

            if (!messages || messages.length === 0) {
                emptyBatches++;
                continue;
            }
            emptyBatches = 0;

            const filtered = messages.filter(m => {
                if (!m || !m.timestamp) return false;
                const msgTs = m.timestamp * 1000;
                return msgTs >= tsIni;
            });

            allMessages.push(...filtered);
            loaded += messages.length;

            // Última mensagem do lote como cursor
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.timestamp) {
                cursor = lastMsg.id ? lastMsg.id._serialized || lastMsg.id : undefined;

                // Se a mensagem mais antiga deste lote é anterior a tsIni, podemos parar
                const lastTs = lastMsg.timestamp * 1000;
                if (lastTs < tsIni) {
                    break;
                }
            } else {
                emptyBatches++;
            }

            // Pequena pausa para evitar rate-limit
            await new Promise(r => setTimeout(r, 300));
        }

        // Ordenar por timestamp ascendente
        allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        logDiag(`Carregadas ${allMessages.length} mensagens do chat ${chatId} (total bruto: ${loaded})`);
        return allMessages;
    } catch (err) {
        logError(`Erro ao carregar mensagens de ${chatId}: ${err.message}`);
        return allMessages;
    }
}

// =============================================================================
// PENDING MANAGEMENT
// =============================================================================
function loadPending() {
    return readJson(PENDING_F, []);
}

function savePending(pending) {
    // Expurgar itens com mais de PENDING_EXPIRE_DAYS
    const now = Date.now();
    const maxAge = PENDING_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
    const filtered = pending.filter(p => {
        if (!p.lastAttempt) return false;
        return (now - p.lastAttempt) < maxAge;
    });
    writeJson(PENDING_F, filtered);
    return filtered;
}

function addPending(groupId, groupName, day, messageId, filename, mimetype) {
    const pending = loadPending();
    // Evitar duplicatas
    const exists = pending.some(p => p.messageId === messageId && p.day === day);
    if (!exists) {
        pending.push({
            groupId,
            groupName,
            day,
            messageId,
            filename,
            mimetype,
            attempts: 0,
            lastAttempt: Date.now()
        });
        savePending(pending);
    }
}

function removePending(messageId, day) {
    let pending = loadPending();
    pending = pending.filter(p => !(p.messageId === messageId && p.day === day));
    writeJson(PENDING_F, pending);
}

// =============================================================================
// GROUP PROCESSING
// =============================================================================
async function processGroup(client, chat, groupCfg, dateFrom, dateTo) {
    const config = readJson(CONFIG_F, {});
    const outputDir = config.output_dir || '';
    const mediaTypes = config.media_types || ['image', 'video'];
    const groupName = sanitize(groupCfg.name || chat.name || 'Unknown Group');
    const groupId = chat.id._serialized || chat.id.toString();

    logInfo(`Processando grupo: ${groupName}`);

    // Determinar range de datas (state-based para modo automático sem --from/--to)
    let fromDate = dateFrom;
    let toDate = dateTo;

    if (!fromDate) {
        const state = readJson(STATE_F, {});
        const lastDate = state[groupId];
        if (lastDate) {
            fromDate = addDays(lastDate, 1);
        } else {
            fromDate = config.initial_date || '2025-01-01';
        }
    }

    if (!toDate) {
        toDate = yesterday();
    }

    if (fromDate > toDate) {
        logInfo(`Nenhum dia novo para processar em ${groupName} (último: ${fromDate || 'nunca'})`);
        return { totalOk: 0, totalFail: 0, daysProcessed: 0 };
    }

    const days = daysBetween(fromDate, toDate);
    logInfo(`Processando ${days.length} dia(s) em ${groupName}: ${labelOf(fromDate)} a ${labelOf(toDate)}`);

    const skipDays = config.skip_days || [];
    let totalOk = 0;
    let totalFail = 0;
    let daysProcessed = 0;

    // Processar em janelas de WINDOW_DAYS para progresso incremental
    for (let i = 0; i < days.length; i += WINDOW_DAYS) {
        const windowDays = days.slice(i, i + WINDOW_DAYS);
        const windowFrom = windowDays[0];
        const windowTo = windowDays[windowDays.length - 1];

        logEvent('window-start', {
            group: groupName,
            totalDays: windowDays.length,
            dateFrom: windowFrom,
            dateTo: windowTo
        });

        const result = await processWindow(client, chat, groupCfg, windowDays, skipDays, mediaTypes, outputDir, groupName, groupId);
        totalOk += result.ok;
        totalFail += result.fail;
        daysProcessed += result.days;

        // Atualizar state.json incrementalmente
        if (result.lastSuccessDate) {
            const state = readJson(STATE_F, {});
            state[groupId] = result.lastSuccessDate;
            writeJson(STATE_F, state);
        }
    }

    return { totalOk, totalFail, daysProcessed };
}

async function processWindow(client, chat, groupCfg, days, skipDays, mediaTypes, outputDir, groupName, groupId) {
    let ok = 0;
    let fail = 0;
    let daysWithData = 0;
    let lastSuccessDate = null;

    for (const day of days) {
        const d = new Date(day + 'T00:00:00');
        const dow = d.getDay();

        if (skipDays.includes(dow)) {
            logDiag(`Pulando ${labelOf(day)} (dia ${dow} ignorado)`);
            continue;
        }

        const dayStart = new Date(day + 'T00:00:00');
        const dayEnd = new Date(day + 'T23:59:59');
        const tsIni = dayStart.getTime();
        const tsFim = dayEnd.getTime();

        logInfo(`Carregando mensagens de ${labelOf(day)}...`);

        const messages = await loadMessagesUntil(client, groupId, tsIni);
        const dayMessages = messages.filter(m => {
            if (!m || !m.timestamp) return false;
            const ts = m.timestamp * 1000;
            return ts >= tsIni && ts <= tsFim;
        });

        const mediaMessages = dayMessages.filter(m => {
            if (!m.hasMedia) return false;
            const type = m.type || '';
            return mediaTypes.includes(type);
        });

        if (mediaMessages.length === 0) {
            logDiag(`Nenhuma mídia em ${labelOf(day)}`);
            continue;
        }

        daysWithData++;

        const dayDir = path.join(outputDir, groupName, day);
        if (!fs.existsSync(dayDir)) {
            fs.mkdirSync(dayDir, { recursive: true });
        }

        let dayOk = 0;
        let dayPending = 0;

        for (let idx = 0; idx < mediaMessages.length; idx++) {
            const msg = mediaMessages[idx];
            const ext = msg.mimetype ? msg.mimetype.split('/').pop() || 'bin' : 'bin';
            // Sanitizar extensão (image/jpeg -> jpeg, video/mp4 -> mp4, etc.)
            const safeExt = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'bin';
            const msgId = msg.id ? (msg.id._serialized || msg.id.toString() || msg.id) : `msg_${idx}`;
            const safeId = sanitize(msgId);
            const fileName = `${safeId}.${safeExt}`;
            const filePath = path.join(dayDir, fileName);

            // Pular se já existe
            if (fs.existsSync(filePath)) {
                dayOk++;
                continue;
            }

            const result = await downloadWithRetry(msg, filePath);

            if (result.ok) {
                dayOk++;
            } else if (result.permanent) {
                logWarn(`Falha permanente: ${fileName} - ${result.reason}`);
                fail++;
            } else {
                dayPending++;
                addPending(groupId, groupName, day, msgId, fileName, msg.mimetype || '');
                logWarn(`Falha temporária: ${fileName} - ${result.reason}`);
            }

            // Pequena pausa entre downloads
            if (idx < mediaMessages.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        ok += dayOk;
        lastSuccessDate = day;

        if (dayPending > 0) {
            logPending(`${labelOf(day)} - ${dayOk}/${mediaMessages.length} arquivo(s) | ${dayPending} pendente(s)`);
        } else {
            logOk(`${labelOf(day)} - ${dayOk}/${mediaMessages.length} arquivo(s)`);
        }
    }

    return { ok, fail, days: daysWithData, lastSuccessDate };
}

// =============================================================================
// PENDING RETRY
// =============================================================================
async function retryPending(client) {
    const config = readJson(CONFIG_F, {});
    const outputDir = config.output_dir || '';
    let pending = loadPending();

    if (pending.length === 0) {
        logInfo('Nenhum item pendente para retentar.');
        return;
    }

    logInfo(`Retentando ${pending.length} item(ns) pendente(s)...`);
    let retried = 0;
    let resolved = 0;
    let stillPending = 0;

    for (const item of pending) {
        try {
            const chat = await client.getChatById(item.groupId);
            if (!chat) {
                logWarn(`Chat não encontrado para ${item.groupName}, pulando...`);
                continue;
            }

            // Buscar a mensagem pelo ID (via client, que expõe getMessageById)
            const msg = await client.getMessageById(item.messageId);
            if (!msg) {
                logWarn(`Mensagem ${item.messageId} não encontrada (pode ter expirado). Removendo...`);
                removePending(item.messageId, item.day);
                resolved++;
                continue;
            }

            const dayDir = path.join(outputDir, item.groupName, item.day);
            if (!fs.existsSync(dayDir)) {
                fs.mkdirSync(dayDir, { recursive: true });
            }
            const filePath = path.join(dayDir, item.filename);

            if (fs.existsSync(filePath)) {
                removePending(item.messageId, item.day);
                resolved++;
                continue;
            }

            const result = await downloadWithRetry(msg, filePath);
            if (result.ok) {
                removePending(item.messageId, item.day);
                resolved++;
                logOk(`Pendente resolvido: ${item.filename}`);
            } else {
                item.attempts = (item.attempts || 0) + 1;
                item.lastAttempt = Date.now();
                stillPending++;
                logWarn(`Pendente ainda falhou: ${item.filename} - ${result.reason}`);
            }

            retried++;

            // Pausa entre retentativas
            if (retried < pending.length) {
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (err) {
            logError(`Erro ao retentar pendente ${item.filename}: ${err.message}`);
            stillPending++;
        }
    }

    // Salvar estado atualizado dos pendentes
    pending = loadPending(); // recarregar pois pode ter mudado
    savePending(pending);

    logInfo(`Retentativa concluída: ${resolved} resolvido(s), ${stillPending} ainda pendente(s)`);
}

// =============================================================================
// NOTIFICATION
// =============================================================================
function sendNotification(summary) {
    try {
        const escaped = summary.replace(/"/g, '`"');
        const psCmd = `
$title = "ADW Assistent v3"
$msg = "${escaped}"
[System.Windows.MessageBox]::Show($msg, $title, 'OK', 'Information')
        `.trim();
        // Tentar via PowerShell balloon tip (simples)
        execSync(`powershell -Command "& {${psCmd}}"`, {
            timeout: 5000,
            windowsHide: true
        });
    } catch (err) {
        logDiag(`Notificação não enviada (ambiente sem UI): ${err.message}`);
    }
}

// =============================================================================
// MAIN
// =============================================================================
async function run() {
    try {
        // -----------------------------------------------------------------------
        // 1. Log inicial
        // -----------------------------------------------------------------------
        logInfo('Iniciando...');
        logDiag(`DataDir: ${DATA_DIR}`);
        logDiag(`Profile: ${PROFILE_PATH}`);
        if (DATE_FROM) logDiag(`Periodo: ${DATE_FROM} -> ${DATE_TO || 'hoje'}`);
        if (GROUP_FILTER) logDiag(`Grupo filtrado: ${GROUP_FILTER}`);

        // -----------------------------------------------------------------------
        // 2. Ler config
        // -----------------------------------------------------------------------
        const config = readJson(CONFIG_F, {});
        if (!config || Object.keys(config).length === 0) {
            logError('config.json não encontrado ou vazio em ' + CONFIG_F);
            process.exit(1);
        }

        logDiag(`Config carregada: ${Object.keys(config).length} chaves`);

        // -----------------------------------------------------------------------
        // 3. Verificar skip_days
        // -----------------------------------------------------------------------
        if (config.agent_enabled === false) {
            logInfo('Agente desabilitado em config.json (agent_enabled: false).');
            process.exit(0);
        }

        const skipDays = config.skip_days || [];
        if (!DATE_FROM && !DATE_TO) {
            // Modo automático: verificar se hoje é dia ignorado
            const today = new Date().getDay();
            if (skipDays.includes(today)) {
                logInfo('Hoje é dia ignorado conforme config. Nada a fazer.');
                process.exit(0);
            }
        }

        // -----------------------------------------------------------------------
        // 4. Verificar grupos e output_dir
        // -----------------------------------------------------------------------
        const outputDir = config.output_dir || '';
        if (!outputDir) {
            logError('output_dir não configurado.');
            process.exit(1);
        }

        const groups = config.groups || [];
        const activeGroups = groups.filter(g => g.enabled !== false);

        if (activeGroups.length === 0) {
            logInfo('Nenhum grupo ativo para processar.');
            process.exit(0);
        }

        // Aplicar filtro de grupo se especificado
        let targetGroups = activeGroups;
        if (GROUP_FILTER) {
            targetGroups = activeGroups.filter(g => g.id === GROUP_FILTER || g.name === GROUP_FILTER);
            if (targetGroups.length === 0) {
                logError(`Grupo especificado (${GROUP_FILTER}) não encontrado entre os grupos ativos.`);
                process.exit(1);
            }
        }

        // -----------------------------------------------------------------------
        // 5. Acquire lock
        // -----------------------------------------------------------------------
        if (!acquireLock()) {
            logError('Não foi possível adquirir o lock. Outra instância em execução?');
            process.exit(1);
        }

        // -----------------------------------------------------------------------
        // 6. Cleanup Chromium profile
        // -----------------------------------------------------------------------
        cleanupChromiumProfile();

        // -----------------------------------------------------------------------
        // 7. Check session
        // -----------------------------------------------------------------------
        if (!checkSession()) {
            logWarn('Sessão do WhatsApp pode não estar disponível. Tentando mesmo assim...');
        }

        // -----------------------------------------------------------------------
        // 8. Criar cliente WhatsApp
        // -----------------------------------------------------------------------
        const puppeteerArgs = [
            `--user-data-dir=${PROFILE_ROOT}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--no-first-run',
            '--disable-default-apps',
            '--mute-audio',
            '--disable-features=TranslateUI,ChromeWhatsAppSharedContext',
            '--disable-blink-features=AutomationControlled'
        ];

        // Não usar --headless=new em produção (whatsapp-web.js já gerencia)
        // Adicionar user-agent consistente
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

        const client = new Client({
            puppeteer: {
                args: puppeteerArgs,
                headless: true,
                defaultViewport: null,
                executablePath: undefined // Deixa o Puppeteer gerenciar
            },
            authStrategy: new NoAuth(),
            userAgent: userAgent,
            webVersionCache: {
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/wppconnectteam/wa-version/main/html/2.2412.54.html'
            }
        });

        // -----------------------------------------------------------------------
        // 9. Event handlers
        // -----------------------------------------------------------------------
        let clientReady = false;
        let authError = null;
        let qrReceived = false;

        client.on('ready', () => {
            clientReady = true;
            logInfo('WhatsApp conectado.');
        });

        client.on('auth_failure', (msg) => {
            authError = msg;
            logError(`Falha de autenticação: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        });

        client.on('qr', (qr) => {
            if (!qrReceived) {
                qrReceived = true;
                logWarn('QR code recebido — sessão pode estar expirada.');
                logDiag(`QR: ${qr.substring(0, 40)}...`);
                try {
                    require('qrcode-terminal').generate(qr, { small: true });
                } catch (_) {
                    // qrcode-terminal opcional
                }
            }
        });

        client.on('disconnected', (reason) => {
            logWarn(`WhatsApp desconectado: ${reason}`);
        });

        // -----------------------------------------------------------------------
        // 10. Conectar
        // -----------------------------------------------------------------------
        logInfo('Conectando ao WhatsApp...');
        let connected = false;
        for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
            try {
                await client.initialize();
                connected = true;
                break;
            } catch (err) {
                logError(`Tentativa ${attempt}/${MAX_CONNECT_ATTEMPTS} de conexão falhou: ${err.message}`);
                if (attempt < MAX_CONNECT_ATTEMPTS) {
                    const delay = 5000 * attempt;
                    logInfo(`Aguardando ${delay}ms para nova tentativa...`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        }

        if (!connected) {
            logError('Não foi possível conectar ao WhatsApp após ' + MAX_CONNECT_ATTEMPTS + ' tentativas.');
            try { await client.destroy(); } catch (_) { }
            releaseLock();
            process.exit(1);
        }

        // Aguardar ready (com timeout)
        if (!clientReady) {
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        if (!clientReady) {
                            reject(new Error('Timeout aguardando ready do WhatsApp'));
                        }
                    }, CONNECT_TIMEOUT);

                    client.on('ready', () => {
                        clientReady = true;
                        clearTimeout(timeout);
                        resolve();
                    });

                    client.on('auth_failure', (msg) => {
                        clearTimeout(timeout);
                        reject(new Error(`auth_failure: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`));
                    });
                });
            } catch (err) {
                logError(`Erro ao aguardar conexão: ${err.message}`);
                try { await client.destroy(); } catch (_) { }
                releaseLock();
                process.exit(1);
            }
        }

        // -----------------------------------------------------------------------
        // 11. Processar grupos
        // -----------------------------------------------------------------------
        let totalOk = 0;
        let totalFail = 0;
        let processedGroups = 0;

        for (const groupCfg of targetGroups) {
            try {
                const chat = await client.getChatById(groupCfg.id);
                if (!chat) {
                    logWarn(`Chat não encontrado: ${groupCfg.name || groupCfg.id}`);
                    continue;
                }

                const groupName = sanitize(groupCfg.name || chat.name || 'Unknown');
                logInfo(`Grupo: ${groupName} (${groupCfg.id})`);

                let fromDate = DATE_FROM;
                let toDate = DATE_TO;

                // Se não foi especificado período manual, usar state-based
                if (!fromDate) {
                    const state = readJson(STATE_F, {});
                    const lastDate = state[groupCfg.id];
                    if (lastDate) {
                        fromDate = addDays(lastDate, 1);
                    } else {
                        fromDate = config.initial_date || null;
                    }
                    // Se ainda não tem fromDate, calcular baseado em quanto tempo queremos voltar
                    if (!fromDate) {
                        fromDate = addDays(yesterday(), -30);
                    }
                }

                if (!toDate) {
                    toDate = yesterday();
                }

                if (fromDate > toDate) {
                    logInfo(`  Nada novo para ${groupName} (último: ${fromDate})`);
                    continue;
                }

                const result = await processGroup(client, chat, groupCfg, fromDate, toDate);
                totalOk += result.totalOk;
                totalFail += result.totalFail;
                processedGroups++;

                // Atualizar state.json
                if (result.totalOk > 0 || result.totalFail >= 0) {
                    const state = readJson(STATE_F, {});
                    state[groupCfg.id] = toDate;
                    writeJson(STATE_F, state);
                    logInfo(`  State atualizado: ${groupCfg.id} -> ${toDate}`);
                }
            } catch (err) {
                logError(`Erro ao processar grupo ${groupCfg.name || groupCfg.id}: ${err.message}`);
                totalFail++;
            }
        }

        // -----------------------------------------------------------------------
        // 12. Retentar pendentes
        // -----------------------------------------------------------------------
        await retryPending(client);

        // -----------------------------------------------------------------------
        // 13. Resumo final
        // -----------------------------------------------------------------------
        const summaryMsg = `Concluido - ${processedGroups} grupo(s) | ${totalOk} baixado(s) | ${totalFail} falhou(aram)`;
        console.log(`[AGENTE] ${summaryMsg}`);

        // -----------------------------------------------------------------------
        // 14. Notificação
        // -----------------------------------------------------------------------
        sendNotification(summaryMsg);

        // -----------------------------------------------------------------------
        // 15. Cleanup
        // -----------------------------------------------------------------------
        logInfo('Encerrando...');
        try { await client.destroy(); } catch (_) { }

    } catch (err) {
        logError(`Erro fatal: ${err.message}`);
        console.error(err.stack);
    } finally {
        releaseLock();
        logInfo('Agente encerrado.');
        // Forçar flush do stdout antes de sair
        process.stdout.write('', () => {
            process.exit(0);
        });
    }
}

// =============================================================================
// ENTRY POINT
// =============================================================================
// Verificar argumentos mínimos
if (!DATA_DIR) {
    console.error('[ERRO] --data-dir é obrigatório.');
    process.exit(1);
}

if (!PROFILE_PATH) {
    console.error('[ERRO] --profile é obrigatório.');
    process.exit(1);
}

run().catch(err => {
    console.error(`[ERRO] Erro não tratado: ${err.message}`);
    console.error(err.stack);
    releaseLock();
    process.exit(1);
});
