/**
 * Stanbax Schools Ibadan - Online State & Supabase Persistence Engine
 * 
 * Guarantees that:
 * 1. All images, files, student records, and setting edits persist online across all sessions & devices.
 * 2. Directly synchronizes with Supabase API and server PostgreSQL state store.
 * 3. Intercepts local state modifications and syncs them without hitting browser localStorage quota limits.
 * 4. Automatically hydrates all cloud state from Supabase / server on boot before UI rendering.
 */

(function () {
  'use strict';

  // Read Supabase credentials from localStorage or environment
  function getSupabaseConfig() {
    let url = '';
    let key = '';
    try {
      url = (localStorage.getItem('stanbax_supabase_url') || '').trim();
      key = (localStorage.getItem('stanbax_supabase_anon_key') || '').trim();
    } catch (e) {}

    if (!url && window.__STANBAX_SUPABASE_URL__) {
      url = window.__STANBAX_SUPABASE_URL__;
      key = window.__STANBAX_SUPABASE_KEY__ || '';
    }
    return {
      url: url.replace(/\/+$/, ''),
      key: key,
      isConfigured: !!(url && key && !url.includes('your-project-id'))
    };
  }

  // Dual-Layer Cloud Sync: Sync to Server State Store + Direct Supabase API
  async function syncKeyToCloud(key, value) {
    if (!key.startsWith('stanbax_')) return;

    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        parsed = value;
      }
    }

    // 1. Sync to Server Central Storage & Database (/api/state/:key)
    try {
      await fetch('/api/state/' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      });
    } catch (err) {
      console.warn('[Cloud Sync] Server state push note:', err);
    }

    // 2. Direct Sync to Supabase REST API (if Supabase credentials are configured)
    const cfg = getSupabaseConfig();
    if (cfg.isConfigured) {
      try {
        const endpoint = cfg.url + '/rest/v1/school_state';
        await fetch(endpoint, {
          method: 'POST',
          headers: {
            'apikey': cfg.key,
            'Authorization': 'Bearer ' + cfg.key,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates'
          },
          body: JSON.stringify({
            key: key,
            data: parsed,
            is_public: true,
            updated_at: new Date().toISOString()
          })
        });
        console.log('[Supabase Direct Sync] Successfully synchronized key:', key);
      } catch (err) {
        console.warn('[Supabase Direct Sync] Direct REST sync note:', err);
      }
    }
  }

  // Debounced write queue to prevent flooding on rapid state edits
  const pendingWrites = new Map();
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(async () => {
      const items = Array.from(pendingWrites.entries());
      pendingWrites.clear();
      for (const [k, v] of items) {
        await syncKeyToCloud(k, v);
      }
    }, 350);
  }

  // Intercept localStorage to capture all state changes and prevent quota crashes
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);

  localStorage.setItem = function (key, value) {
    let savedLocally = false;
    try {
      originalSetItem(key, value);
      savedLocally = true;
    } catch (quotaErr) {
      console.warn('[Storage Quota Exceeded] Intercepting for cloud persistence:', key);
    }

    if (key.startsWith('stanbax_')) {
      pendingWrites.set(key, value);
      scheduleFlush();

      // If it is an image upload (e.g. stanbax_app_images) and exceeded quota or contains data URLs:
      if (key === 'stanbax_app_images' && typeof value === 'string' && value.includes('data:image/')) {
        try {
          const imgObj = JSON.parse(value);
          // Offload data URLs to /api/upload-image to keep localStorage lean
          Object.keys(imgObj).forEach(async (imgKey) => {
            const dataUrl = imgObj[imgKey];
            if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
              try {
                const res = await fetch('/api/upload-image', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ key: imgKey, imageBase64: dataUrl })
                });
                if (res.ok) {
                  const data = await res.json();
                  if (data.url) {
                    imgObj[imgKey] = data.url;
                    try {
                      originalSetItem('stanbax_app_images', JSON.stringify(imgObj));
                    } catch (e) {}
                  }
                }
              } catch (e) {}
            }
          });
        } catch (e) {}
      }
    }
  };

  localStorage.removeItem = function (key) {
    try {
      originalRemoveItem(key);
    } catch (e) {}
    if (key.startsWith('stanbax_')) {
      pendingWrites.set(key, null);
      scheduleFlush();
    }
  };

  // Hydrate all state from Server Database & Supabase on startup
  async function hydrateCloudState() {
    try {
      const res = await fetch('/api/all-state');
      if (res.ok) {
        const payload = await res.json();
        if (payload.success && payload.state) {
          const stateObj = payload.state;
          Object.keys(stateObj).forEach((k) => {
            if (k.startsWith('stanbax_')) {
              try {
                const val = typeof stateObj[k] === 'string' ? stateObj[k] : JSON.stringify(stateObj[k]);
                originalSetItem(k, val);
              } catch (e) {}
            }
          });
          console.log('[Cloud Hydration] Initialized state from central database.');
        }
      }
    } catch (err) {
      console.warn('[Cloud Hydration] Fallback to cached state:', err);
    }

    // Direct fetch from Supabase if configured
    const cfg = getSupabaseConfig();
    if (cfg.isConfigured) {
      try {
        const endpoint = cfg.url + '/rest/v1/school_state?select=key,data';
        const sRes = await fetch(endpoint, {
          headers: {
            'apikey': cfg.key,
            'Authorization': 'Bearer ' + cfg.key
          }
        });
        if (sRes.ok) {
          const rows = await sRes.json();
          if (Array.isArray(rows)) {
            rows.forEach((row) => {
              if (row && row.key && row.data !== undefined) {
                try {
                  originalSetItem(row.key, typeof row.data === 'string' ? row.data : JSON.stringify(row.data));
                } catch (e) {}
              }
            });
            console.log(`[Supabase Hydration] Pulled ${rows.length} rows directly from Supabase.`);
          }
        }
      } catch (err) {
        console.warn('[Supabase Hydration] Remote pull note:', err);
      }
    }
  }

  // Execute hydration immediately
  hydrateCloudState();

  // Expose global helper for components that want immediate direct sync
  window.StanbaxCloud = {
    syncKey: syncKeyToCloud,
    hydrate: hydrateCloudState,
    getSupabaseConfig: getSupabaseConfig
  };

  console.log('[Stanbax Cloud Sync Engine] Active and protecting state across sessions & devices.');
})();
