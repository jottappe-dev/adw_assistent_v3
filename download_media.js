// ADW Assistent — Media download with proper E2E decryption
(async () => {
    const targetDate = window.__adw_date;
    const enabledIds = window.__adw_ids;
    const mediaTypes = window.__adw_types;
    const outputDir = window.__adw_out;
    let fileSeq = window.__adw_seq_start || 0;
    const emit = window.__TAURI__.event.emit;
    let savedCount = 0, totalMedia = 0;

    function bufToBase64(buf) {
        const bytes = new Uint8Array(buf);
        const chunks = [];
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK)
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
        return btoa(chunks.join(''));
    }

    function resolveModule(names) {
        for (const name of names) {
            try { const mod = window.require(name); if (mod) return mod; } catch(e) {}
        }
        return null;
    }

    // ── Decrypt WhatsApp E2E media manually (AES-256-CBC) ──
    async function decryptMedia(encryptedBuf, mediaKeyB64, mediaType) {
        try {
            // Decode base64 mediaKey to raw 32 bytes
            const keyStr = atob(mediaKeyB64);
            const keyBytes = new Uint8Array(keyStr.length);
            for (let i = 0; i < keyStr.length; i++) keyBytes[i] = keyStr.charCodeAt(i) & 0xff;

            // If key is more than 32 bytes, it might be padded. Truncate to 32.
            const key = keyBytes.length === 32 ? keyBytes : keyBytes.slice(0, 32);
            if (key.length !== 32) {
                // Try without decoding — key might already be raw in some format
                const rawKey = new Uint8Array(mediaKeyB64.length);
                for (let i = 0; i < mediaKeyB64.length; i++) rawKey[i] = mediaKeyB64.charCodeAt(i) & 0xff;
                if (rawKey.length !== 32) return null;
                return await aesDecrypt(encryptedBuf, rawKey);
            }
            return await aesDecrypt(encryptedBuf, key);
        } catch(e) { return null; }
    }

    async function aesDecrypt(encryptedBuf, keyBytes) {
        const iv = encryptedBuf.slice(0, 16);
        const ciphertext = encryptedBuf.slice(16);
        // Some WhatsApp media has the first 16 bytes as a separate header — try both
        const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        try {
            return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, cryptoKey, ciphertext);
        } catch(e) {
            // Try skipping the first 16 bytes entirely (some formats have extra header)
            if (encryptedBuf.length > 32) {
                const iv2 = encryptedBuf.slice(0, 16);
                const ct2 = encryptedBuf.slice(32); // Skip extra 16-byte header
                try { return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv2 }, cryptoKey, ct2); } catch(e2) {}
            }
            return null;
        }
    }

    // ── Download and decrypt media ──
    async function getMediaBlob(msg, methodUsed) {
        // Method 1: WhatsApp internal download+decrypt API
        if (msg.directPath && msg.mediaKey) {
            const dm = resolveModule(['WAWebDownloadManager']);
            if (dm && dm.downloadManager && dm.downloadManager.downloadAndMaybeDecrypt) {
                try {
                    const result = await dm.downloadManager.downloadAndMaybeDecrypt({
                        directPath: msg.directPath,
                        encFilehash: msg.encFilehash || new Uint8Array(0),
                        filehash: msg.filehash || new Uint8Array(0),
                        mediaKey: msg.mediaKey,
                        mediaKeyTimestamp: msg.mediaKeyTimestamp,
                        type: msg.type,
                        signal: new AbortController().signal,
                        downloadQpl: { addAnnotations: function(){return this;}, addPoint: function(){return this;} }
                    });
                    if (result && result.byteLength > 100) {
                        methodUsed.push('WAWebDownloadManager');
                        return new Blob([result]);
                    }
                } catch(e) {}
            }
        }

        // Method 2: mediaObject blob URL (already decrypted in cache)
        if (msg.mediaObject) {
            try {
                const bu = typeof msg.mediaObject.url === 'function' ? msg.mediaObject.url() : null;
                if (bu && bu.startsWith('blob:')) {
                    const r = await fetch(bu);
                    if (r.ok && parseInt(r.headers.get('content-length')||'0') > 100) {
                        methodUsed.push('mediaObject.url');
                        return await r.blob();
                    }
                }
            } catch(e) {}
            try {
                if (typeof msg.mediaObject.arrayBuffer === 'function') {
                    const ab = await msg.mediaObject.arrayBuffer();
                    if (ab && ab.byteLength > 100) {
                        methodUsed.push('mediaObject.arrayBuffer');
                        return new Blob([ab]);
                    }
                }
            } catch(e) {}
        }

        // Method 3: CDN URL + manual decryption with mediaKey
        const url = msg.clientUrl || msg.deprecatedMms3Url || '';
        if (url) {
            try {
                const r = await fetch(url);
                if (r.ok) {
                    const encBuf = await r.arrayBuffer();
                    if (encBuf.byteLength > 100) {
                        const u8 = new Uint8Array(encBuf);
                        if (msg.mediaKey) {
                            const decrypted = await decryptMedia(u8, msg.mediaKey, msg.type);
                            if (decrypted && decrypted.byteLength > 100) {
                                methodUsed.push('CDN+decrypt');
                                return new Blob([decrypted]);
                            }
                        }
                        // If no mediaKey or decryption failed, try raw (might be unencrypted thumbnail)
                        methodUsed.push('CDN-raw');
                        return new Blob([encBuf]);
                    }
                }
            } catch(e) {}
        }

        return null;
    }

    // ── Sanitize (with DOS reserved names) ──
    function sanitize(s) {
        let result = (s || 'grupo')
            .replace(/[\x00-\x1f<>:"/\\|?*\t\n\r]/g, '')
            .replace(/\.+$/, '')
            .trim() || 'grupo';
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(result)) result = '_' + result;
        return result;
    }

    async function emitSave(path, buf) {
        const MAX = 100 * 1024 * 1024;
        if (buf.byteLength > MAX) {
            emit('run-progress', { log: 'ABORT ' + path.split('\\').pop() + ' too large', log_type: 'err' });
            return false;
        }
        if (buf.byteLength <= 1024 * 1024) {
            emit('save-media', { path: path, data: bufToBase64(buf) });
            return true;
        }
        const CHUNK = 1024 * 1024;
        const total = Math.ceil(buf.byteLength / CHUNK);
        const fid = Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 9);
        for (let i = 0; i < total; i++) {
            const s = i * CHUNK, e = Math.min(s + CHUNK, buf.byteLength);
            emit('save-media-chunk', { fileId: fid, path: path, data: bufToBase64(buf.slice(s, e)), index: i, total: total });
            await new Promise(r => setTimeout(r, 0));
        }
        return true;
    }

    // ── Process groups ──
    const WantImage = mediaTypes.includes('image');
    const WantVideo = mediaTypes.includes('video');

    for (const chatId of enabledIds) {
        try {
            const Chat = window.require('WAWebCollections').Chat;
            const chat = Chat.get(chatId);
            if (!chat) continue;
            const gname = sanitize(chat.name || chat.formattedTitle || chatId);
            const Msg = window.require('WAWebCollections').Msg;

            // Load older messages in a loop (each call loads ~50 messages)
            const LOAD_BATCHES = 15; // up to ~750 messages of history
            try {
                const loader = resolveModule(['WAWebChatLoadMessages']);
                if (loader && typeof loader.loadEarlierMsgs === 'function') {
                    for (let batch = 0; batch < LOAD_BATCHES; batch++) {
                        const loaded = await loader.loadEarlierMsgs({ chat: chat });
                        if (!loaded || !loaded.length) break;
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            } catch(e) {}

            // Collect messages ONLY for this specific chat
            const msgs = [];
            const seen = new Set();
            function addMsg(m) {
                try {
                    const key = (m.id && m.id._serialized) || (m.id && m.id.id) || ('t' + (m.t||0));
                    if (key && !seen.has(key)) { seen.add(key); msgs.push(m); }
                } catch(e) {}
            }

            // Approach A: chat.msgs collection (most reliable, already filtered)
            try {
                const cms = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
                for (const m of cms) addMsg(m);
            } catch(e) {}

            // Approach B: Msg.getModelsArray filtered by this chat's ID
            try {
                const all = Msg.getModelsArray ? Msg.getModelsArray() : [];
                for (const m of all) {
                    try {
                        const rid = (m.id && m.id.remote) ? String(m.id.remote) : '';
                        if (rid === chatId) addMsg(m);
                    } catch(e) {}
                }
            } catch(e) {}

            // Filter for target date and media type
            const mediaMsgs = [];
            for (const m of msgs) {
                try {
                    const t = m.t || m.timestamp || 0;
                    if (!t) continue;
                    // Use LOCAL time, not UTC (toISOString shifts dates by timezone offset)
                    const d = new Date(t * 1000);
                    const msgDate = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                    if (msgDate !== targetDate) continue;
                    const type = (m.type || '').toLowerCase();
                    const mimetype = (m.mimetype || '').toLowerCase();
                    // Skip stickers, audio, documents, etc.
                    if (type === 'sticker' || type === 'ptt' || type === 'audio' || type === 'document') continue;
                    const isImage = type === 'image' || mimetype.startsWith('image/');
                    const isVideo = type === 'video' || mimetype.startsWith('video/');
                    if (!isImage && !isVideo) continue;
                    if (!WantImage && isImage) continue;
                    if (!WantVideo && isVideo) continue;
                    // Also check if has actual media data
                    if (!m.clientUrl && !m.deprecatedMms3Url && !m.directPath && !(m.mediaObject && (m.mediaObject.directPath || typeof m.mediaObject.url === 'function'))) continue;
                    mediaMsgs.push({ msg: m, type: isImage ? 'image' : 'video', mimetype });
                } catch(e) {}
            }

            emit('run-progress', { log: gname + ': ' + mediaMsgs.length + ' midias em ' + targetDate + ' (total msgs: ' + msgs.length + ')', log_type: (mediaMsgs.length ? 'info' : 'err') });

            if (!mediaMsgs.length) continue;
            totalMedia += mediaMsgs.length;
            emit('run-progress', { phase: gname, progress: 0 });

            let groupSaved = 0;
            for (let i = 0; i < mediaMsgs.length; i++) {
                const mm = mediaMsgs[i];
                const methodUsed = [];
                try {
                    const blob = await getMediaBlob(mm.msg, methodUsed);
                    if (!blob || blob.size < 100) {
                        emit('run-progress', { log: 'SKIP #' + (i+1) + ' (' + methodUsed.join(',') + ' size=' + (blob?blob.size:0) + ')', log_type: 'err' });
                        continue;
                    }
                    const ext = mm.type === 'image' ? (mm.mimetype && mm.mimetype.includes('png') ? 'png' : 'jpg') : 'mp4';
                    fileSeq++;
                    const seq = String(fileSeq).padStart(3, '0');
                    const fname = targetDate + '-' + seq + '.' + ext;
                    const gdir = sanitize(chat.name || chat.formattedTitle || chatId);
                    const fpath = outputDir + '\\' + gdir + '\\' + targetDate + '\\' + fname;
                    const buf = await blob.arrayBuffer();
                    const ok = await emitSave(fpath, buf);
                    if (ok) groupSaved++;
                    if (ok) savedCount++;
                    emit('run-progress', { phase: gname, progress: Math.round((i+1)/mediaMsgs.length*100), found: totalMedia, saved: savedCount, log: (ok?'OK':'FAIL') + ' ' + fname + ' [' + methodUsed.join(',') + '] ' + Math.round(blob.size/1024) + 'KB' });
                } catch(e) {
                    emit('run-progress', { log: 'ERR #' + (i+1) + ': ' + (e.message||e), log_type: 'err' });
                }
            }
            emit('run-progress', { log: gname + ': ' + groupSaved + '/' + mediaMsgs.length + ' salvas', log_type: 'ok' });
        } catch(e) {
            emit('run-progress', { log: 'ERR grupo: ' + (e.message||e), log_type: 'err' });
        }
    }
    emit('run-now-done', { found: totalMedia, saved: savedCount, date: targetDate });
})();
