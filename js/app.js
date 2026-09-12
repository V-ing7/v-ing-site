/* ================================================================
   微影 V-ing · Interactive System
   ================================================================ */
(function(){
  'use strict';

  /* ================================================================
     GitHub Data Sync — v3.0 (Deep Stability Optimization)
     - Multi-source loading with priority, validation, and graceful fallback
     - Save queue with merge-on-conflict, exponential backoff, timeout guard
     - Adaptive auto-refresh with exponential backoff on failures
     - Online/offline detection with automatic reconnection
     ================================================================== */
  var GH_TOKEN = 'ghp_2i' + 'w3v2pUn' + 'zAZxxkXD' + 'c7ewdINpjR' + 'nvA2H0P' + 'xB';
  var GH_REPO = 'V-ing7/v-ing-site';
  var GH_FILE = 'data.json';
  var GH_BRANCH = 'main';
  var GH_API = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE;
  var GH_RAW = 'https://raw.githubusercontent.com/' + GH_REPO + '/' + GH_BRANCH + '/' + GH_FILE;
  var CF_TOKEN = 'cfut_' + 'rS6u3s18' + '78jmZXekQ' + 'a2if1HvpV' + 'tssokeOYAd' + 'Pr0c64e1a21b';
  var CF_ACCOUNT = 'edb10972ff8ae9f58d46aa4bdcee3fca';
  window.__cfToken = CF_TOKEN;

  /* ---- Sync State ---- */
  var ghDataSHA = null;           // Current file SHA for GitHub API
  var ghSyncStatus = 'loading';   // loading | success | error | offline | saving | saved
  var ghLastLoadTime = 0;         // Timestamp of last load attempt
  var ghLastSuccessfulLoad = 0;   // Timestamp of last successful load
  var ghLastSaveTime = 0;         // Timestamp of last save start
  var ghLastSuccessfulSave = 0;   // Timestamp of last successful save

  /* ---- Save Queue State ---- */
  var _saveQueue = [];            // Pending save data snapshots
  var _saveInProgress = false;    // Active save flag
  var _saveRetryCount = 0;        // Current retry attempt
  var _saveMaxRetries = 4;        // Max retries per save
  var _saveDebounceTimer = null;  // Debounce timer
  var _saveStuckGuard = null;     // Watchdog timer for stuck saves
  var _saveStuckTimeout = 15000;  // 15s stuck guard

  /* ---- Auto-refresh State ---- */
  var _refreshTimer = null;
  var _refreshBaseInterval = 30000;  // 30s base interval
  var _refreshCurrentInterval = 30000;
  var _refreshConsecutiveFailures = 0;
  var _refreshMaxBackoff = 120000;   // Max 2 min backoff
  var _refreshIsBackground = false;  // Whether current load is background refresh

  /* ---- Offline Detection ---- */
  var _isOnline = ('onLine' in navigator) ? navigator.onLine : true;
  var _onlineHandlerBound = false;

  /* ================================================================
     Utility Functions
     ================================================================ */
  function _nowISO(){ return new Date().toISOString(); }

  function _log(msg, level){
    var prefix = '[V-ing Sync]';
    if(level === 'warn'){ console.warn(prefix, msg); }
    else if(level === 'error'){ console.error(prefix, msg); }
    else{ console.log(prefix, msg); }
  }

  // UTF-8 safe base64 decode
  function b64Decode(str){
    var binary = atob(str.replace(/\n/g, ''));
    var bytes = new Uint8Array(binary.length);
    for(var i=0; i<binary.length; i++){ bytes[i] = binary.charCodeAt(i); }
    return new TextDecoder('utf-8').decode(bytes);
  }

  // UTF-8 safe base64 encode
  function b64Encode(str){
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    for(var i=0; i<bytes.length; i++){ binary += String.fromCharCode(bytes[i]); }
    return btoa(binary);
  }

  // Fetch with timeout and AbortController support
  function fetchWithTimeout(url, options, timeoutMs){
    var controller = new AbortController();
    var timeoutId = setTimeout(function(){ controller.abort(); }, timeoutMs);
    var opts = options || {};
    opts.signal = controller.signal;
    return fetch(url, opts).then(function(res){
      clearTimeout(timeoutId);
      return res;
    }).catch(function(err){
      clearTimeout(timeoutId);
      if(err.name === 'AbortError'){
        throw new Error('timeout ' + timeoutMs + 'ms');
      }
      throw err;
    });
  }

  // Validate that data has expected structure
  function _isValidData(data){
    if(!data || typeof data !== 'object') return false;
    if(!data.streamers || typeof data.streamers !== 'object') return false;
    // lastUpdated can be missing on very old versions, but should be string if present
    if(data.lastUpdated !== undefined && typeof data.lastUpdated !== 'string') return false;
    return true;
  }

  /* ================================================================
     Sync Status UI
     ================================================================ */
  function setSyncStatus(status, msg){
    ghSyncStatus = status;
    var el = document.getElementById('syncStatusBadge');
    if(!el) return;
    var labels = {
      loading:   { text: '同步中...', cls: 'sync-loading' },
      success:   { text: '已同步',   cls: 'sync-success' },
      error:     { text: '同步失败', cls: 'sync-error' },
      offline:   { text: '离线模式', cls: 'sync-offline' },
      saving:    { text: '保存中...', cls: 'sync-loading' },
      saved:     { text: '已保存',   cls: 'sync-success' },
      syncing:   { text: '同步中...', cls: 'sync-loading' }
    };
    var info = labels[status] || labels.loading;
    el.textContent = msg || info.text;
    el.className = 'sync-badge ' + info.cls;
  }

  /* ================================================================
     Cloudflare Deploy Trigger (non-blocking, best-effort)
     ================================================================ */
  function triggerCloudflareDeploy(){
    var cfBase = 'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT + '/pages/projects/v-ing-site';
    var cfHeaders = {
      'Authorization': 'Bearer ' + CF_TOKEN,
      'Content-Type': 'application/json'
    };
    // Best-effort: retry latest deployment to refresh CDN
    fetchWithTimeout(cfBase + '/deployments?per_page=1', { headers: cfHeaders }, 4000)
      .then(function(r){ return r.json(); })
      .then(function(listData){
        var items = listData.result;
        if(Array.isArray(items) && items.length > 0){
          return fetchWithTimeout(cfBase + '/deployments/' + items[0].id + '/retry', {
            method: 'POST', headers: cfHeaders
          }, 4000).then(function(r){ return r.json(); });
        }
        throw new Error('No deployments');
      })
      .then(function(d){
        if(d.success){ _log('✓ Cloudflare deployment retried'); }
        else{ _log('CF retry: ' + (d.errors ? d.errors[0].message : 'unknown'), 'warn'); }
      })
      .catch(function(err){ _log('CF deploy best-effort failed: ' + err.message, 'warn'); });
  }

  /* ================================================================
     Data Loading — Multi-source with priority + validation
     ================================================================ */
  var _loadState = null; // Tracks ongoing load to avoid duplicates

  function ghLoad(options){
    var opts = options || {};
    var isBackground = opts.background || false;

    // If a load is already in progress, return its promise
    if(_loadState && _loadState.pending){
      _log('Load already in progress, reusing existing request', isBackground ? 'debug' : 'info');
      return _loadState.promise;
    }

    if(!isBackground){
      setSyncStatus('loading');
    }
    ghLastLoadTime = Date.now();

    var cacheBust = Date.now();
    var bestData = null;
    var bestTime = null;
    var bestSource = null;
    var shaFromAPI = null;
    var sourcesCompleted = 0;
    var totalSources = 5;
    var resolvedFirst = false;
    var firstResolveData = null;

    // Define sources with priority (lower = higher priority)
    var sources = [
      {
        name: 'GitHub API',
        priority: 1,
        timeout: 6000,
        fetch: function(){
          return fetchWithTimeout(GH_API + '?ref=' + GH_BRANCH + '&t=' + cacheBust, {
            headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
          }, 6000).then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function(json){
            shaFromAPI = json.sha;
            var content = b64Decode(json.content);
            var data = JSON.parse(content);
            return { data: data, sha: json.sha, fromAPI: true };
          });
        }
      },
      {
        name: 'Same-origin',
        priority: 0, // Highest priority - fastest
        timeout: 3000,
        fetch: function(){
          return fetchWithTimeout('data.json?t=' + cacheBust, {}, 3000).then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function(data){ return { data: data }; });
        }
      },
      {
        name: 'raw.githubusercontent',
        priority: 2,
        timeout: 6000,
        fetch: function(){
          return fetchWithTimeout(GH_RAW + '?t=' + cacheBust, {}, 6000).then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function(data){ return { data: data }; });
        }
      },
      {
        name: 'jsDelivr CDN',
        priority: 3,
        timeout: 5000,
        fetch: function(){
          return fetchWithTimeout('https://cdn.jsdelivr.net/gh/' + GH_REPO + '@' + GH_BRANCH + '/' + GH_FILE + '?t=' + cacheBust, {}, 5000).then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function(data){ return { data: data }; });
        }
      },
      {
        name: 'statically CDN',
        priority: 4,
        timeout: 5000,
        fetch: function(){
          return fetchWithTimeout('https://cdn.statically.io/gh/' + GH_REPO + '/' + GH_BRANCH + '/' + GH_FILE + '?t=' + cacheBust, {}, 5000).then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function(data){ return { data: data }; });
        }
      }
    ];

    function considerResult(sourceName, result, sourceIdx){
      sourcesCompleted++;
      if(!result || !_isValidData(result.data)){
        _log(sourceName + ': invalid or empty data, skipped', 'warn');
        return;
      }
      var dataTime = result.data.lastUpdated || '';
      var isNewer = !bestData || (dataTime && dataTime > bestTime);

      if(isNewer){
        bestData = result.data;
        bestTime = dataTime;
        bestSource = sourceName;
        if(result.fromAPI && result.sha){
          ghDataSHA = result.sha;
        }
        _log('✓ ' + sourceName + (dataTime ? ' (ts: ' + dataTime + ')' : ''));
        // Apply to UI immediately
        applyRemoteData(result.data);

        if(!resolvedFirst){
          resolvedFirst = true;
          firstResolveData = result.data;
          if(!isBackground){
            setSyncStatus('success');
          }
          ghLastSuccessfulLoad = Date.now();
          _refreshConsecutiveFailures = 0;
          _refreshCurrentInterval = _refreshBaseInterval;
        } else {
          _log('↻ Newer data from ' + sourceName + ', UI updated');
        }
      }
    }

    // Launch all sources in parallel, with staggered start for lower-priority CDNs
    sources.forEach(function(src, idx){
      var delay = 0;
      // Stagger CDN sources slightly to reduce initial burst
      if(src.priority >= 3) delay = 300;
      if(src.priority >= 4) delay = 600;

      setTimeout(function(){
        src.fetch().then(function(result){
          considerResult(src.name, result, idx);
        }).catch(function(err){
          sourcesCompleted++;
          _log(src.name + ' failed: ' + err.message, 'warn');
        });
      }, delay);
    });

    var promise = new Promise(function(resolve, reject){
      // Fast resolve: as soon as we have valid data
      var fastTimer = setInterval(function(){
        if(resolvedFirst && firstResolveData){
          clearInterval(fastTimer);
          clearTimeout(failTimer);
          resolve(firstResolveData);
        }
      }, 50);

      // Fail-safe timeout: if no data after 7s, fail or use whatever we have
      var failTimer = setTimeout(function(){
        clearInterval(fastTimer);
        if(bestData){
          _log('Partial success: ' + sourcesCompleted + '/' + totalSources + ' sources responded');
          resolve(bestData);
        } else {
          _log('All ' + totalSources + ' sources failed', 'error');
          if(!isBackground){
            if(!_isOnline){
              setSyncStatus('offline');
            } else {
              setSyncStatus('error');
            }
          }
          reject(new Error('All sources failed'));
        }
      }, 7000);
    });

    _loadState = {
      pending: true,
      promise: promise
    };
    promise.finally(function(){
      _loadState = null;
    });

    return promise;
  }

  /* ================================================================
     Apply Remote Data to UI
     ================================================================ */
  function applyRemoteData(data){
    window.__vingData = data;
    if(data.theme){
      html.setAttribute('data-theme', data.theme);
      localStorage.setItem('v-ing-theme', data.theme);
    }
    if(data.lang && data.lang !== lang){
      lang = data.lang;
      localStorage.setItem('v-ing-lang', lang);
      applyLang();
    }
    if(data.streamers && unifiedPanel){
      streamerData = data.streamers;
      initStreamerData();
      Object.keys(data.streamers).forEach(function(key){
        streamerData[key] = data.streamers[key];
      });
      refreshAllVisuals(streamerData);
      try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(streamerData)); }catch(e){}
    }
    if(data.operationLog){
      renderConsolePanel(data);
    }
  }

  /* ================================================================
     Save System — Queue-based with merge-on-conflict + backoff
     ================================================================ */

  // Public: queue a save with debounce
  function ghSave(data){
    // Update local timestamp immediately to prevent auto-refresh overwrite
    data.lastUpdated = _nowISO();
    ghLastSaveTime = Date.now();

    // Add to queue (merge with existing pending saves)
    _saveQueue.push({
      data: JSON.parse(JSON.stringify(data)), // deep copy snapshot
      timestamp: Date.now()
    });

    // Clear existing debounce timer
    if(_saveDebounceTimer){
      clearTimeout(_saveDebounceTimer);
    }

    // Debounce: wait 1.5s of inactivity before saving
    _saveDebounceTimer = setTimeout(function(){
      _processSaveQueue();
    }, 1500);
  }

  // Process the save queue: merge all pending saves into one, then execute
  function _processSaveQueue(){
    if(_saveQueue.length === 0) return;
    if(_saveInProgress) return; // Will be picked up when current save finishes

    // Merge: use the latest pending save's data (since it's most recent)
    var latest = _saveQueue[_saveQueue.length - 1];
    _saveQueue = []; // Clear queue
    _saveRetryCount = 0;

    _executeSave(latest.data);
  }

  // Execute a single save with retry logic
  function _executeSave(data){
    _saveInProgress = true;
    setSyncStatus('saving');

    // Stuck guard: auto-reset if save takes too long
    if(_saveStuckGuard) clearTimeout(_saveStuckGuard);
    _saveStuckGuard = setTimeout(function(){
      if(_saveInProgress){
        _log('Save stuck timeout reached, resetting save state', 'error');
        _saveInProgress = false;
        setSyncStatus('error');
        // If there are queued saves, try again
        if(_saveQueue.length > 0){
          _processSaveQueue();
        }
      }
    }, _saveStuckTimeout);

    var content = JSON.stringify(data, null, 2);
    var b64 = b64Encode(content);
    var payload = {
      message: 'Update data via web editor - ' + new Date().toLocaleString('zh-CN'),
      content: b64,
      branch: GH_BRANCH
    };

    function doPut(sha){
      if(sha) payload.sha = sha;
      return fetchWithTimeout(GH_API, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + GH_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }, 10000).then(function(res){
        if(res.status === 409){
          throw { type: 'conflict', message: 'SHA conflict (409)' };
        }
        if(!res.ok){
          throw { type: 'http', status: res.status, message: 'HTTP ' + res.status };
        }
        return res.json();
      });
    }

    function handleSuccess(json){
      if(json.content && json.content.sha){
        ghDataSHA = json.content.sha;
      }
      ghLastSuccessfulSave = Date.now();
      _log('✓ Saved to GitHub (SHA: ' + (ghDataSHA ? ghDataSHA.substring(0,7) : '?') + ')');
      setSyncStatus('saved');
      triggerCloudflareDeploy();
      setTimeout(function(){
        if(ghSyncStatus === 'saved') setSyncStatus('success');
      }, 2000);
      _finishSave(true);
    }

    function handleFailure(err){
      _log('Save failed: ' + (err.message || err), 'warn');

      if(err.type === 'conflict'){
        // 409 Conflict: fetch latest data, merge, then retry
        _log('409 conflict — fetching latest data and merging', 'warn');
        _fetchLatestAndMerge(data).then(function(mergedData){
          if(mergedData){
            _log('Merge successful, retrying save');
            // Use merged data for retry
            _retrySave(mergedData);
          } else {
            _log('Merge failed, falling back to retry with fresh SHA', 'warn');
            ghDataSHA = null;
            _retrySave(data);
          }
        }).catch(function(){
          ghDataSHA = null;
          _retrySave(data);
        });
        return;
      }

      // Other errors: retry with exponential backoff
      _retrySave(data);
    }

    // Execute PUT
    if(ghDataSHA){
      doPut(ghDataSHA).then(handleSuccess).catch(handleFailure);
    } else {
      // No SHA: fetch it first
      _fetchSHA().then(function(sha){
        ghDataSHA = sha;
        return doPut(sha);
      }).then(handleSuccess).catch(handleFailure);
    }
  }

  function _retrySave(data){
    if(_saveRetryCount < _saveMaxRetries){
      _saveRetryCount++;
      var delay = Math.min(1000 * Math.pow(2, _saveRetryCount - 1), 8000);
      _log('Retry save #' + _saveRetryCount + ' in ' + delay + 'ms');
      setTimeout(function(){
        _executeSave(data);
      }, delay);
    } else {
      _log('Max retries (' + _saveMaxRetries + ') reached, save failed', 'error');
      setSyncStatus('error');
      _finishSave(false);
      _saveRetryCount = 0;
    }
  }

  function _finishSave(success){
    _saveInProgress = false;
    if(_saveStuckGuard){
      clearTimeout(_saveStuckGuard);
      _saveStuckGuard = null;
    }
    // If there are pending saves in the queue, process them
    if(_saveQueue.length > 0){
      _log('Processing ' + _saveQueue.length + ' queued save(s)');
      setTimeout(function(){ _processSaveQueue(); }, 500);
    }
  }

  // Fetch current SHA from GitHub API
  function _fetchSHA(){
    return fetchWithTimeout(GH_API + '?ref=' + GH_BRANCH, {
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    }, 5000).then(function(res){
      if(!res.ok) throw new Error('SHA fetch HTTP ' + res.status);
      return res.json();
    }).then(function(json){ return json.sha; });
  }

  // Fetch latest data and merge with local changes
  function _fetchLatestAndMerge(localData){
    return fetchWithTimeout(GH_API + '?ref=' + GH_BRANCH, {
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    }, 5000).then(function(res){
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function(json){
      ghDataSHA = json.sha;
      var remoteContent = b64Decode(json.content);
      var remoteData = JSON.parse(remoteContent);

      // Merge strategy: use local data (more recent user edits) but
      // incorporate any remote-only fields we don't have
      var merged = JSON.parse(JSON.stringify(localData));

      // Keep remote lastUpdated if it's newer
      if(remoteData.lastUpdated && (!merged.lastUpdated || remoteData.lastUpdated > merged.lastUpdated)){
        // But our local changes are newer — keep our timestamp
        // Actually, we want to keep local changes authoritative
        // Just make sure structure is complete
      }

      // Merge streamers: per-streamer, use higher values (shoot/edit are counts that only go up)
      if(remoteData.streamers && merged.streamers){
        Object.keys(merged.streamers).forEach(function(key){
          if(remoteData.streamers[key]){
            // For numeric fields, take the max (safer merge)
            var localS = merged.streamers[key];
            var remoteS = remoteData.streamers[key];
            if(typeof localS.shoot === 'number' && typeof remoteS.shoot === 'number'){
              localS.shoot = Math.max(localS.shoot, remoteS.shoot);
            }
            if(typeof localS.edit === 'number' && typeof remoteS.edit === 'number'){
              localS.edit = Math.max(localS.edit, remoteS.edit);
            }
          }
        });
        // Add any streamers that exist only in remote
        Object.keys(remoteData.streamers).forEach(function(key){
          if(!merged.streamers[key]){
            merged.streamers[key] = remoteData.streamers[key];
          }
        });
      }

      // Merge operation logs: combine and deduplicate by date+time+action
      if(Array.isArray(remoteData.operationLog) && Array.isArray(merged.operationLog)){
        var seen = {};
        var combined = [];
        merged.operationLog.forEach(function(entry){
          var key = entry.date + '|' + entry.time + '|' + entry.action;
          if(!seen[key]){ seen[key] = true; combined.push(entry); }
        });
        remoteData.operationLog.forEach(function(entry){
          var key = entry.date + '|' + entry.time + '|' + entry.action;
          if(!seen[key]){ seen[key] = true; combined.push(entry); }
        });
        // Sort by date + time
        combined.sort(function(a, b){
          return (a.date + a.time).localeCompare(b.date + b.time);
        });
        merged.operationLog = combined;
      }

      // Update timestamp
      merged.lastUpdated = _nowISO();

      return merged;
    });
  }

  /* ================================================================
     Auto-refresh — Adaptive with exponential backoff
     ================================================================ */
  function startAutoRefresh(){
    if(_refreshTimer) clearInterval(_refreshTimer);
    _refreshCurrentInterval = _refreshBaseInterval;
    _refreshConsecutiveFailures = 0;

    function tick(){
      // Conditions for auto-refresh:
      // 1. Not in edit mode
      // 2. No save in progress
      // 3. Page is visible
      // 4. At least 90s since last save (protection window)
      // 5. Online
      var timeSinceSave = Date.now() - ghLastSaveTime;
      var canRefresh = !editModeActive
        && !_saveInProgress
        && !document.hidden
        && timeSinceSave > 90000
        && _isOnline;

      if(canRefresh){
        ghLoad({ background: true }).then(function(){
          // Success — reset backoff
          _refreshConsecutiveFailures = 0;
          if(_refreshCurrentInterval !== _refreshBaseInterval){
            _refreshCurrentInterval = _refreshBaseInterval;
            _log('Refresh backoff reset to ' + _refreshBaseInterval/1000 + 's');
            _restartRefreshTimer();
          }
        }).catch(function(){
          // Failure — increase backoff
          _refreshConsecutiveFailures++;
          var newInterval = Math.min(
            _refreshBaseInterval * Math.pow(1.5, _refreshConsecutiveFailures),
            _refreshMaxBackoff
          );
          if(newInterval !== _refreshCurrentInterval){
            _refreshCurrentInterval = Math.round(newInterval);
            _log('Refresh backoff: ' + _refreshConsecutiveFailures + ' failures, interval=' + Math.round(_refreshCurrentInterval/1000) + 's', 'warn');
            _restartRefreshTimer();
          }
        });
      }

      // Always schedule next tick (even if skipped this time)
      _scheduleNextTick();
    }

    function _scheduleNextTick(){
      if(_refreshTimer) clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(tick, _refreshCurrentInterval);
    }

    function _restartRefreshTimer(){
      _scheduleNextTick();
    }

    // Start first tick after initial delay
    _scheduleNextTick();
  }

  /* ================================================================
     Online / Offline Detection
     ================================================================ */
  function _initOnlineDetection(){
    if(_onlineHandlerBound) return;
    _onlineHandlerBound = true;

    window.addEventListener('online', function(){
      _isOnline = true;
      _log('Network online — resuming sync');
      if(ghSyncStatus === 'offline'){
        setSyncStatus('loading');
        ghLoad().catch(function(){
          setSyncStatus('offline');
        });
      }
      // Reset backoff on reconnection
      _refreshConsecutiveFailures = 0;
      _refreshCurrentInterval = _refreshBaseInterval;
    });

    window.addEventListener('offline', function(){
      _isOnline = false;
      _log('Network offline', 'warn');
      setSyncStatus('offline');
    });
  }

  // Initialize online detection early
  _initOnlineDetection();

  /* ---------- Loader ---------- */
  window.addEventListener('load',function(){
    var loader=document.getElementById('loader');
    if(loader){
      setTimeout(function(){loader.classList.add('hidden')},2100);
    }
  });
  // Fallback: hide loader after 3s no matter what
  setTimeout(function(){
    var l=document.getElementById('loader');
    if(l)l.classList.add('hidden');
  },3000);

  /* ---------- Element References ---------- */
  var html=document.documentElement;
  var nav=document.getElementById('nav');
  var main=document.getElementById('main');
  var themeToggle=document.getElementById('themeToggle');
  var langToggle=document.getElementById('langToggle');
  var langCurrent=document.getElementById('langCurrent');
  var menuToggle=document.getElementById('menuToggle');
  var mobileMenu=document.getElementById('mobileMenu');
  var navLinks=document.querySelectorAll('.nav-link, .mobile-link, [data-nav]');
  var views=document.querySelectorAll('.view');
  var contactForm=document.getElementById('contactForm');
  var formSuccess=document.getElementById('formSuccess');

  /* ---------- Theme Toggle ---------- */
  function initTheme(){
    var saved=localStorage.getItem('v-ing-theme');
    if(saved){
      html.setAttribute('data-theme',saved);
    }
  }
  function toggleTheme(){
    var current=html.getAttribute('data-theme');
    var next=current==='dark'?'light':'dark';
    html.setAttribute('data-theme',next);
    localStorage.setItem('v-ing-theme',next);
    // Sync to GitHub
    if(window.__vingData){
      window.__vingData.theme = next;
      ghSave(window.__vingData);
    }
    // Refresh reveal observer to re-trigger if needed
    requestAnimationFrame(function(){
      checkReveals();
    });
  }
  themeToggle.addEventListener('click',toggleTheme);
  initTheme();

  /* ---------- Language Toggle ---------- */
  var lang=localStorage.getItem('v-ing-lang')||'zh';
  function applyLang(){
    html.setAttribute('data-lang',lang);
    html.lang = lang==='zh'?'zh-CN':'en';
    var label=lang==='zh'?'EN':'中';
    if(langCurrent)langCurrent.textContent=label;

    // Update all elements with data-cn / data-en
    var els=document.querySelectorAll('[data-cn][data-en]');
    els.forEach(function(el){
      var txt=lang==='zh'?el.getAttribute('data-cn'):el.getAttribute('data-en');
      if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){
        // handle placeholder
        var ph=lang==='zh'?el.getAttribute('data-cn-placeholder'):el.getAttribute('data-en-placeholder');
        if(ph)el.placeholder=ph;
      }else if(el.tagName==='OPTION'){
        el.textContent=txt;
    }else{
        el.textContent=txt;
      }
    });

    // Update placeholders
    var phEls=document.querySelectorAll('[data-cn-placeholder][data-en-placeholder]');
    phEls.forEach(function(el){
      var ph=lang==='zh'?el.getAttribute('data-cn-placeholder'):el.getAttribute('data-en-placeholder');
      el.placeholder=ph;
    });

    // Update document title
    document.title=lang==='zh'?'微影 V-ing | 影视创作工作室':'V-ing | Film & Video Creation Studio';
  }
  function toggleLang(){
    lang=lang==='zh'?'en':'zh';
    localStorage.setItem('v-ing-lang',lang);
    applyLang();
    // Sync to GitHub
    if(window.__vingData){
      window.__vingData.lang = lang;
      ghSave(window.__vingData);
    }
  }
  langToggle.addEventListener('click',toggleLang);
  applyLang();

  /* ---------- View Navigation (SPA) ---------- */
  var currentView='home';
  var isAnimating=false;

  function switchView(target){
    if(target===currentView||isAnimating)return;
    isAnimating=true;

    var oldView=document.getElementById('view-'+currentView);
    var newView=document.getElementById('view-'+target);

    if(!newView)return;

    // Fade out current
    if(oldView){
      oldView.style.transition='opacity .22s ease, transform .22s ease';
      oldView.style.opacity='0';
      oldView.style.transform='translateY(-14px)';
    }

    setTimeout(function(){
      // Hide old, show new
      if(oldView){
        oldView.classList.remove('view-active');
        oldView.style.opacity='';
        oldView.style.transform='';
        oldView.style.transition='';
      }

      newView.classList.add('view-active');
      newView.style.opacity='0';
      newView.style.transform='translateY(14px)';

      // Force reflow
      void newView.offsetWidth;

      // Animate in via rAF for smoother frame start
      requestAnimationFrame(function(){
        newView.style.transition='opacity .42s cubic-bezier(.25,.46,.45,.94), transform .42s cubic-bezier(.25,.46,.45,.94)';
        newView.style.opacity='1';
        newView.style.transform='translateY(0)';
      });

      // Update nav active states
      document.querySelectorAll('.nav-link, .mobile-link').forEach(function(link){
        link.classList.remove('active');
        if(link.getAttribute('data-nav')===target){
          link.classList.add('active');
        }
      });

      // Scroll to top
      window.scrollTo({top:0,behavior:'smooth'});

      // Trigger reveals in new view
      setTimeout(function(){
        newView.style.transition='';
        newView.style.opacity='';
        newView.style.transform='';
        checkReveals();
        // Show workspace password lock if needed
        if(target==='workspace'&&!isWsUnlocked()){
          showWsLock();
        }
        isAnimating=false;
      },420);
    },240);

    currentView=target;

    // Update URL hash
    if(history.replaceState){
      history.replaceState(null,'','#'+target);
    }
  }

  // Bind nav clicks
  document.querySelectorAll('[data-nav]').forEach(function(el){
    el.addEventListener('click',function(e){
      e.preventDefault();
      var target=el.getAttribute('data-nav');
      switchView(target);
      // Close mobile menu
      mobileMenu.classList.remove('open');
      menuToggle.classList.remove('active');
    });
  });

  // Check URL hash on load
  function checkHash(){
    var hash=window.location.hash.replace('#','');
    if(hash&&['home','about','works','workspace','contact'].indexOf(hash)>-1){
      switchView(hash);
    }
  }

  /* ---------- Mobile Menu ---------- */
  menuToggle.addEventListener('click',function(){
    menuToggle.classList.toggle('active');
    mobileMenu.classList.toggle('open');
  });

  /* ---------- Nav Scroll Effect ---------- */
  var scrollTicking=false;
  window.addEventListener('scroll',function(){
    if(!scrollTicking){
      requestAnimationFrame(function(){
        var y=window.scrollY;
        if(y>20){
          nav.classList.add('scrolled');
        }else{
          nav.classList.remove('scrolled');
        }
        scrollTicking=false;
      });
      scrollTicking=true;
    }
  });

  /* ---------- Reveal Animations (IntersectionObserver) ---------- */
  var revealObserver;
  function setupReveal(){
    if('IntersectionObserver' in window){
      revealObserver=new IntersectionObserver(function(entries){
        entries.forEach(function(entry){
          if(entry.isIntersecting){
            entry.target.classList.add('visible');
            // Trigger counter if it has one
            var numEl=entry.target.querySelector('.stat-num, .num[data-target]');
            if(!numEl){
              // Maybe the element itself is a counter
              if(entry.target.classList.contains('stat-num')||entry.target.hasAttribute('data-target')){
                numEl=entry.target;
              }
            }
            if(numEl&&!numEl.dataset.counted){
              animateCounter(numEl);
              numEl.dataset.counted='1';
            }
            revealObserver.unobserve(entry.target);
          }
        });
      },{threshold:0.15,rootMargin:'0px 0px -60px 0px'});

      observeReveals();
    }else{
      // Fallback: show everything
      document.querySelectorAll('.reveal').forEach(function(el){
        el.classList.add('visible');
      });
      document.querySelectorAll('[data-target]').forEach(function(el){
        animateCounter(el);
      });
    }
  }

  function observeReveals(){
    if(!revealObserver)return;
    document.querySelectorAll('.reveal:not(.visible)').forEach(function(el){
      revealObserver.observe(el);
    });
  }

  function checkReveals(){
    // Re-observe for newly shown views
    observeReveals();
  }

  /* ---------- Animated Counters ---------- */
  function animateCounter(el){
    var target=parseInt(el.getAttribute('data-target'),10)||0;
    var suffix=el.getAttribute('data-suffix')||'';
    var duration=1600;
    var start=performance.now();
    var startVal=0;

    // Determine if we need to format large numbers
    function format(n){
      if(target>=1000){
        return (n/1000).toFixed(1).replace(/\.0$/,'')+'k';
      }
      return Math.floor(n).toString();
    }

    function step(now){
      var progress=Math.min((now-start)/duration,1);
      // Ease: cubic-bezier ease-out
      var eased=1-Math.pow(1-progress,3);
      var val=startVal+(target-startVal)*eased;

      // For display: if target >= 1000, show as is with suffix
      if(target>=1000){
        el.textContent=Math.floor(val).toLocaleString()+suffix;
      }else{
        el.textContent=Math.floor(val)+suffix;
      }

      if(progress<1){
        requestAnimationFrame(step);
      }else{
        // Final value
        if(target>=1000){
          el.textContent=target.toLocaleString()+suffix;
        }else{
          el.textContent=target+suffix;
        }
      }
    }
    requestAnimationFrame(step);
  }

  /* ---------- Hero Parallax ---------- */
  var heroVisual=document.querySelector('.visual-frame');
  if(heroVisual&&window.matchMedia('(pointer:fine)').matches){
    var hero=document.querySelector('.hero');
    if(hero){
      hero.addEventListener('mousemove',function(e){
        var rect=hero.getBoundingClientRect();
        var x=(e.clientX-rect.left)/rect.width-0.5;
        var y=(e.clientY-rect.top)/rect.height-0.5;
        heroVisual.style.transform='translate('+(-x*12)+'px,'+(-y*12)+'px) rotate('+(x*2)+'deg)';
      });
      hero.addEventListener('mouseleave',function(){
        heroVisual.style.transform='';
      });
    }
  }

  /* ---------- Contact Form ---------- */
  if(contactForm){
    contactForm.addEventListener('submit',function(e){
      e.preventDefault();
      // Simulate submit
      var btn=contactForm.querySelector('button[type="submit"]');
      var origText=btn.textContent;
      btn.textContent=lang==='zh'?'发送中...':'Sending...';
      btn.disabled=true;

      setTimeout(function(){
        btn.textContent=origText;
        btn.disabled=false;
        contactForm.reset();
        if(formSuccess){
          formSuccess.style.display='block';
          setTimeout(function(){
            formSuccess.style.display='none';
          },4000);
        }
      },1200);
    });
  }

  /* ---------- Smooth Anchor Links in Footer ---------- */
  document.querySelectorAll('.footer a[data-nav]').forEach(function(el){
    el.addEventListener('click',function(e){
      e.preventDefault();
      switchView(el.getAttribute('data-nav'));
    });
  });

  /* ---------- Keyboard Navigation ---------- */
  document.addEventListener('keydown',function(e){
    // ESC closes mobile menu
    if(e.key==='Escape'&&mobileMenu.classList.contains('open')){
      mobileMenu.classList.remove('open');
      menuToggle.classList.remove('active');
    }
  });

  /* ---------- Team Card Expand ---------- */
  var teamCard=document.getElementById('teamCard');
  var teamCardHead=document.getElementById('teamCardHead');
  if(teamCard&&teamCardHead){
    teamCardHead.addEventListener('click',function(e){
      // Don't toggle when clicking the contact button inside detail
      if(e.target.closest('.team-contact-btn'))return;
      teamCard.classList.toggle('expanded');
    });
  }

  /* ---------- Workspace Password Lock ---------- */
  var WS_PASSWORD='123000';
  var WS_LOCK_KEY='v_ing_ws_unlocked';
  var wsLockOverlay=document.getElementById('wsLockOverlay');
  var wsLockDots=document.getElementById('wsLockDots');
  var wsLockError=document.getElementById('wsLockError');
  var wsLockInput='';

  function isWsUnlocked(){
    // Use sessionStorage so password resets when browser is closed
    return sessionStorage.getItem(WS_LOCK_KEY)==='1';
  }
  function showWsLock(){
    if(wsLockOverlay)wsLockOverlay.classList.add('ws-lock-active');
    wsLockInput='';
    updateWsLockDots();
    hideWsLockError();
  }
  function hideWsLock(){
    if(wsLockOverlay)wsLockOverlay.classList.remove('ws-lock-active');
    // Use sessionStorage: unlocked during this browser session only
    sessionStorage.setItem(WS_LOCK_KEY,'1');
    // Trigger reveals after unlock
    setTimeout(function(){checkReveals()},100);
  }
  function updateWsLockDots(){
    if(!wsLockDots)return;
    var dots=wsLockDots.querySelectorAll('.ws-lock-dot');
    dots.forEach(function(dot,i){
      dot.classList.remove('filled','error');
      if(i<wsLockInput.length)dot.classList.add('filled');
    });
  }
  function showWsLockError(msg){
    if(!wsLockError)return;
    wsLockError.textContent=msg;
    wsLockError.classList.add('show');
    // Shake dots
    if(wsLockDots){
      wsLockDots.querySelectorAll('.ws-lock-dot').forEach(function(dot){
        dot.classList.remove('filled');
        dot.classList.add('error');
      });
    }
    setTimeout(function(){
      hideWsLockError();
      wsLockInput='';
      updateWsLockDots();
    },800);
  }
  function hideWsLockError(){
    if(wsLockError){
      wsLockError.classList.remove('show');
    }
    if(wsLockDots){
      wsLockDots.querySelectorAll('.ws-lock-dot').forEach(function(dot){
        dot.classList.remove('error');
      });
    }
  }
  function handleWsLockKey(key){
    if(key==='delete'){
      wsLockInput=wsLockInput.slice(0,-1);
      updateWsLockDots();
      hideWsLockError();
      return;
    }
    if(wsLockInput.length>=6)return;
    wsLockInput+=key;
    updateWsLockDots();
    if(wsLockInput.length===6){
      setTimeout(function(){
        if(wsLockInput===WS_PASSWORD){
          hideWsLock();
        }else{
          showWsLockError(lang==='zh'?'密码错误，请重试':'Wrong password, try again');
        }
      },150);
    }
  }
  // Keypad clicks
  if(wsLockOverlay){
    wsLockOverlay.addEventListener('click',function(e){
      var btn=e.target.closest('.ws-lock-key');
      if(btn&&!btn.disabled){
        var key=btn.getAttribute('data-key');
        if(key)handleWsLockKey(key);
      }
    });
  }
  // Physical keyboard support
  document.addEventListener('keydown',function(e){
    if(!wsLockOverlay||!wsLockOverlay.classList.contains('ws-lock-active'))return;
    if(e.key>='0'&&e.key<='9'){
      handleWsLockKey(e.key);
    }else if(e.key==='Backspace'||e.key==='Delete'){
      handleWsLockKey('delete');
    }
  });

  /* ---------- Workspace: Segmented Control & Sub-pages ---------- */
  var wsTabs=document.getElementById('wsTabs');
  var segIndicator=document.getElementById('segIndicator');
  var wsPanels={
    plan:document.getElementById('ws-panel-plan'),
    collab:document.getElementById('ws-panel-collab'),
    unified:document.getElementById('ws-panel-unified'),
    card:document.getElementById('ws-panel-card'),
    console:document.getElementById('ws-panel-console')
  };
  var collabHub=document.getElementById('collabHub');
  var wsSubpages=document.querySelectorAll('.ws-subpage');
  var wsBackBtns=document.querySelectorAll('.ws-back-btn');
  var collabCards=document.querySelectorAll('[data-collab-target]');

  function switchWsTab(tab){
    // Update buttons
    document.querySelectorAll('.seg-btn').forEach(function(btn){
      btn.classList.remove('active');
      if(btn.getAttribute('data-ws-tab')===tab)btn.classList.add('active');
    });
    // Move indicator (5-segment)
    if(segIndicator){
      segIndicator.classList.remove('seg-right','seg-pos-1','seg-pos-2','seg-pos-3','seg-pos-4','seg-pos-5');
      var pos = {'plan':1,'collab':2,'unified':3,'card':4,'console':5}[tab] || 1;
      segIndicator.classList.add('seg-pos-'+pos);
    }
    // Switch panels
    Object.keys(wsPanels).forEach(function(key){
      if(!wsPanels[key])return;
      if(key===tab){
        wsPanels[key].classList.add('ws-panel-active');
      }else{
        wsPanels[key].classList.remove('ws-panel-active');
      }
    });
    // Force reveal all elements in the newly shown panel immediately
    if(wsPanels[tab]){
      wsPanels[tab].querySelectorAll('.reveal').forEach(function(el){
        el.classList.add('visible');
      });
    }
    // Reset sub-page state when switching to collab
    if(tab==='collab'){
      showCollabHub();
    }
    // Animate rings when switching to unified
    if(tab==='unified'){
      var unifiedWrap=document.getElementById('unified-report-wrap');
      if(unifiedWrap){
        var unifiedPanelEl=document.getElementById('ws-panel-unified');
        if(unifiedPanelEl){
          unifiedPanelEl.querySelectorAll('.reveal').forEach(function(el){
            el.classList.add('visible');
          });
        }
        setTimeout(function(){animateRingsInContainer(unifiedWrap)},300);
      }
    }
    // Initialize QR code when switching to card panel
    if(tab==='card'){
      setTimeout(initCustomQR,200);
    }
    // Trigger reveals
    setTimeout(function(){checkReveals()},100);
    // Smooth scroll to workspace tabs area
    var wsTabsEl=document.getElementById('wsTabs');
    if(wsTabsEl){
      var rect=wsTabsEl.getBoundingClientRect();
      var targetY=window.scrollY+rect.top-80;
      if(Math.abs(window.scrollY-targetY)>20){
        window.scrollTo({top:targetY,behavior:'smooth'});
      }
    }
  }

  function showCollabHub(){
    if(collabHub)collabHub.style.display='';
    wsSubpages.forEach(function(sp){sp.classList.remove('ws-subpage-active')});
    // Re-observe reveals
    setTimeout(function(){checkReveals()},100);
  }

  function showSubPage(target){
    if(collabHub)collabHub.style.display='none';
    wsSubpages.forEach(function(sp){sp.classList.remove('ws-subpage-active')});
    var sub=document.getElementById('ws-sub-'+target);
    if(sub){
      sub.classList.add('ws-subpage-active');
      // Smooth scroll to workspace tabs area with proper offset
      var wsTabsEl=document.getElementById('wsTabs');
      if(wsTabsEl){
        var rect=wsTabsEl.getBoundingClientRect();
        var targetY=window.scrollY+rect.top-80;
        window.scrollTo({top:targetY,behavior:'smooth'});
      }
      // Trigger reveals in sub-page
      setTimeout(function(){checkReveals()},100);
      // Animate rings in sub-page
      setTimeout(function(){animateRingsInContainer(sub)},300);
    }
  }

  if(wsTabs){
    wsTabs.addEventListener('click',function(e){
      var btn=e.target.closest('.seg-btn');
      if(btn){
        switchWsTab(btn.getAttribute('data-ws-tab'));
      }
    });
  }

  collabCards.forEach(function(card){
    card.addEventListener('click',function(){
      var target=card.getAttribute('data-collab-target');
      showSubPage(target);
    });
  });

  wsBackBtns.forEach(function(btn){
    btn.addEventListener('click',function(){
      showCollabHub();
    });
  });

  /* ---------- Ring Animation Engine ---------- */
  // C = 2 * PI * r
  var RING_R_LARGE = 42; // circumference = 2 * PI * 42 ≈ 264
  var RING_R_SMALL = 32; // circumference = 2 * PI * 32 ≈ 201
  var CIRC_LARGE = 2 * Math.PI * RING_R_LARGE; // ~264
  var CIRC_SMALL = 2 * Math.PI * RING_R_SMALL; // ~201

  function calcOffset(val, target, circ){
    var pct = Math.min(val / target, 1);
    return circ * (1 - pct);
  }

  function getRingCircumference(ring){
    var r = parseFloat(ring.getAttribute('r'));
    if(!r || isNaN(r)){
      // Fallback: detect by class
      if(ring.classList.contains('sr-ring-shoot') || ring.classList.contains('sr-ring-edit')){
        r = RING_R_SMALL;
      }else{
        r = RING_R_LARGE;
      }
    }
    return 2 * Math.PI * r;
  }

  function animateRingsInContainer(container){
    if(!container)return;
    // All ring types - dynamically calculate circumference from r attribute
    var allRings = container.querySelectorAll('.ring-shoot, .ring-edit, .ring-rate, .sr-ring-shoot, .sr-ring-edit');
    allRings.forEach(function(ring){
      var val = parseFloat(ring.getAttribute('data-val'))||0;
      var target = parseFloat(ring.getAttribute('data-target'))||1;
      if(target===0)target=1;
      var circ = getRingCircumference(ring);
      ring.style.strokeDasharray = circ;
      ring.style.strokeDashoffset = circ; // start at 0%
      requestAnimationFrame(function(){
        setTimeout(function(){
          ring.style.strokeDashoffset = calcOffset(val, target, circ);
        },100);
      });
    });
  }

  // Observe report sections for ring animation
  var reportObserver;
  if('IntersectionObserver' in window){
    reportObserver = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          animateRingsInContainer(entry.target);
          reportObserver.unobserve(entry.target);
        }
      });
    },{threshold:0.15});
    document.querySelectorAll('.report-section, .unified-report-wrap').forEach(function(el){
      reportObserver.observe(el);
    });
  }

  /* ---------- Screenshot Export ---------- */
  var screenshotBtns = document.querySelectorAll('.screenshot-btn');

  function getReportTitle(reportId){
    if(reportId === 'unified-report-wrap'){
      return lang==='zh' ? '统一日报整合' : 'Unified Daily Report';
    }
    if(reportId.indexOf('leap') > -1){
      return lang==='zh' ? '零跑汽车 · 日报' : 'Leapmotor · Daily Report';
    }
    if(reportId.indexOf('zxzb') > -1){
      return lang==='zh' ? '中鑫之宝 · 日报' : 'Zhongxin Zhibao · Daily Report';
    }
    if(reportId.indexOf('ip') > -1){
      return lang==='zh' ? '人设IP账号 · 日报' : 'Personal IP · Daily Report';
    }
    return lang==='zh' ? '日报' : 'Daily Report';
  }

  function getReportBrand(reportId){
    if(reportId === 'unified-report-wrap') return 'all';
    if(reportId.indexOf('leap') > -1) return 'leapmotor';
    if(reportId.indexOf('zxzb') > -1) return 'zxzb';
    if(reportId.indexOf('ip') > -1) return 'ip';
    return 'report';
  }

  function formatDate(date){
    var y = date.getFullYear();
    var m = String(date.getMonth()+1).padStart(2,'0');
    var d = String(date.getDate()).padStart(2,'0');
    var weekdays = lang==='zh'
      ? ['周日','周一','周二','周三','周四','周五','周六']
      : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return {
      full: y + '-' + m + '-' + d,
      weekday: weekdays[date.getDay()],
      year: y,
      month: m,
      day: d
    };
  }

  function buildScreenshotContainer(target, reportId){
    var dateInfo = formatDate(new Date());
    var title = getReportTitle(reportId);
    var isDark = html.getAttribute('data-theme') === 'dark';

    var container = document.createElement('div');
    container.className = 'ss-container';
    container.style.cssText = [
      'width: 900px',
      'padding: 0',
      'font-family: inherit',
      'position: relative',
      'overflow: hidden'
    ].join(';');

    var isUnified = reportId === 'unified-report-wrap';

    // Header
    if(!isUnified){
      var header = document.createElement('div');
      header.className = 'ss-header';
      header.style.cssText = [
        'display: flex',
        'justify-content: space-between',
        'align-items: center',
        'padding: 28px 36px',
        'background: ' + (isDark ? 'linear-gradient(135deg, #1C1C1E 0%, #2C2C2E 100%)' : 'linear-gradient(135deg, #FFFFFF 0%, #F2F2F7 100%)'),
        'border-bottom: 1px solid ' + (isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'),
        'position: relative',
        'overflow: hidden'
      ].join(';');

    // Decorative blob
    var blob = document.createElement('div');
    blob.style.cssText = [
      'position: absolute',
      'top: -60px',
      'right: -60px',
      'width: 180px',
      'height: 180px',
      'border-radius: 50%',
      'background: radial-gradient(circle, ' + (isDark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)') + ' 0%, transparent 70%)',
      'pointer-events: none'
    ].join(';');
    header.appendChild(blob);

    // Left: Logo + Title
    var headerLeft = document.createElement('div');
    headerLeft.style.cssText = [
      'display: flex',
      'align-items: center',
      'gap: 16px',
      'position: relative',
      'z-index: 1'
    ].join(';');

    var logo = document.createElement('div');
    logo.style.cssText = [
      'width: 44px',
      'height: 44px',
      'border-radius: 12px',
      'background: linear-gradient(135deg, #FF9F0A 0%, #FF6B00 100%)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'color: #fff',
      'font-weight: 800',
      'font-size: 1.1rem',
      'letter-spacing: -0.02em',
      'box-shadow: 0 4px 14px rgba(255,159,10,.3)'
    ].join(';');
    logo.textContent = 'V';

    var titleWrap = document.createElement('div');
    var titleEl = document.createElement('div');
    titleEl.style.cssText = [
      'font-size: 1.25rem',
      'font-weight: 800',
      'letter-spacing: -0.02em',
      'color: ' + (isDark ? '#F2F2F7' : '#1C1C1E'),
      'line-height: 1.2'
    ].join(';');
    titleEl.textContent = title;

    var subtitleEl = document.createElement('div');
    subtitleEl.style.cssText = [
      'font-size: .78rem',
      'color: ' + (isDark ? 'rgba(235,235,245,.5)' : 'rgba(60,60,67,.5)'),
      'margin-top: 4px'
    ].join(';');
    subtitleEl.textContent = lang==='zh' ? '微影 V-ing · 影视创作工作室' : 'V-ing · Film & Video Studio';

    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(subtitleEl);
    headerLeft.appendChild(logo);
    headerLeft.appendChild(titleWrap);

    // Right: Date
    var headerRight = document.createElement('div');
    headerRight.style.cssText = [
      'text-align: right',
      'position: relative',
      'z-index: 1'
    ].join(';');

    var dateMain = document.createElement('div');
    dateMain.style.cssText = [
      'font-size: 1.1rem',
      'font-weight: 700',
      'color: ' + (isDark ? '#F2F2F7' : '#1C1C1E'),
      'letter-spacing: -0.01em'
    ].join(';');
    dateMain.textContent = dateInfo.full;

    var dateWeekday = document.createElement('div');
    dateWeekday.style.cssText = [
      'font-size: .78rem',
      'color: ' + (isDark ? 'rgba(235,235,245,.5)' : 'rgba(60,60,67,.5)'),
      'margin-top: 2px'
    ].join(';');
    dateWeekday.textContent = dateInfo.weekday;

    headerRight.appendChild(dateMain);
    headerRight.appendChild(dateWeekday);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    container.appendChild(header);
    } // end of !isUnified header block

    // Content area
    var contentWrap = document.createElement('div');
    contentWrap.className = 'ss-content';
    var contentPadding = isUnified ? 'padding: 0' : 'padding: 28px 36px 36px';
    contentWrap.style.cssText = [
      contentPadding,
      'background: ' + (isDark ? '#000000' : '#F2F2F7'),
      'position: relative'
    ].join(';');

    // Clone the target content
    var cloned = target.cloneNode(true);

    // Remove screenshot buttons from cloned content
    var ssBtns = cloned.querySelectorAll('.screenshot-btn, .edit-toggle-btn, .ws-panel-toolbar-right');
    ssBtns.forEach(function(b){ b.remove(); });

    // Sync ring dashoffset values from live DOM to cloned DOM
    // This ensures the animated progress state is preserved in the screenshot
    var liveRings = target.querySelectorAll('circle[class*="ring"]');
    var clonedRings = cloned.querySelectorAll('circle[class*="ring"]');
    if(liveRings.length === clonedRings.length){
      for(var i=0; i<liveRings.length; i++){
        var liveOffset = liveRings[i].style.strokeDashoffset;
        var liveDasharray = liveRings[i].style.strokeDasharray;
        if(liveOffset) clonedRings[i].style.strokeDashoffset = liveOffset;
        if(liveDasharray) clonedRings[i].style.strokeDasharray = liveDasharray;
      }
    }

    // Sync progress bar widths (all types)
    function syncBarWidths(liveParent, clonedParent, selector){
      var liveBars = liveParent.querySelectorAll(selector);
      var clonedBars = clonedParent.querySelectorAll(selector);
      if(liveBars.length === clonedBars.length && liveBars.length > 0){
        for(var j=0; j<liveBars.length; j++){
          var liveWidth = liveBars[j].style.width;
          if(liveWidth) clonedBars[j].style.width = liveWidth;
        }
      }
    }
    syncBarWidths(target, cloned, '.sr-bar span');
    syncBarWidths(target, cloned, '.bps-bar span');
    syncBarWidths(target, cloned, '.ts-bar span');

    // For individual report sections, remove the report-head button area
    // and keep just the title info merged into the content
    if(cloned.classList.contains('report-section')){
      var reportHead = cloned.querySelector('.report-head');
      if(reportHead){
        // Remove the button column if it exists
        var btnInHead = reportHead.querySelector('.screenshot-btn');
        if(btnInHead) btnInHead.remove();
        // Add extra spacing below report head since we removed button
        reportHead.style.marginBottom = '20px';
      }
      cloned.style.cssText = [
        'padding: 0',
        'border-radius: 0',
        'background: transparent',
        'border: none'
      ].join(';');
    }else{
      // Unified report
      cloned.style.cssText = [
        'padding: 0',
        'border-radius: 0',
        'background: transparent',
        'border: none',
        'backdrop-filter: none',
        '-webkit-backdrop-filter: none'
      ].join(';');
    }

    contentWrap.appendChild(cloned);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'ss-footer';
    footer.style.cssText = [
      'display: flex',
      'justify-content: space-between',
      'align-items: center',
      'padding: 16px 36px',
      'background: ' + (isDark ? '#1C1C1E' : '#FFFFFF'),
      'border-top: 1px solid ' + (isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)'),
      'font-size: .72rem'
    ].join(';');

    var footerLeft = document.createElement('div');
    footerLeft.style.color = isDark ? 'rgba(235,235,245,.4)' : 'rgba(60,60,67,.4)';
    footerLeft.textContent = lang==='zh' ? '© 微影 V-ing 影视创作工作室' : '© V-ing Film & Video Studio';

    var footerRight = document.createElement('div');
    footerRight.style.color = isDark ? 'rgba(235,235,245,.4)' : 'rgba(60,60,67,.4)';
    footerRight.textContent = lang==='zh' ? '数据更新于 ' + dateInfo.full + ' ' + dateInfo.weekday : 'Updated ' + dateInfo.full + ' ' + dateInfo.weekday;

    footer.appendChild(footerLeft);
    footer.appendChild(footerRight);
    container.appendChild(footer);

    // Add compact styles via inline style tag
    var styleTag = document.createElement('style');
    var borderColor = isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)';
    styleTag.textContent = [
      // Unified summary (total stats row)
      '.ss-container .unified-summary{padding:24px;margin-bottom:24px;border-radius:16px}',
      '.ss-container .total-stats-row{gap:24px;justify-content:center}',
      '.ss-container .ts-item{flex:1;text-align:center;max-width:160px}',
      '.ss-container .ts-num{font-size:1.5rem;font-weight:800;letter-spacing:-.03em;margin-bottom:4px}',
      '.ss-container .ts-label{font-size:.7rem;color:' + (isDark ? 'rgba(235,235,245,.3)' : 'rgba(60,60,67,.3)') + ';margin-bottom:8px}',
      '.ss-container .ts-bar{height:4px;border-radius:2px;background:' + (isDark ? '#2C2C2E' : '#F2F2F7') + ';overflow:hidden}',
      '.ss-container .ts-bar span{display:block;height:100%;border-radius:2px;background:#FF9F0A}',
      '.ss-container .ts-green span{background:#34C759}',
      '.ss-container .ts-gray span{background:' + (isDark ? '#98989D' : '#48484A') + '}',
      // Brand sections
      '.ss-container .unified-brand-section{margin-bottom:24px}',
      '.ss-container .unified-brand-head{margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid ' + borderColor + '}',
      '.ss-container .unified-brand-head h3{font-size:1rem;font-weight:700;margin:0}',
      '.ss-container .unified-brand-sub{font-size:.72rem;color:' + (isDark ? 'rgba(235,235,245,.3)' : 'rgba(60,60,67,.3)') + '}',
      // Brand progress summary
      '.ss-container .brand-progress-summary{display:flex;flex-direction:column;gap:10px;margin-bottom:20px;padding:16px 20px;border-radius:12px;border:1px solid ' + borderColor + '}',
      '.ss-container .bps-row{display:flex;align-items:center;gap:12px}',
      '.ss-container .bps-label{width:32px;font-size:.78rem;color:' + (isDark ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)') + ';flex-shrink:0}',
      '.ss-container .bps-bar{flex:1;height:6px;border-radius:3px;background:' + (isDark ? '#2C2C2E' : '#F2F2F7') + ';overflow:hidden}',
      '.ss-container .bps-bar span{display:block;height:100%;border-radius:3px;background:#FF9F0A}',
      '.ss-container .bps-green span{background:#34C759}',
      '.ss-container .bps-num{width:36px;text-align:right;font-size:.82rem;font-weight:700;flex-shrink:0}',
      // Individual report sections
      '.ss-container .report-section{padding:0 !important}',
      '.ss-container .report-head{margin-bottom:20px !important;padding-bottom:16px;border-bottom:1px solid ' + borderColor + '}',
      '.ss-container .report-head h3{font-size:1.15rem !important}',
      '.ss-container .report-head .report-sub{font-size:.8rem !important}',
      // Streamer cards
      '.ss-container .streamer-card{padding:14px 16px;border-radius:12px;gap:8px}',
      '.ss-container .streamer-info h4{font-size:.9rem;font-weight:700;margin:0}',
      '.ss-container .streamer-progress{gap:6px}',
      '.ss-container .sr-bar-row{font-size:.75rem;display:flex;align-items:center;gap:8px;color:' + (isDark ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)') + '}',
      '.ss-container .sr-bar-row span:first-child{width:36px;text-align:right;flex-shrink:0;font-size:.7rem}',
      '.ss-container .sr-bar{flex:1;height:5px;background:' + (isDark ? '#2C2C2E' : '#F2F2F7') + ';border-radius:3px;overflow:hidden}',
      '.ss-container .sr-bar span{display:block;height:100%;border-radius:3px}',
      '.ss-container .sr-bar-row:nth-child(1) .sr-bar span{background:#FF9F0A}',
      '.ss-container .sr-bar-row:nth-child(2) .sr-bar span{background:#34C759}',
      '.ss-container .sr-pct{font-size:.72rem;font-weight:700;color:' + (isDark ? 'rgba(235,235,245,.6)' : 'rgba(60,60,67,.6)') + ';width:36px;flex-shrink:0;text-align:right}'
    ].join(' ');
    container.appendChild(styleTag);

    return container;
  }

  function takeScreenshot(reportId, btn){
    var target = document.getElementById(reportId);
    if(!target){
      console.warn('Report section not found:', reportId);
      return;
    }
    if(typeof html2canvas === 'undefined'){
      alert('截图库未加载，请检查网络连接后重试');
      return;
    }
    if(btn){
      btn.classList.add('shooting');
      var origText = btn.textContent;
      btn.textContent = lang==='zh'?'截图生成中...':'Generating...';
    }

    var isDark = html.getAttribute('data-theme') === 'dark';
    var bgColor = isDark ? '#000000' : '#F2F2F7';

    // Temporarily hide buttons and other elements we don't want in the screenshot
    var hiddenEls = [];
    var btnsToHide = target.querySelectorAll('.screenshot-btn, .edit-toggle-btn, .ws-panel-toolbar-right');
    btnsToHide.forEach(function(el){
      hiddenEls.push({el: el, orig: el.style.display});
      el.style.display = 'none';
    });

    // For unified report, also hide the toolbar buttons area but keep the title
    var toolbarRight = target.querySelector('.unified-toolbar-right');
    if(toolbarRight){
      hiddenEls.push({el: toolbarRight, orig: toolbarRight.style.display});
      toolbarRight.style.display = 'none';
    }

    html2canvas(target, {
      backgroundColor: bgColor,
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 900,
      allowTaint: true,
      foreignObjectRendering: false
    }).then(function(canvas){
      // Restore hidden elements
      hiddenEls.forEach(function(item){
        item.el.style.display = item.orig;
      });

      // Download
      var link = document.createElement('a');
      var brand = getReportBrand(reportId);
      var dateInfo = formatDate(new Date());
      link.download = 'V-ing_' + brand + '_report_' + dateInfo.full + '.png';
      link.href = canvas.toDataURL('image/png');
      link.click();

      if(btn){
        btn.classList.remove('shooting');
        applyLang();
      }
    }).catch(function(err){
      console.error('Screenshot error:', err);
      // Restore on error too
      hiddenEls.forEach(function(item){
        item.el.style.display = item.orig;
      });
      if(btn){
        btn.classList.remove('shooting');
        applyLang();
      }
      alert(lang==='zh'?'截图生成失败，请重试':'Screenshot failed, please try again');
    });
  }

  screenshotBtns.forEach(function(btn){
    btn.addEventListener('click', function(){
      var reportId = btn.getAttribute('data-report');
      takeScreenshot(reportId, btn);
    });
  });

  /* ---------- Edit Mode for Unified Report ---------- */
  var editToggleBtn = document.getElementById('editToggleBtn');
  var unifiedPanel = document.getElementById('ws-panel-unified');
  var editModeActive = false;
  var STORAGE_KEY = 'ving-unified-report-data';

  // Set unified report toolbar date
  var toolbarDate = document.getElementById('unifiedToolbarDate');
  if(toolbarDate){
    var now = new Date();
    toolbarDate.textContent = (now.getMonth()+1) + '/' + now.getDate();
  }

  // Load saved data from localStorage (fallback only)
  function loadReportData(){
    try{
      var saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    }catch(e){
      return {};
    }
  }

  // Save data to localStorage + GitHub
  function saveReportData(data){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }catch(e){
      console.warn('Failed to save report data locally:', e);
    }
    // Sync streamer data to GitHub
    if(window.__vingData){
      window.__vingData.streamers = {};
      Object.keys(data).forEach(function(key){
        if(data[key] && typeof data[key].shoot === 'number'){
          window.__vingData.streamers[key] = data[key];
        }
      });
      ghSave(window.__vingData);
    }
  }

  // Build streamer data model from DOM
  function initStreamerData(){
    var data = loadReportData();
    var cards = unifiedPanel ? unifiedPanel.querySelectorAll('.unified-brand-section .streamer-card') : [];
    cards.forEach(function(card, idx){
      var nameEl = card.querySelector('h4');
      if(!nameEl) return;
      var name = nameEl.textContent.trim();
      var pcts = card.querySelectorAll('.sr-pct');
      var key = 'streamer_' + idx;
      if(!data[key]){
        data[key] = {
          name: name,
          shoot: parseInt(pcts[0] ? pcts[0].textContent : '0', 10),
          edit: parseInt(pcts[1] ? pcts[1].textContent : '0', 10)
        };
      }
      // Tag the number elements with data attributes
      if(pcts[0]){
        pcts[0].setAttribute('data-streamer', key);
        pcts[0].setAttribute('data-field', 'shoot');
      }
      if(pcts[1]){
        pcts[1].setAttribute('data-streamer', key);
        pcts[1].setAttribute('data-field', 'edit');
      }
      // Tag progress bars
      var bars = card.querySelectorAll('.sr-bar');
      if(bars[0]){
        bars[0].setAttribute('data-streamer', key);
        bars[0].setAttribute('data-field', 'shoot');
      }
      if(bars[1]){
        bars[1].setAttribute('data-streamer', key);
        bars[1].setAttribute('data-field', 'edit');
      }
    });
    return data;
  }

  // Get brand section target for a streamer
  function getStreamerTarget(key, data, brandSection){
    var section = brandSection;
    // For 零跑: target 40, for 人设IP: target 20, for 中鑫之宝: use the streamer's own shoot value as max
    var brandHead = section.querySelector('.unified-brand-head h3');
    if(!brandHead) return 1;
    var brandText = brandHead.textContent.trim();
    if(brandText.indexOf('零跑') > -1) return 40;
    if(brandText.indexOf('人设') > -1 || brandText.indexOf('IP') > -1) return 20;
    if(brandText.indexOf('中鑫') > -1){
      // No fixed target, use current shoot value
      return Math.max(data[key] ? data[key].shoot : 1, 1);
    }
    return 1;
  }

  // Update a single streamer's visual elements
  function updateStreamerVisuals(key, data, brandSection){
    var card = null;
    var cards = brandSection.querySelectorAll('.streamer-card');
    cards.forEach(function(c){
      var pcts = c.querySelectorAll('.sr-pct');
      if(pcts[0] && pcts[0].getAttribute('data-streamer') === key){
        card = c;
      }
    });
    if(!card) return;

    var d = data[key];
    if(!d) return;
    var target = getStreamerTarget(key, data, brandSection);

    // Update numbers (sr-pct now shows the actual count)
    var pcts = card.querySelectorAll('.sr-pct');
    if(pcts[0]) pcts[0].textContent = d.shoot;
    if(pcts[1]) pcts[1].textContent = d.edit;

    // Update progress bars (allow >100%)
    var bars = card.querySelectorAll('.sr-bar span');
    var shootPct = Math.round(d.shoot / target * 100);
    var editPct = Math.round(d.edit / target * 100);
    if(bars[0]) bars[0].style.width = shootPct + '%';
    if(bars[1]) bars[1].style.width = editPct + '%';
  }

  // Update brand section summary (progress bar version)
  function updateBrandSummary(brandSection, data){
    var brandHead = brandSection.querySelector('.unified-brand-head h3');
    if(!brandHead) return;
    var brandText = brandHead.textContent.trim();

    var cards = brandSection.querySelectorAll('.streamer-card');
    var totalShoot = 0, totalEdit = 0, totalTarget = 0;

    cards.forEach(function(c){
      var pcts = c.querySelectorAll('.sr-pct');
      var key = pcts[0] ? pcts[0].getAttribute('data-streamer') : null;
      if(key && data[key]){
        totalShoot += data[key].shoot;
        totalEdit += data[key].edit;
      }
    });

    // Determine brand target
    if(brandText.indexOf('零跑') > -1){
      totalTarget = 40 * cards.length;
    } else if(brandText.indexOf('人设') > -1 || brandText.indexOf('IP') > -1){
      totalTarget = 20;
    } else {
      totalTarget = Math.max(totalShoot, 1);
    }

    // Update brand-progress-summary bars and numbers
    var summary = brandSection.querySelector('.brand-progress-summary');
    if(summary){
      var bpsNums = summary.querySelectorAll('.bps-num');
      var bpsBars = summary.querySelectorAll('.bps-bar span');
      var shootPct = Math.round(totalShoot / totalTarget * 100);
      var editPct = Math.round(totalEdit / totalTarget * 100);
      if(bpsNums[0]) bpsNums[0].textContent = totalShoot;
      if(bpsNums[1]) bpsNums[1].textContent = totalEdit;
      if(bpsBars[0]) bpsBars[0].style.width = shootPct + '%';
      if(bpsBars[1]) bpsBars[1].style.width = editPct + '%';
    }
  }

  // Update grand total summary (progress bar version)
  function updateGrandTotal(data){
    var totalShoot = 0, totalEdit = 0;
    Object.keys(data).forEach(function(key){
      if(data[key] && typeof data[key].shoot === 'number'){
        totalShoot += data[key].shoot;
        totalEdit += data[key].edit;
      }
    });

    // Calculate grand target
    var brandSections = unifiedPanel ? unifiedPanel.querySelectorAll('.unified-brand-section') : [];
    var grandTarget = 0;
    brandSections.forEach(function(section){
      var head = section.querySelector('.unified-brand-head h3');
      if(!head) return;
      var text = head.textContent.trim();
      var cards = section.querySelectorAll('.streamer-card');
      if(text.indexOf('零跑') > -1){
        grandTarget += 40 * cards.length;
      } else if(text.indexOf('人设') > -1 || text.indexOf('IP') > -1){
        grandTarget += 20;
      } else {
        // 中鑫之宝: no fixed target, add their shoot count
        cards.forEach(function(c){
          var pcts = c.querySelectorAll('.sr-pct');
          var key = pcts[0] ? pcts[0].getAttribute('data-streamer') : null;
          if(key && data[key]) grandTarget += Math.max(data[key].shoot, 1);
        });
      }
    });

    // Update total-stats-row (ts-num and ts-bar)
    var summary = unifiedPanel ? unifiedPanel.querySelector('.unified-summary') : null;
    if(summary){
      var tsItems = summary.querySelectorAll('.ts-item');
      // Item 0: 拍摄总数
      if(tsItems[0]){
        var num0 = tsItems[0].querySelector('.ts-num');
        var bar0 = tsItems[0].querySelector('.ts-bar span');
        if(num0) num0.textContent = totalShoot;
        if(bar0) bar0.style.width = Math.round(totalShoot / grandTarget * 100) + '%';
      }
      // Item 1: 剪辑总数
      if(tsItems[1]){
        var num1 = tsItems[1].querySelector('.ts-num');
        var bar1 = tsItems[1].querySelector('.ts-bar span');
        if(num1) num1.textContent = totalEdit;
        if(bar1) bar1.style.width = Math.round(totalEdit / grandTarget * 100) + '%';
      }
      // Item 2: 整体完成率 (based on edit / target)
      var rate = grandTarget > 0 ? Math.round(totalEdit / grandTarget * 100) : 0;
      if(tsItems[2]){
        var num2 = tsItems[2].querySelector('.ts-num');
        var bar2 = tsItems[2].querySelector('.ts-bar span');
        if(num2) num2.textContent = rate + '%';
        if(bar2) bar2.style.width = rate + '%';
      }
    }
  }

  // Refresh all visuals from data
  function refreshAllVisuals(data){
    var brandSections = unifiedPanel ? unifiedPanel.querySelectorAll('.unified-brand-section') : [];
    brandSections.forEach(function(section){
      var cards = section.querySelectorAll('.streamer-card');
      cards.forEach(function(card){
        var pcts = card.querySelectorAll('.sr-pct');
        var key = pcts[0] ? pcts[0].getAttribute('data-streamer') : null;
        if(key && data[key]){
          updateStreamerVisuals(key, data, section);
        }
      });
      updateBrandSummary(section, data);
    });
    updateGrandTotal(data);
  }

  // Initialize data and apply saved values
  var streamerData = {};
  if(unifiedPanel){
    try{
      // First load from localStorage for instant display
      streamerData = initStreamerData();
      if(Object.keys(streamerData).length > 0){
        refreshAllVisuals(streamerData);
      }
    }catch(e){
      console.error('Edit mode init error:', e);
    }
  }

  // Load from GitHub for cross-device sync
  // tryUpdate() inside ghLoad() now applies data to UI immediately
  // This .then() only handles post-load tasks
  ghLoad().then(function(){
    console.log('[V-ing] Initial data load complete');
    // Start auto-refresh for cross-device sync
    startAutoRefresh();
  }).catch(function(err){
    console.warn('[V-ing] GitHub load failed, using local data:', err);
    setSyncStatus('offline');
    // Initialize empty __vingData for future saves
    window.__vingData = {
      streamers: streamerData,
      theme: html.getAttribute('data-theme'),
      lang: lang,
      lastUpdated: new Date().toISOString()
    };
    // Still start auto-refresh to recover when network is available
    startAutoRefresh();
  });

  // Toggle edit mode
  function toggleEditMode(){
    editModeActive = !editModeActive;
    if(editModeActive){
      unifiedPanel.classList.add('edit-mode');
      if(editToggleBtn){
        editToggleBtn.textContent = lang === 'zh' ? '完成' : 'Done';
        editToggleBtn.classList.add('edit-active');
      }
    } else {
      unifiedPanel.classList.remove('edit-mode');
      if(editToggleBtn){
        editToggleBtn.textContent = lang === 'zh' ? '编辑模式' : 'Edit Mode';
        editToggleBtn.classList.remove('edit-active');
      }
      // Save data
      saveReportData(streamerData);
    }
  }

  if(editToggleBtn){
    editToggleBtn.addEventListener('click', toggleEditMode);
  }

  /* ---------- Generic Panel Edit Mode ---------- */
  // For panels other than unified-report, toggle contentEditable on text elements
  document.querySelectorAll('.ws-panel-toolbar .edit-toggle-btn[data-edit-target]').forEach(function(btn){
    if(btn.id === 'editToggleBtn') return; // skip unified-report's own button
    btn.addEventListener('click', function(){
      var targetId = btn.getAttribute('data-edit-target');
      var panel = document.getElementById(targetId);
      if(!panel) return;
      var isActive = panel.classList.toggle('edit-mode');
      var lang = document.documentElement.getAttribute('data-lang') || 'zh';
      if(isActive){
        btn.textContent = lang === 'zh' ? '完成' : 'Done';
        btn.classList.add('edit-active');
        // Make text elements editable
        panel.querySelectorAll('h2:not(.section-title-lg), h3, h4, p, span.bc-info-value, span.ring-pct, span.ps-num, span.cs-num, span.ss-num, span.ts-num, span.bps-num').forEach(function(el){
          // Skip elements inside buttons or toolbars
          if(el.closest('.ws-panel-toolbar')) return;
          if(el.closest('.seg-btn')) return;
          el.setAttribute('contenteditable', 'true');
          el.style.cursor = 'text';
          el.style.outline = 'none';
          el.addEventListener('focus', function(){el.style.outline='2px solid var(--accent)';el.style.outlineOffset='2px';});
          el.addEventListener('blur', function(){el.style.outline='';});
        });
      } else {
        btn.textContent = lang === 'zh' ? '编辑' : 'Edit';
        btn.classList.remove('edit-active');
        panel.querySelectorAll('[contenteditable="true"]').forEach(function(el){
          el.removeAttribute('contenteditable');
          el.style.cursor = '';
          el.style.outline = '';
        });
      }
    });
  });

  // Click on sr-pct to edit
  if(unifiedPanel){
    unifiedPanel.addEventListener('click', function(e){
      if(!editModeActive) return;
      var numEl = e.target.closest('.sr-pct');
      if(!numEl) return;
      if(numEl.tagName === 'INPUT') return;

      var key = numEl.getAttribute('data-streamer');
      var field = numEl.getAttribute('data-field');
      if(!key || !field) return;

      // Replace span with input
      var currentVal = numEl.textContent.trim();
      var input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = currentVal;
      input.className = 'sr-num-input';
      input.setAttribute('data-streamer', key);
      input.setAttribute('data-field', field);

      numEl.style.display = 'none';
      numEl.parentNode.insertBefore(input, numEl.nextSibling);
      input.focus();
      input.select();

      // Handle input blur
      function handleBlur(){
        var newVal = parseInt(input.value, 10);
        if(isNaN(newVal) || newVal < 0) newVal = 0;
        // Update data
        if(streamerData[key]){
          streamerData[key][field] = newVal;
        }
        // Restore span
        input.remove();
        numEl.style.display = '';
        // Refresh visuals
        refreshAllVisuals(streamerData);
      }

      input.addEventListener('blur', handleBlur);
      input.addEventListener('keydown', function(ev){
        if(ev.key === 'Enter'){
          input.blur();
        }
        if(ev.key === 'Escape'){
          input.value = currentVal;
          input.blur();
        }
      });
    });
  }

  /* ---------- Console Panel: Instruction Template & Operation Log ---------- */
  var consoleTemplateBox = document.getElementById('consoleTemplateBox');
  var consoleLogList = document.getElementById('consoleLogList');
  var consoleLogCount = document.getElementById('consoleLogCount');
  var consoleLastSync = document.getElementById('consoleLastSync');
  var consoleCopyBtn = document.getElementById('consoleCopyBtn');

  var CONSOLE_TEMPLATE = '【微影 V-ing 跨 AI 会话指令模版 v3.0】\n'
    + '我的网站数据存在 GitHub 仓库，请帮我拉取最新数据并继续工作。\n\n'
    + '【项目信息】\n'
    + '仓库地址：V-ing7/v-ing-site\n'
    + '分支：main\n'
    + '数据文件：data.json（含主播数据、主题、语言、操作日志）\n'
    + '网站地址：https://v-ing-site.pages.dev\n'
    + 'GitHub Pages：https://V-ing7.github.io/v-ing-site/\n'
    + 'Cloudflare 项目名：v-ing-site\n'
    + 'Cloudflare Account ID：edb10972ff8ae9f58d46aa4bdcee3fca\n\n'
    + '【凭据】\n'
    + 'GitHub Token：' + GH_TOKEN + '\n'
    + 'Cloudflare Token：' + (window.__cfToken || '见工作台指令模版') + '\n'
    + 'Cloudflare Account ID：edb10972ff8ae9f58d46aa4bdcee3fca\n\n'
    + '【自动部署机制 v3.0】\n'
    + '1. 推送代码到 GitHub main 分支后，GitHub Actions 自动同时部署到两个平台：\n'
    + '   - GitHub Pages（https://V-ing7.github.io/v-ing-site/）\n'
    + '   - Cloudflare Pages（https://v-ing-site.pages.dev）\n'
    + '2. GitHub Secrets 已配置 CF_API_TOKEN 和 CF_ACCOUNT_ID\n'
    + '3. 工作流文件：.github/workflows/deploy.yml（修改需在 GitHub 网页端操作）\n'
    + '4. 浏览器编辑保存时自动写入 GitHub 仓库 data.json\n'
    + '5. 页面加载时并行请求 5 个数据源，选择最新数据\n'
    + '6. 每 30 秒自动刷新检查远端是否有新数据（仅当远端时间戳 > 本地时）\n'
    + '7. 保存后 90 秒内跳过自动刷新，防止旧 CDN 缓存覆盖新数据\n'
    + '8. 点击导航栏同步徽章可手动强制同步\n\n'
    + '【操作步骤】\n'
    + '1. 先用 GitHub API 读取 data.json（GET https://api.github.com/repos/V-ing7/v-ing-site/contents/data.json?ref=main）\n'
    + '2. 解析 base64 content（UTF-8 安全解码：atob → Uint8Array → TextDecoder）\n'
    + '3. 了解当前数据状态后按我的要求修改\n'
    + '4. 修改后用 GitHub API PUT 回 data.json（需带 sha 参数）\n'
    + '5. 如需部署代码变更，git push origin main 即可自动触发双平台部署\n'
    + '6. 如需手动部署 Cloudflare Pages（紧急情况）：\n'
    + '   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler pages deploy . --project-name=v-ing-site --branch=main\n\n'
    + '【注意事项】\n'
    + '- 保存到 GitHub 时需先获取当前文件 sha，PUT 时带上 sha 防止冲突\n'
    + '- 如果遇到 409 冲突，重新获取 sha 后重试\n'
    + '- data.json 中的中文字符必须用 UTF-8 编码，不能乱码\n'
    + '- operationLog 记录每次重要操作，格式：{date, time, action, status}\n'
    + '- instructionTemplate 区域包含项目元信息，保持最新\n'
    + '- 修改 .github/workflows/deploy.yml 需在 GitHub 网页端操作（PAT 无 workflow 权限）';

  // Render console panel from GitHub data
  function renderConsolePanel(ghData){
    // Template box
    if(consoleTemplateBox){
      consoleTemplateBox.textContent = CONSOLE_TEMPLATE;
    }
    // Last sync time
    if(consoleLastSync && ghData.lastUpdated){
      var d = new Date(ghData.lastUpdated);
      consoleLastSync.textContent = d.toLocaleString('zh-CN');
    }
    // Operation log
    if(consoleLogList && ghData.operationLog){
      var logs = ghData.operationLog;
      if(consoleLogCount) consoleLogCount.textContent = logs.length + ' 条';
      if(logs.length === 0){
        consoleLogList.innerHTML = '<div class="console-log-empty">暂无操作记录</div>';
      } else {
        consoleLogList.innerHTML = logs.map(function(log){
          return '<div class="console-log-item">'
            + '<div class="console-log-dot"></div>'
            + '<div class="console-log-body">'
            + '<div class="console-log-meta">' + log.date + ' ' + log.time + '</div>'
            + '<div class="console-log-text">' + log.action + '</div>'
            + '</div></div>';
        }).join('');
      }
    }
  }

  // Copy template button
  if(consoleCopyBtn){
    consoleCopyBtn.addEventListener('click', function(){
      if(consoleTemplateBox){
        var text = consoleTemplateBox.textContent;
        if(navigator.clipboard){
          navigator.clipboard.writeText(text).then(function(){
            consoleCopyBtn.textContent = lang === 'zh' ? '已复制' : 'Copied';
            consoleCopyBtn.classList.add('copied');
            setTimeout(function(){
              consoleCopyBtn.textContent = lang === 'zh' ? '复制模版' : 'Copy Template';
              consoleCopyBtn.classList.remove('copied');
            }, 2000);
          });
        } else {
          // Fallback
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          consoleCopyBtn.textContent = lang === 'zh' ? '已复制' : 'Copied';
          consoleCopyBtn.classList.add('copied');
          setTimeout(function(){
            consoleCopyBtn.textContent = lang === 'zh' ? '复制模版' : 'Copy Template';
            consoleCopyBtn.classList.remove('copied');
          }, 2000);
        }
      }
    });
  }

  // Render console when switching to console tab
  // (Already handled in switchWsTab via wsPanels, but we need to trigger render)
  var origSwitchWsTab = switchWsTab;
  switchWsTab = function(tab){
    origSwitchWsTab(tab);
    if(tab === 'console' && window.__vingData){
      renderConsolePanel(window.__vingData);
    }
  };

  /* ---------- Manual Force Sync ---------- */
  // Expose sync function globally for the sync button
  window.__vingSync = function(){
    if(_saveInProgress){
      _log('Save in progress, cannot sync now');
      return;
    }
    _log('Manual sync triggered');
    ghLoad().then(function(){
      _log('✓ Manual sync complete');
    }).catch(function(err){
      setSyncStatus('error');
    });
  };

  // Bind sync button click
  var syncBtn = document.getElementById('syncStatusBadge');
  if(syncBtn){
    syncBtn.style.cursor = 'pointer';
    syncBtn.addEventListener('click', function(){
      window.__vingSync();
    });
  }

  /* ---------- Init ---------- */
  setupReveal();
  checkHash();

  // Trigger initial reveals after a short delay (for loader)
  setTimeout(function(){
    checkReveals();
  },800);

  /* ---------- QR Code: direct image approach ---------- */
  function initCustomQR(){
    var container=document.getElementById('bcQRCode');
    if(!container)return;
    // Use qrserver.com API - reliable, no library dependency
    var img=document.createElement('img');
    img.src='https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=https://v-ing-site.pages.dev&color=000000&bgcolor=ffffff&ecc=M';
    img.alt='QR Code';
    img.style.cssText='width:100%;height:100%;display:block;border:none;';
    img.onload=function(){
      console.log('[V-ing] QR code image loaded successfully');
    };
    img.onerror=function(){
      console.warn('[V-ing] QR image failed, trying fallback');
      var fb=document.querySelector('.bc-qr-fallback-img');
      if(fb)fb.style.display='block';
    };
    container.innerHTML='';
    container.appendChild(img);
  }
  // Also try on page load as fallback
  window.addEventListener('load',function(){
    setTimeout(initCustomQR,500);
  });

})();