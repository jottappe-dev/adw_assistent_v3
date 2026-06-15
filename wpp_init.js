// ADW Assistent — WhatsApp WebView initialization script
// Injected BEFORE WhatsApp Web loads. Intercepts webpack to capture Store/Chat modules.
(function() {
    'use strict';
    console.log('[ADW] Init script loaded, waiting for webpack...');

    const CHUNK_NAMES = [
        'webpackChunkwhatsapp_web',
        'webpackChunkwhatsapp_web_client',
        'webpackChunkwhatsapp_web_client_legacy',
        'webpackChunkbuild'
    ];

    // Hooks into a webpack chunk array to intercept module loading
    function hookChunkArray(arr, name) {
        if (arr.__adw_hooked) return;
        arr.__adw_hooked = true;
        console.log('[ADW] Hooking webpack chunk array:', name);

        var origPush = arr.push;

        arr.push = function(chunk) {
            // Process this chunk to find Store modules
            if (Array.isArray(chunk) && chunk.length >= 2) {
                var modules = chunk[1];
                if (modules && typeof modules === 'object') {
                    for (var id in modules) {
                        if (!modules.hasOwnProperty(id)) continue;
                        window.__adw_factories = window.__adw_factories || {};
                        window.__adw_factories[id] = modules[id];
                    }
                }
            }

            // After original push, check if module cache is now available
            var result = origPush.apply(this, arguments);

            // Try to access the module cache (webpack 5: __webpack_require__.c)
            checkForStore(arr.push, name);

            return result;
        };

        // Copy properties from original push (webpack stores .c, .m, etc. on push)
        try {
            for (var key in origPush) {
                if (origPush.hasOwnProperty(key)) {
                    try { arr.push[key] = origPush[key]; } catch(e) {}
                }
            }
        } catch(e) {}

        // Check immediately in case modules are already loaded
        checkForStore(arr.push, name);
    }

    // Searches the webpack module cache for Store/Chat
    function checkForStore(bootstrap, name) {
        if (window.__adw_store) return; // already captured

        // Try .c (module cache) and .m (module factories) on the bootstrap function
        var cache = bootstrap.c || bootstrap.m;
        if (!cache) {
            // In some webpack versions, the cache is on the __webpack_require__ function
            // which might be set as a property of the bootstrap after it runs
            return;
        }

        console.log('[ADW] Module cache found, scanning', Object.keys(cache).length, 'modules from', name);

        var foundAny = false;
        for (var id in cache) {
            if (!cache.hasOwnProperty(id)) continue;
            try {
                var mod = cache[id];
                var exp = (mod && mod.exports) ? mod.exports : null;
                if (!exp) continue;

                var root = exp.default || exp;

                // Check for Store with Chat
                if (root.Store && root.Store.Chat && typeof root.Store.Chat.getModelsArray === 'function') {
                    window.__adw_store = root.Store;
                    console.log('[ADW] Store captured from module', id, 'in', name);
                    return;
                }
                if (root.Store && root.Store.Msg) {
                    window.__adw_store = root.Store;
                    console.log('[ADW] Store (via Msg) captured from module', id, 'in', name);
                    return;
                }

                // Check for Chat collection directly
                if (root.Chat && typeof root.Chat.getModelsArray === 'function') {
                    // Wrap in a Store-like object
                    window.__adw_store = root;
                    console.log('[ADW] Chat store captured from module', id, 'in', name);
                    return;
                }

                if (!foundAny && id % 100 === 0) {
                    // Log a sample of what we're finding
                    var expKeys = Object.keys(root).slice(0, 10);
                    console.log('[ADW] Sample module', id, 'keys:', expKeys.join(','));
                    foundAny = true;
                }
            } catch(e) {}
        }
    }

    // Intercept chunk arrays as they are created
    for (var i = 0; i < CHUNK_NAMES.length; i++) {
        var name = CHUNK_NAMES[i];
        if (window[name]) {
            hookChunkArray(window[name], name);
        }
    }

    // Use a MutationObserver to detect when webpack chunk arrays are created
    // (they may be created after this script runs)
    var observer = new MutationObserver(function() {
        for (var i = 0; i < CHUNK_NAMES.length; i++) {
            var name = CHUNK_NAMES[i];
            if (window[name] && !window[name].__adw_hooked) {
                hookChunkArray(window[name], name);
            }
        }
        // Also periodically check for the module cache
        for (var i = 0; i < CHUNK_NAMES.length; i++) {
            var arr = window[CHUNK_NAMES[i]];
            if (arr && arr.__adw_hooked) {
                checkForStore(arr.push, CHUNK_NAMES[i]);
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Also poll for the first 30 seconds in case MutationObserver misses it
    var pollCount = 0;
    var pollInterval = setInterval(function() {
        pollCount++;
        for (var i = 0; i < CHUNK_NAMES.length; i++) {
            var name = CHUNK_NAMES[i];
            var arr = window[name];
            if (arr && Array.isArray(arr) && !arr.__adw_hooked) {
                hookChunkArray(arr, name);
            }
            if (arr && arr.__adw_hooked) {
                checkForStore(arr.push, name);
            }
        }
        if (window.__adw_store || pollCount > 60) {
            clearInterval(pollInterval);
            if (window.__adw_store) {
                console.log('[ADW] Store successfully captured after', pollCount * 500, 'ms');
            } else {
                console.log('[ADW] Store not found after 30s polling');
            }
        }
    }, 500);
})();
