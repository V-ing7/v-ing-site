/* ================================================================
   微影 V-ing · Interactive System
   ================================================================ */
(function(){
  'use strict';
  // Show loader immediately (CSS defaults to hidden to prevent black screen on JS error)
  (function(){
    var ld=document.getElementById('loader');
    if(ld) ld.classList.add('loading');
  })();


  /* ================================================================
     GitHub Data Sync — v3.0 (Deep Stability Optimization)
     - Multi-source loading with priority, validation, and graceful fallback
     - Save queue with merge-on-conflict, exponential backoff, timeout guard
     - Adaptive auto-refresh with exponential backoff on failures
     - Online/offline detection with automatic reconnection
     ================================================================== */
  var GH_REPO = 'V-ing7/v-ing-site';
  var GH_FILE = 'data.json';
  var GH_BRANCH = 'main';
  var GH_RAW = 'https://raw.githubusercontent.com/' + GH_REPO + '/' + GH_BRANCH + '/' + GH_FILE;
  var WORKER_API = ''; // Same-origin: Pages Functions at /api/

  /* ---- Sync State ---- */
  var ghDataSHA = null;           // Current file SHA for GitHub API
  var ghSyncStatus = 'loading';   // loading | success | error | offline | saving | saved
  var ghLastLoadTime = 0;         // Timestamp of last load attempt
  var ghLastSuccessfulLoad = 0;   // Timestamp of last successful load
  var ghLastSaveTime = 0;         // Timestamp of last save start
  var ghLastSuccessfulSave = 0;   // Timestamp of last successful save
  var ghLastAppliedDataTime = ''; // lastUpdated of last applied data (prevents stale overwrites)

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
    // __ghSyncStatus is exposed via Object.defineProperty getter (line ~3386)
    var el = document.getElementById('syncStatusBadge');
    if(!el) return;
    var labels = {
      loading:   { text: '同步中...', cls: 'sync-loading' },
      success:   { text: '已同步',   cls: 'sync-success' },
      error:     { text: '同步失败', cls: 'sync-error' },
      offline:   { text: '离线模式', cls: 'sync-offline' },
      saving:    { text: '保存中...', cls: 'sync-loading' },
      saved:     { text: '已保存',   cls: 'sync-success' },
      syncing:   { text: '同步中...', cls: 'sync-loading' },
      pending:   { text: '有更新',   cls: 'sync-pending' }
    };
    var info = labels[status] || labels.loading;
    el.textContent = msg || info.text;
    el.className = 'sync-badge ' + info.cls;
    // Add title with last sync time for more context
    if(ghLastSuccessfulLoad){
      var d = new Date(ghLastSuccessfulLoad);
      var timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      el.title = '最后同步: ' + timeStr;
    }
  }

  /* ================================================================
     Cloudflare Deploy Trigger (non-blocking, best-effort)
     ================================================================ */
  function triggerCloudflareDeploy(){
    fetchWithTimeout(WORKER_API + '/api/v-ing-deploy', {
      method: 'POST',
      headers: { 'X-Password': _getWsPassword() }
    }, 4000)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(d.ok){ _log('Cloudflare deployment retried'); }
        else{ _log('CF retry: ' + (d.error || 'unknown'), 'warn'); }
      })
      .catch(function(err){ _log('CF deploy best-effort failed: ' + err.message, 'warn'); });
  }

  /* ================================================================
       Data Loading — D1 API single source
       - Reads directly from Cloudflare D1 database via Pages Functions
       - Timestamp-based freshness check
       - Edit-mode aware: notify of new data without overwriting edits
       ================================================================ */
  var _loadState = null;        // Current foreground load state
  var _bgLoadState = null;      // Current background load state
  var _hasNewDataPending = false; // New data available while in edit mode

  function ghLoad(options){
    var opts = options || {};
    var isBackground = opts.background || false;
    var force = opts.force || false;

    // Smart state management:
    // - Foreground load takes precedence (upgrades background to foreground)
    // - Background load reuses existing foreground or background load
    if(isBackground){
      if(_loadState && _loadState.pending){
        _log('Background refresh: foreground load in progress, reusing', 'debug');
        return _loadState.promise;
      }
      if(_bgLoadState && _bgLoadState.pending){
        _log('Background refresh already in progress, reusing', 'debug');
        return _bgLoadState.promise;
      }
    } else {
      // Foreground load: if background is running, upgrade it
      if(_bgLoadState && _bgLoadState.pending){
        _log('Foreground load: upgrading background refresh');
        setSyncStatus('loading');
        // We can't really "upgrade" the promise, but we can show loading
        // and return the same promise (it will still resolve correctly)
        return _bgLoadState.promise.then(function(data){
          setSyncStatus('success');
          return data;
        }).catch(function(err){
          setSyncStatus('error');
          throw err;
        });
      }
      if(_loadState && _loadState.pending){
        _log('Foreground load already in progress, reusing');
        return _loadState.promise;
      }
      setSyncStatus('loading');
    }

    ghLastLoadTime = Date.now();
    _hasNewDataPending = false;

    var cacheBust = Date.now();
    var bestData = null;
    var bestTime = null;
    var bestSource = null;
    var bestSHA = null;
    var sourcesCompleted = 0;
    var totalSources = 1;
    var resolvedFirst = false;
    var firstResolveData = null;
    var baselineTime = ghLastAppliedDataTime || '';

    // Single source: D1 API (same-origin Pages Functions)
    var sources = [
      {
        name: 'D1 API',
        priority: 0,
        timeout: 6000,
        fetch: function(){
          return fetchWithTimeout(WORKER_API + '/api/v-ing-data?t=' + cacheBust, {}, 6000).then(function(res){
            if(!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          }).then(function(json){
            return { data: json.data, fromAPI: true };
          });
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

      // FRESHNESS CHECK v2: compare against global baseline, not local bestData
      // This prevents re-applying identical data on every refresh cycle
      var isStale = baselineTime && dataTime && dataTime <= baselineTime;
      if(isStale){
        _log(sourceName + ': same or older data (ts: ' + dataTime + '), skipped', 'debug');
        // Data is valid but not newer — still resolve the promise as "up to date"
        if(!resolvedFirst){
          resolvedFirst = true;
          firstResolveData = result.data;
          if(!bestData){
            bestData = result.data;
            bestTime = dataTime;
            bestSource = sourceName;
          }
          ghLastSuccessfulLoad = Date.now();
          _refreshConsecutiveFailures = 0;
          _refreshCurrentInterval = _refreshBaseInterval;
          if(!isBackground){
            setSyncStatus('success');
          }
        }
        return;
      }

      var isNewer = !bestData || (dataTime && dataTime > bestTime);

      if(isNewer){
        bestData = result.data;
        bestTime = dataTime;
        bestSource = sourceName;
        if(result.fromAPI && result.sha){
          bestSHA = result.sha;
        }

        // Only apply to UI if data is actually newer than what we have
        var isActuallyNew = !baselineTime || (dataTime && dataTime > baselineTime);

        if(isActuallyNew){
          ghLastAppliedDataTime = dataTime;
          if(result.fromAPI && result.sha){
            ghDataSHA = result.sha;
          }

          // Edit-mode awareness: if in edit mode, don't overwrite, just notify
          var inEditMode = editModeActive || subpageEditMode;
          if(isBackground && inEditMode){
            _hasNewDataPending = true;
            _log('↻ New data from ' + sourceName + ' available (edit mode - pending)');
            setSyncStatus('pending');
          } else {
            _log('✓ ' + sourceName + (dataTime ? ' (ts: ' + dataTime + ')' : ''));
            applyRemoteData(result.data);
          }
        } else {
          _log(sourceName + ': same timestamp as current, no update needed', 'debug');
        }

        if(!resolvedFirst){
          resolvedFirst = true;
          firstResolveData = result.data;
          if(!isBackground){
            setSyncStatus('success');
          }
          ghLastSuccessfulLoad = Date.now();
          _refreshConsecutiveFailures = 0;
          _refreshCurrentInterval = _refreshBaseInterval;
        } else if(isActuallyNew && !(_hasNewDataPending && (editModeActive || subpageEditMode))){
          _log('↻ Newer data from ' + sourceName + ', UI updated');
        }
      }
    }

    // Launch single source
    sources[0].fetch().then(function(result){
      considerResult(sources[0].name, result, 0);
    }).catch(function(err){
      sourcesCompleted++;
      _log(sources[0].name + ' failed: ' + err.message, 'warn');
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

    // Track state separately for foreground vs background
    if(isBackground){
      _bgLoadState = { pending: true, promise: promise };
      promise.finally(function(){
        _bgLoadState = null;
      });
    } else {
      _loadState = { pending: true, promise: promise };
      promise.finally(function(){
        _loadState = null;
      });
    }

    return promise;
  }

  /* ================================================================
     Apply Remote Data to UI
     v4.0 Smart Update: only re-render changed sections
     ================================================================ */
  var _lastAppliedSignatures = {}; // Track data signatures for change detection

  function _getDataSignature(data){
    // Fast signature for change detection (not cryptographic, just for comparison)
    try{
      return JSON.stringify(data);
    }catch(e){
      return String(Math.random());
    }
  }

  function _hasChanged(key, data){
    var sig = _getDataSignature(data);
    var changed = _lastAppliedSignatures[key] !== sig;
    if(changed){
      _lastAppliedSignatures[key] = sig;
    }
    return changed;
  }

  function applyRemoteData(data){
    window.__vingData = data;

    // Theme
    if(data.theme && _hasChanged('theme', data.theme)){
      html.setAttribute('data-theme', data.theme);
      localStorage.setItem('v-ing-theme', data.theme);
    }

    // Language
    if(data.lang && data.lang !== lang){
      lang = data.lang;
      localStorage.setItem('v-ing-lang', lang);
      applyLang();
    }

    // Streamers - only re-render if changed
    if(data.streamers && unifiedPanel){
      if(_hasChanged('streamers', data.streamers)){
        streamerData = data.streamers;
        initStreamerData();
        Object.keys(data.streamers).forEach(function(key){
          streamerData[key] = data.streamers[key];
        });
        initSubpageStreamers();
        refreshAllVisuals(streamerData);
        try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(streamerData)); }catch(e){}
      }
    }

    // Operation log
    if(data.operationLog && _hasChanged('operationLog', data.operationLog)){
      renderConsolePanel(data);
    }

    // Kanban tasks - only re-render if changed
    if(data.kanbanTasks && window.__renderKanbanFromData){
      if(_hasChanged('kanbanTasks', data.kanbanTasks)){
        window.__renderKanbanFromData(data.kanbanTasks);
      }
    }

    // Storyboard projects - only re-render if changed
    if(data.storyboardProjects && Array.isArray(data.storyboardProjects) && window.__renderStoryboard){
      if(_hasChanged('storyboardProjects', data.storyboardProjects)){
        window.__renderStoryboard(data.storyboardProjects);
      }
    } else if(data.storyboard && window.__renderStoryboard){
      if(_hasChanged('storyboard', data.storyboard)){
        window.__renderStoryboard(data.storyboard);
      }
    }
  }

  /* ================================================================
     Save System — Queue-based with merge-on-conflict + backoff
     ================================================================ */

  // Password prompt modal — shown when save needs a password
  function _promptForPassword(){
    return new Promise(function(resolve, reject){
      var existing = document.getElementById('pwdPromptOverlay');
      if(existing) existing.remove();

      var overlay = document.createElement('div');
      overlay.id = 'pwdPromptOverlay';
      var isLight = html.getAttribute('data-theme') === 'light';
      var bg = isLight ? '#ffffff' : '#1c1c1e';
      var fg = isLight ? '#1c1c1e' : '#ffffff';
      var sub = isLight ? '#8e8e93' : '#8e8e93';
      var border = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)';
      var inputBg = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)';

      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s ease;';
      overlay.innerHTML =
        '<div id="pwdPromptCard" style="background:' + bg + ';border-radius:16px;padding:28px 24px;max-width:340px;width:90%;box-shadow:0 12px 40px rgba(0,0,0,0.3);transform:scale(0.9);transition:transform .2s ease;">' +
          '<h3 style="margin:0 0 6px;color:' + fg + ';font-size:1.15rem;font-weight:700;">' + (lang==='zh'?'需要密码':'Password Required') + '</h3>' +
          '<p style="margin:0 0 18px;color:' + sub + ';font-size:0.85rem;">' + (lang==='zh'?'保存数据需要工作台密码<br>提示：个人英文名':'Enter workspace password to save<br>Hint: personal English name') + '</p>' +
          '<input type="text" id="pwdPromptInput" placeholder="' + (lang==='zh'?'输入密码':'Enter password') + '" style="width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid ' + border + ';background:' + inputBg + ';color:' + fg + ';font-size:1rem;margin-bottom:14px;outline:none;" />' +
          '<div style="display:flex;gap:10px;">' +
            '<button id="pwdPromptCancel" style="flex:1;padding:11px;border-radius:10px;border:none;background:' + inputBg + ';color:' + fg + ';cursor:pointer;font-size:0.9rem;">' + (lang==='zh'?'取消':'Cancel') + '</button>' +
            '<button id="pwdPromptOK" style="flex:1;padding:11px;border-radius:10px;border:none;background:#ffdcb4;color:#1c1c1e;cursor:pointer;font-size:0.9rem;font-weight:600;">' + (lang==='zh'?'确认':'OK') + '</button>' +
          '</div>' +
          '<p id="pwdPromptError" style="margin:10px 0 0;color:#ff453a;font-size:0.8rem;display:none;">' + (lang==='zh'?'密码错误，请重试':'Wrong password, try again') + '</p>' +
        '</div>';

      document.body.appendChild(overlay);
      requestAnimationFrame(function(){
        overlay.style.opacity = '1';
        var card = document.getElementById('pwdPromptCard');
        if(card) card.style.transform = 'scale(1)';
      });

      var input = document.getElementById('pwdPromptInput');
      var error = document.getElementById('pwdPromptError');
      var card = document.getElementById('pwdPromptCard');

      setTimeout(function(){ if(input) input.focus(); }, 200);

      function cleanup(){
        overlay.style.opacity = '0';
        if(card) card.style.transform = 'scale(0.9)';
        setTimeout(function(){ overlay.remove(); }, 200);
      }

      function submit(){
        var pwd = input.value.trim();
        if(pwd === WS_PASSWORD){
          sessionStorage.setItem(WS_PWD_KEY, pwd);
          sessionStorage.setItem(WS_LOCK_KEY, '1');
          cleanup();
          resolve(pwd);
        } else {
          error.style.display = 'block';
          input.value = '';
          input.focus();
          if(card){
            card.style.animation = 'none';
            void card.offsetWidth;
            card.style.animation = 'shake 0.4s';
          }
        }
      }

      function cancel(){
        cleanup();
        reject(new Error('Password input cancelled'));
      }

      document.getElementById('pwdPromptOK').addEventListener('click', submit);
      document.getElementById('pwdPromptCancel').addEventListener('click', cancel);
      input.addEventListener('keydown', function(e){
        if(e.key === 'Enter'){ e.preventDefault(); submit(); }
        if(e.key === 'Escape'){ e.preventDefault(); cancel(); }
      });
    });
  }

  // Public: queue a save with debounce
  function ghSave(data){
    // Update local timestamp immediately to prevent auto-refresh overwrite
    data.lastUpdated = _nowISO();
    ghLastSaveTime = Date.now();
    _postSaveVerifyCount = 0; // Reset post-save verification counter

    // Add to queue (merge with existing pending saves)
    _saveQueue.push({
      data: JSON.parse(JSON.stringify(data)), // deep copy snapshot
      timestamp: Date.now()
    });

    // Clear existing debounce timer
    if(_saveDebounceTimer){
      clearTimeout(_saveDebounceTimer);
    }

    // Debounce: 200ms — below human perception threshold, avoids API spam
    _saveDebounceTimer = setTimeout(function(){
      _processSaveQueue();
    }, 200);
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
    // Check if password is available before attempting save
    if(!_getWsPassword()){
      _log('No password set, prompting for password before save');
      _promptForPassword().then(function(){
        _executeSave(data);
      }).catch(function(){
        _log('Password input cancelled, save aborted', 'warn');
        setSyncStatus('error');
      });
      return;
    }

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

    var payload = {
      message: 'Update data via web editor - ' + new Date().toLocaleString('zh-CN'),
      branch: GH_BRANCH
    };

    function doPut(sha){
      if(sha) payload.sha = sha;
      var putBody = { data: data, sha: sha, message: payload.message };
      return fetchWithTimeout(WORKER_API + '/api/v-ing-data', {
        method: 'PUT',
        headers: {
          'X-Password': _getWsPassword(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(putBody)
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
      ghLastAppliedDataTime = data.lastUpdated || _nowISO();
      ghLastSuccessfulSave = Date.now();
      _log('✓ Saved to D1 database');
      setSyncStatus('saved');

      // Update signatures to match saved data (prevents immediate re-render on verify)
      if(data.theme) _lastAppliedSignatures.theme = _getDataSignature(data.theme);
      if(data.streamers) _lastAppliedSignatures.streamers = _getDataSignature(data.streamers);
      if(data.operationLog) _lastAppliedSignatures.operationLog = _getDataSignature(data.operationLog);
      if(data.kanbanTasks) _lastAppliedSignatures.kanbanTasks = _getDataSignature(data.kanbanTasks);
      if(data.storyboardProjects) _lastAppliedSignatures.storyboardProjects = _getDataSignature(data.storyboardProjects);

      // Post-save verification: confirm data was saved correctly
      setTimeout(function(){
        _verifySave(data.lastUpdated);
      }, 500);

      setTimeout(function(){
        if(ghSyncStatus === 'saved') setSyncStatus('success');
      }, 500);
      _finishSave(true);
    }

    // Verify save by fetching from Worker API and comparing timestamps
    function _verifySave(expectedTimestamp){
      if(!expectedTimestamp) return;
      fetchWithTimeout(WORKER_API + '/api/v-ing-data?verify=' + Date.now(), {}, 5000)
        .then(function(res){
          if(!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(json){
          if(json.data && json.data.lastUpdated){
            if(json.data.lastUpdated >= expectedTimestamp){
              _log('✓ Save verified: remote data matches');
              // Update SHA from verified response
              if(json.sha) ghDataSHA = json.sha;
              // Reset backoff since we confirmed the connection works
              _refreshConsecutiveFailures = 0;
              _refreshCurrentInterval = _refreshBaseInterval;
            } else {
              _log('⚠ Save verification: remote data is older than expected', 'warn');
              // Try again after a short delay
              setTimeout(function(){
                _verifySave(expectedTimestamp);
              }, 3000);
            }
          }
        })
        .catch(function(err){
          _log('Save verification failed: ' + err.message, 'warn');
        });
    }

    function handleFailure(err){
      _log('Save failed: ' + (err.message || err), 'warn');

      // Handle 403 Forbidden: password missing or incorrect
      if(err.status === 403){
        _log('403 Forbidden — password missing or incorrect, prompting for password');
        sessionStorage.removeItem(WS_PWD_KEY);
        sessionStorage.removeItem(WS_LOCK_KEY);
        _saveInProgress = false;
        if(_saveStuckGuard) clearTimeout(_saveStuckGuard);
        _promptForPassword().then(function(){
          _executeSave(data);
        }).catch(function(){
          _log('Password input cancelled after 403, save failed', 'warn');
          setSyncStatus('error');
          _finishSave(false);
        });
        return;
      }

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

    // Execute PUT — D1 doesn't use SHA
    doPut(null).then(handleSuccess).catch(handleFailure);
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

  // Fetch current SHA from Worker API
  function _fetchSHA(){
    return fetchWithTimeout(WORKER_API + '/api/v-ing-data', {}, 5000).then(function(res){
      if(!res.ok) throw new Error('SHA fetch HTTP ' + res.status);
      return res.json();
    }).then(function(json){ return json.sha; });
  }

  // Fetch latest data and merge with local changes
  function _fetchLatestAndMerge(localData){
    return fetchWithTimeout(WORKER_API + '/api/v-ing-data', {}, 5000).then(function(res){
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function(json){
      ghDataSHA = json.sha;
      var remoteData = json.data;

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
     v4.0 Deep Optimization:
     - Smart post-save fast verification (not just blind 90s wait)
     - Edit-mode: still checks for new data, just notifies
     - Page visibility: immediate refresh when tab becomes visible
     - Faster recovery from backoff
     ================================================================ */
  var _postSaveVerifyCount = 0;
  var _postSaveVerifyTimer = null;

  function startAutoRefresh(){
    if(_refreshTimer) clearInterval(_refreshTimer);
    _refreshCurrentInterval = _refreshBaseInterval;
    _refreshConsecutiveFailures = 0;

    // Refresh when page becomes visible again (user switched back to tab)
    document.addEventListener('visibilitychange', function(){
      if(!document.hidden && _isOnline){
        _log('Page visible — checking for updates');
        // Small delay to let browser settle
        setTimeout(function(){
          ghLoad({ background: true }).catch(function(){});
        }, 500);
      }
    });

    function tick(){
      var timeSinceSave = Date.now() - ghLastSaveTime;
      var timeSinceSuccessfulSave = Date.now() - ghLastSuccessfulSave;

      // Determine if we should refresh:
      // - Always allow if it's been > 30s since save (normal operation)
      // - During edit mode: still refresh, but ghLoad will handle it (notify only)
      // - Skip if save in progress
      // - Skip if page is hidden
      // - Skip if offline
      // - Skip during storyboard long-press
      var canRefresh = !_saveInProgress
        && !document.hidden
        && _isOnline
        && !window.__sbLongPressActive
        && timeSinceSave > 30000; // Shortened from 90s to 30s since we now have smart stale detection

      // Post-save fast verification: if save was in the last 30s, do quick checks
      if(!canRefresh && timeSinceSave <= 30000 && timeSinceSuccessfulSave > 2000 && !_saveInProgress){
        // In the post-save window, do a quick verification every 10s
        if(_postSaveVerifyCount < 3){
          _postSaveVerifyCount++;
          _log('Post-save verification check #' + _postSaveVerifyCount);
          ghLoad({ background: true }).catch(function(){});
        }
      }

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
            _refreshBaseInterval * Math.pow(1.4, _refreshConsecutiveFailures),
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
    if(window.__vingData){
      window.__vingData.theme = next;
      ghSave(window.__vingData);
    }
    requestAnimationFrame(function(){ checkReveals(); });
    // Re-render QR code with theme-appropriate color
    setTimeout(updateQRTheme,50);
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
    var cinemaHero=document.querySelector('.cinema-hero');
    var cinemaLetterboxes=document.querySelectorAll('.cinema-letterbox');
    var cinemaCams=document.querySelectorAll('.cinema-cam');
    var cinemaScrollHint=document.querySelector('.cinema-scroll-hint');

    if(!newView)return;

    // Hide cinema hero when leaving home
    if(currentView==='home'&&target!=='home'&&cinemaHero){
      cinemaHero.style.transition='opacity .3s ease';
      cinemaHero.style.opacity='0';
      cinemaLetterboxes.forEach(function(el){
        el.style.transition='opacity .3s ease';
        el.style.opacity='0';
      });
      cinemaCams.forEach(function(el){
        el.style.transition='opacity .3s ease';
        el.style.opacity='0';
      });
      if(cinemaScrollHint){
        cinemaScrollHint.style.transition='opacity .3s ease';
        cinemaScrollHint.style.opacity='0';
      }
    }

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

      // Show cinema hero when entering home
      if(target==='home'&&cinemaHero){
        cinemaHero.style.opacity='1';
        cinemaLetterboxes.forEach(function(el){
          el.style.opacity='';
        });
        cinemaCams.forEach(function(el){
          el.style.opacity='';
        });
        if(cinemaScrollHint){
          cinemaScrollHint.style.opacity='';
        }
      }

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
        // Clear cinema hero inline styles after transition
        if(target==='home'&&cinemaHero){
          cinemaHero.style.transition='';
          cinemaHero.style.opacity='';
          cinemaLetterboxes.forEach(function(el){
            el.style.transition='';
            el.style.opacity='';
          });
          cinemaCams.forEach(function(el){
            el.style.transition='';
            el.style.opacity='';
          });
          if(cinemaScrollHint){
            cinemaScrollHint.style.transition='';
            cinemaScrollHint.style.opacity='';
          }
        }
        checkReveals();
        // Show workspace password lock if needed
        if(target==='workspace'&&!isWsUnlocked()){
          showWsLock();
        }
        // Reset collab sub-page state when entering collab view
        if(target==='collab'){
          showCollabHub();
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
  var WS_PASSWORD='Vikyi';
  var WS_LOCK_KEY='v_ing_ws_unlocked';
  var WS_PWD_KEY='v_ing_ws_pwd';
  var wsLockOverlay=document.getElementById('wsLockOverlay');
  var wsLockDots=document.getElementById('wsLockDots');
  var wsLockError=document.getElementById('wsLockError');
  var wsLockInput='';

  function _getWsPassword(){
    return sessionStorage.getItem(WS_PWD_KEY)||'';
  }

  function isWsUnlocked(){
    return sessionStorage.getItem(WS_LOCK_KEY)==='1';
  }
  function showWsLock(){
    if(wsLockOverlay)wsLockOverlay.classList.add('ws-lock-active');
    wsLockInput='';
    hideWsLockError();
    setTimeout(function(){
      var inp=document.getElementById('wsLockTextInput');
      if(inp){ inp.value=''; inp.focus(); }
    },100);
  }
  function hideWsLock(){
    if(wsLockOverlay)wsLockOverlay.classList.remove('ws-lock-active');
    sessionStorage.setItem(WS_LOCK_KEY,'1');
    sessionStorage.setItem(WS_PWD_KEY,wsLockInput);
    setTimeout(function(){checkReveals()},100);
  }
  function showWsLockError(msg){
    if(!wsLockError)return;
    wsLockError.textContent=msg;
    wsLockError.classList.add('show');
    var card=wsLockOverlay.querySelector('.ws-lock-card');
    if(card){
      card.classList.add('shake');
      setTimeout(function(){ card.classList.remove('shake'); },500);
    }
    setTimeout(function(){
      hideWsLockError();
      wsLockInput='';
      var inp=document.getElementById('wsLockTextInput');
      if(inp){ inp.value=''; inp.focus(); }
    },800);
  }
  function hideWsLockError(){
    if(wsLockError){
      wsLockError.classList.remove('show');
    }
  }
  function handleWsLockSubmit(){
    var inp=document.getElementById('wsLockTextInput');
    if(!inp)return;
    wsLockInput=inp.value;
    if(wsLockInput===WS_PASSWORD){
      hideWsLock();
    }else{
      showWsLockError(lang==='zh'?'密码错误，请重试':'Wrong password, try again');
    }
  }
  // Submit on Enter or button click
  document.addEventListener('keydown',function(e){
    if(!wsLockOverlay||!wsLockOverlay.classList.contains('ws-lock-active'))return;
    if(e.key==='Enter'){
      e.preventDefault();
      handleWsLockSubmit();
    }
  });
  if(wsLockOverlay){
    wsLockOverlay.addEventListener('click',function(e){
      var btn=e.target.closest('.ws-lock-submit');
      if(btn){
        handleWsLockSubmit();
      }
    });
  }

  /* ---------- Workspace: Segmented Control & Sub-pages ---------- */
  var wsTabs=document.getElementById('wsTabs');
  var segIndicator=document.getElementById('segIndicator');
  var wsPanels={
    plan:document.getElementById('ws-panel-plan'),
    unified:document.getElementById('ws-panel-unified'),
    storyboard:document.getElementById('ws-panel-storyboard'),
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
      var pos = {'plan':1,'unified':2,'storyboard':3,'console':4}[tab] || 1;
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
      // Smooth scroll: prefer workspace tabs, fallback to collab view head
      var scrollTarget=document.getElementById('wsTabs');
      if(!scrollTarget){
        scrollTarget=document.querySelector('#view-collab .section-head');
      }
      if(scrollTarget){
        var rect=scrollTarget.getBoundingClientRect();
        var targetY=window.scrollY+rect.top-80;
        if(Math.abs(window.scrollY-targetY)>20){
          window.scrollTo({top:targetY,behavior:'smooth'});
        }
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

  /* ---- Streamer Real-time Sync to GitHub ---- */
  // Debounced save: wait 800ms after last edit to avoid spamming the API
  var _streamerSaveTimer = null;
  function saveStreamersToGitHub(){
    if(_streamerSaveTimer) clearTimeout(_streamerSaveTimer);
    // 150ms — fast enough to feel instant, avoids API spam on rapid clicks
    _streamerSaveTimer = setTimeout(function(){
      if(window.__vingData){
        window.__vingData.streamers = {};
        Object.keys(streamerData).forEach(function(key){
          if(streamerData[key] && typeof streamerData[key].shoot === 'number'){
            window.__vingData.streamers[key] = streamerData[key];
          }
        });
        window.__vingData.lastUpdated = new Date().toISOString();
        if(typeof ghSave === 'function'){
          ghSave(window.__vingData);
        }
      }
      // Also save to localStorage
      try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(streamerData)); }catch(e){}
    }, 800);
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

  /* ---- Sub-page (联动) Streamer Sync ---- */
  // Initialize sub-page streamer cards: match by name and add data attributes
  function initSubpageStreamers(){
    var leapSection = document.getElementById('report-leap');
    if(!leapSection) return;
    var leapCards = leapSection.querySelectorAll('.streamer-card');
    // Build name→key map from streamerData
    var nameToKey = {};
    Object.keys(streamerData).forEach(function(key){
      if(streamerData[key] && streamerData[key].name){
        nameToKey[streamerData[key].name] = key;
      }
    });
    leapCards.forEach(function(card){
      var nameEl = card.querySelector('h4');
      if(!nameEl) return;
      var name = nameEl.textContent.trim();
      var key = nameToKey[name];
      if(!key){
        // Fallback: try to find by index (first 4 streamers are 零跑)
        var idx = Array.prototype.indexOf.call(leapCards, card);
        key = 'streamer_' + idx;
      }
      var pcts = card.querySelectorAll('.sr-pct');
      if(pcts[0]){
        pcts[0].setAttribute('data-streamer', key);
        pcts[0].setAttribute('data-field', 'shoot');
      }
      if(pcts[1]){
        pcts[1].setAttribute('data-streamer', key);
        pcts[1].setAttribute('data-field', 'edit');
      }
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
  }

  // Refresh sub-page streamer cards from data
  function refreshSubpageStreamers(data){
    var leapSection = document.getElementById('report-leap');
    if(!leapSection) return;
    var leapCards = leapSection.querySelectorAll('.streamer-card');
    var totalShoot = 0, totalEdit = 0;
    var cardCount = leapCards.length;
    var TARGET = 40; // 零跑 target per streamer

    leapCards.forEach(function(card){
      var pcts = card.querySelectorAll('.sr-pct');
      var key = pcts[0] ? pcts[0].getAttribute('data-streamer') : null;
      if(!key || !data[key]) return;
      var d = data[key];
      // Update numbers
      if(pcts[0]) pcts[0].textContent = d.shoot;
      if(pcts[1]) pcts[1].textContent = d.edit;
      // Update progress bars
      var bars = card.querySelectorAll('.sr-bar span');
      if(bars[0]) bars[0].style.width = Math.round(d.shoot / TARGET * 100) + '%';
      if(bars[1]) bars[1].style.width = Math.round(d.edit / TARGET * 100) + '%';
      totalShoot += d.shoot;
      totalEdit += d.edit;
    });

    // Update brand progress summary
    var summary = leapSection.querySelector('.brand-progress-summary');
    if(summary){
      var bpsNums = summary.querySelectorAll('.bps-num');
      var bpsBars = summary.querySelectorAll('.bps-bar span');
      var totalTarget = TARGET * cardCount;
      if(bpsNums[0]) bpsNums[0].textContent = totalShoot;
      if(bpsNums[1]) bpsNums[1].textContent = totalEdit;
      if(bpsBars[0]) bpsBars[0].style.width = Math.round(totalShoot / totalTarget * 100) + '%';
      if(bpsBars[1]) bpsBars[1].style.width = Math.round(totalEdit / totalTarget * 100) + '%';
    }
  }

  // Expose globally for sync system
  window.__refreshSubpageStreamers = refreshSubpageStreamers;

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
    // Sync sub-page (联动) streamer cards
    refreshSubpageStreamers(data);
  }

  // Initialize data and apply saved values
  var streamerData = {};
  if(unifiedPanel){
    try{
      // First load from localStorage for instant display
      streamerData = initStreamerData();
      // Initialize sub-page streamer cards with data attributes
      initSubpageStreamers();
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
      kanbanTasks: { todo: [], wip: [], done: [] },
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

      // If there's pending new data from background refresh, apply it now
      if(_hasNewDataPending){
        _log('Edit mode exited — applying pending new data');
        _hasNewDataPending = false;
        // Do a fresh load to get latest data and apply it
        ghLoad({ background: true }).catch(function(){});
      }
    }
  }

  if(editToggleBtn){
    editToggleBtn.addEventListener('click', toggleEditMode);
  }

  /* ---------- Sub-page (联动) Edit Mode ---------- */
  var subpageEditBtn = document.getElementById('subpageEditBtn');
  var subpageEditMode = false;

  function toggleSubpageEditMode(){
    subpageEditMode = !subpageEditMode;
    var leapSection = document.getElementById('report-leap');
    if(!leapSection) return;
    if(subpageEditMode){
      leapSection.classList.add('edit-mode');
      if(subpageEditBtn){
        subpageEditBtn.textContent = (document.documentElement.getAttribute('data-lang') === 'en') ? 'Done' : '完成';
        subpageEditBtn.classList.add('edit-active');
      }
    } else {
      leapSection.classList.remove('edit-mode');
      if(subpageEditBtn){
        subpageEditBtn.textContent = (document.documentElement.getAttribute('data-lang') === 'en') ? 'Edit' : '编辑';
        subpageEditBtn.classList.remove('edit-active');
      }
      // Save data on exit
      saveStreamersToGitHub();

      // Apply pending new data if any
      if(_hasNewDataPending){
        _log('Subpage edit mode exited — applying pending new data');
        _hasNewDataPending = false;
        ghLoad({ background: true }).catch(function(){});
      }
    }
  }

  if(subpageEditBtn){
    subpageEditBtn.addEventListener('click', toggleSubpageEditMode);
  }

  // Click on sr-pct in sub-page to edit
  var leapSection = document.getElementById('report-leap');
  if(leapSection){
    leapSection.addEventListener('click', function(e){
      if(!subpageEditMode) return;
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
      function handleSubpageBlur(){
        var newVal = parseInt(input.value, 10);
        if(isNaN(newVal) || newVal < 0) newVal = 0;
        // Update data
        if(streamerData[key]){
          streamerData[key][field] = newVal;
        }
        // Restore span
        input.remove();
        numEl.style.display = '';
        // Refresh all visuals (unified panel + sub-page)
        refreshAllVisuals(streamerData);
        // Real-time save to GitHub (debounced)
        saveStreamersToGitHub();
      }

      input.addEventListener('blur', handleSubpageBlur);
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

  /* ---------- Kanban Board: Add / Edit / Delete Cards ---------- */
  (function(){
    var planPanel = document.getElementById('ws-panel-plan');
    if(!planPanel) return;

    // Add card: click + button shows inline form
    planPanel.querySelectorAll('.kanban-add-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var colType = btn.getAttribute('data-col-target');
        var cardsContainer = planPanel.querySelector('[data-col-cards="'+colType+'"]');
        if(!cardsContainer) return;
        // Prevent duplicate forms
        if(cardsContainer.querySelector('.kanban-card-new')) return;

        // Hide empty placeholder
        var empty = cardsContainer.querySelector('.kanban-empty');
        if(empty) empty.style.display = 'none';

        var form = document.createElement('div');
        form.className = 'kanban-card-new';
        var lang = document.documentElement.getAttribute('data-lang') || 'zh';
        var titlePh = lang === 'zh' ? '任务标题' : 'Task title';
        var descPh = lang === 'zh' ? '任务描述（可选）' : 'Description (optional)';
        var deadPh = lang === 'zh' ? '截止日期 如9/20' : 'Due date e.g. 9/20';
        var confirmText = lang === 'zh' ? '确认' : 'Confirm';
        var cancelText = lang === 'zh' ? '取消' : 'Cancel';

        form.innerHTML =
          '<input type="text" class="kcn-title" placeholder="'+titlePh+'" maxlength="50">' +
          '<textarea class="kcn-desc" placeholder="'+descPh+'" rows="2" maxlength="100"></textarea>' +
          '<input type="text" class="kcn-deadline" placeholder="'+deadPh+'" maxlength="20">' +
          '<div class="kanban-card-new-actions">' +
            '<button class="kcn-cancel">'+cancelText+'</button>' +
            '<button class="kcn-confirm">'+confirmText+'</button>' +
          '</div>';
        cardsContainer.insertBefore(form, cardsContainer.firstChild);

        form.querySelector('.kcn-title').focus();

        // Confirm
        form.querySelector('.kcn-confirm').addEventListener('click', function(){
          var title = form.querySelector('.kcn-title').value.trim();
          var desc = form.querySelector('.kcn-desc').value.trim();
          var deadline = form.querySelector('.kcn-deadline').value.trim();
          if(!title){
            form.querySelector('.kcn-title').style.borderColor = '#FF3B30';
            return;
          }
          // Create card
          var card = createKanbanCard(colType, title, desc, deadline);
          cardsContainer.insertBefore(card, form.nextSibling);
          form.remove();
          updateColCount(colType);
          // Show empty if no cards
          checkEmpty(cardsContainer, colType);
          // Sync to GitHub
          saveKanbanToGitHub();
        });

        // Cancel
        form.querySelector('.kcn-cancel').addEventListener('click', function(){
          form.remove();
          checkEmpty(cardsContainer, colType);
        });

        // Enter to confirm on title
        form.querySelector('.kcn-title').addEventListener('keydown', function(e){
          if(e.key === 'Enter'){ e.preventDefault(); form.querySelector('.kcn-confirm').click(); }
        });
      });
    });

    // Column order for move buttons
    var colOrder = ['todo', 'wip', 'done'];

    // Create a kanban card element
    function createKanbanCard(colType, title, desc, deadline){
      var card = document.createElement('div');
      card.className = 'kanban-card';
      if(colType === 'done') card.className += ' kanban-card-done';
      card.setAttribute('data-priority','normal');
      card.setAttribute('data-col-type', colType);
      card.setAttribute('draggable', 'true');

      buildCardContent(card, colType, title, desc, deadline);
      attachCardEvents(card);
      return card;
    }

    // Build the inner HTML of a card based on column type
    function buildCardContent(card, colType, title, desc, deadline){
      var lang = document.documentElement.getAttribute('data-lang') || 'zh';
      var tagClass = colType === 'todo' ? 'kc-tag-bili' : (colType === 'wip' ? 'kc-tag-dy' : 'kc-tag-collab');
      var tagText;
      if(lang === 'en'){
        tagText = colType === 'todo' ? 'To Do' : (colType === 'wip' ? 'WIP' : 'Done');
      } else {
        tagText = colType === 'todo' ? '待办' : (colType === 'wip' ? '进行中' : '已完成');
      }

      // Unified action toolbar: move left, move right, delete
      var colIdx = colOrder.indexOf(colType);
      var leftDisabled = colIdx === 0 ? 'disabled' : '';
      var rightDisabled = colIdx === colOrder.length - 1 ? 'disabled' : '';
      var actionsBar = '<div class="kc-actions">' +
        '<button class="kc-action-btn kc-move-left" '+leftDisabled+' title="左移">◀</button>' +
        '<button class="kc-action-btn kc-move-right" '+rightDisabled+' title="右移">▶</button>' +
        '<button class="kc-action-btn kc-action-del kc-del-btn" title="删除">✕</button>' +
      '</div>';

      var tags = '<div class="kc-tags"><span class="kc-tag '+tagClass+'">'+tagText+'</span></div>';
      var titleHtml = '<h4 contenteditable="true">'+escapeHtml(title)+'</h4>';
      var descHtml = desc ? '<p contenteditable="true">'+escapeHtml(desc)+'</p>' :
        '<p contenteditable="true" data-placeholder="..." style="color:var(--text-tertiary);">...</p>';

      var footHtml = '<div class="kc-foot">';
      if(colType === 'done'){
        footHtml += '<span class="kc-check">✓</span><span class="kc-date" contenteditable="true">'+escapeHtml(deadline||'')+'</span>';
      } else {
        var dlDefault = (lang === 'en') ? 'Due' : '截止';
        footHtml += '<span class="kc-deadline" contenteditable="true">'+escapeHtml(deadline||dlDefault)+'</span>';
        if(colType === 'wip') footHtml += '<span class="kc-progress-bar"><span style="width:0%"></span></span>';
      }
      footHtml += '</div>';

      card.innerHTML = actionsBar + tags + titleHtml + descHtml + footHtml;
      card.setAttribute('data-col-type', colType);
      // Toggle done style
      if(colType === 'done') card.classList.add('kanban-card-done');
      else card.classList.remove('kanban-card-done');
    }

    // Attach event listeners to a card (move, delete, drag)
    // Reads column type from data-col-type attribute so it's always current
    function attachCardEvents(card){
      // Move left
      var leftBtn = card.querySelector('.kc-move-left');
      if(leftBtn){
        leftBtn.addEventListener('click', function(e){
          e.stopPropagation();
          var ct = card.getAttribute('data-col-type');
          var idx = colOrder.indexOf(ct);
          if(idx > 0) moveCardToCol(card, ct, colOrder[idx - 1]);
        });
      }
      // Move right
      var rightBtn = card.querySelector('.kc-move-right');
      if(rightBtn){
        rightBtn.addEventListener('click', function(e){
          e.stopPropagation();
          var ct = card.getAttribute('data-col-type');
          var idx = colOrder.indexOf(ct);
          if(idx < colOrder.length - 1) moveCardToCol(card, ct, colOrder[idx + 1]);
        });
      }
      // Delete
      card.querySelector('.kc-del-btn').addEventListener('click', function(e){
        e.stopPropagation();
        var ct = card.getAttribute('data-col-type');
        var cardsContainer = card.parentNode;
        card.remove();
        updateColCount(ct);
        checkEmpty(cardsContainer, ct);
        // Sync to GitHub
        saveKanbanToGitHub();
      });

      // Drag-and-drop
      card.addEventListener('dragstart', function(e){
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.getAttribute('data-col-type'));
        draggedCard = card;
        draggedFromCol = card.getAttribute('data-col-type');
      });
      card.addEventListener('dragend', function(){
        card.classList.remove('dragging');
        planPanel.querySelectorAll('.kanban-col').forEach(function(c){
          c.classList.remove('drag-over');
        });
        draggedCard = null;
        draggedFromCol = null;
      });

      // Save to GitHub when inline editing (contenteditable) loses focus
      card.querySelectorAll('[contenteditable="true"]').forEach(function(el){
        el.addEventListener('blur', function(){
          saveKanbanToGitHub();
        });
      });
    }

    // Move a card from one column to another, updating its content and style
    function moveCardToCol(card, fromCol, toCol){
      if(fromCol === toCol) return;
      // Capture current editable content
      var titleEl = card.querySelector('h4[contenteditable]');
      var descEl = card.querySelector('p[contenteditable]');
      var deadlineEl = card.querySelector('.kc-deadline[contenteditable], .kc-date[contenteditable]');
      var title = titleEl ? titleEl.textContent.trim() : '';
      var desc = descEl ? descEl.textContent.trim() : '';
      // Ignore placeholder text
      if(desc === '...' || desc === '') desc = '';
      var deadline = deadlineEl ? deadlineEl.textContent.trim() : '';
      var dlDefault = (document.documentElement.getAttribute('data-lang') === 'en') ? 'Due' : '截止';
      if(deadline === dlDefault || deadline === '截止') deadline = '';

      // Remove from old column
      var oldContainer = card.parentNode;

      // Create a clean clone (cloneNode(false) = no children, no event listeners on the element itself)
      var newCard = card.cloneNode(false);
      newCard.classList.remove('dragging');

      oldContainer.removeChild(card);
      checkEmpty(oldContainer, fromCol);

      // Build content for new column on the clean clone
      buildCardContent(newCard, toCol, title, desc, deadline);
      attachCardEvents(newCard);

      // Add to new column
      var newContainer = planPanel.querySelector('[data-col-cards="'+toCol+'"]');
      if(newContainer){
        var empty = newContainer.querySelector('.kanban-empty');
        if(empty) empty.style.display = 'none';
        newContainer.insertBefore(newCard, newContainer.firstChild);
      }

      // Update counts for both columns
      updateColCount(fromCol);
      updateColCount(toCol);
      checkEmpty(oldContainer, fromCol);
      if(newContainer) checkEmpty(newContainer, toCol);
      // Sync to GitHub
      saveKanbanToGitHub();
    }

    // Drag-and-drop on columns
    var draggedCard = null;
    var draggedFromCol = null;
    planPanel.querySelectorAll('.kanban-col').forEach(function(col){
      var cardsContainer = col.querySelector('.kanban-cards');
      if(!cardsContainer) return;

      col.addEventListener('dragover', function(e){
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        col.classList.add('drag-over');
      });
      col.addEventListener('dragleave', function(e){
        // Only remove if leaving the column entirely
        if(!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
      });
      col.addEventListener('drop', function(e){
        e.preventDefault();
        col.classList.remove('drag-over');
        if(!draggedCard || !draggedFromCol) return;
        var toCol = col.getAttribute('data-col');
        if(draggedFromCol === toCol) return;
        moveCardToCol(draggedCard, draggedFromCol, toCol);
      });
    });

    function escapeHtml(s){
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function updateColCount(colType){
      var cardsContainer = planPanel.querySelector('[data-col-cards="'+colType+'"]');
      if(!cardsContainer) return;
      var count = cardsContainer.querySelectorAll('.kanban-card').length;
      var col = planPanel.querySelector('.kanban-col[data-col="'+colType+'"]');
      if(col){
        var countEl = col.querySelector('.col-count');
        if(countEl) countEl.textContent = count;
      }
      // Update progress stats
      var todoCount = planPanel.querySelectorAll('[data-col-cards="todo"] .kanban-card').length;
      var wipCount = planPanel.querySelectorAll('[data-col-cards="wip"] .kanban-card').length;
      var doneCount = planPanel.querySelectorAll('[data-col-cards="done"] .kanban-card').length;
      var total = todoCount + wipCount + doneCount;
      var psNums = planPanel.querySelectorAll('.plan-stat .ps-num');
      if(psNums.length >= 4){
        psNums[0].textContent = total;            // 本周任务
        psNums[1].textContent = doneCount;          // 已完成
        psNums[2].textContent = wipCount;           // 进行中
        psNums[3].textContent = todoCount;          // 待办
      }
      // Update ring
      var pct = total > 0 ? Math.round(doneCount / total * 100) : 0;
      var ringPct = planPanel.querySelector('.ring-pct');
      var ringFill = planPanel.querySelector('.ring-fill');
      if(ringPct) ringPct.textContent = pct + '%';
      if(ringFill){
        var circumference = 327;
        ringFill.setAttribute('stroke-dashoffset', circumference - (circumference * pct / 100));
      }
    }

    function checkEmpty(cardsContainer, colType){
      var cards = cardsContainer.querySelectorAll('.kanban-card').length;
      var form = cardsContainer.querySelector('.kanban-card-new');
      var empty = cardsContainer.querySelector('.kanban-empty');
      if(cards === 0 && !form){
        if(empty) empty.style.display = '';
      } else {
        if(empty) empty.style.display = 'none';
      }
    }

    /* ---- Kanban Sync to GitHub ---- */
    // Collect all kanban card data from DOM into a JSON-serializable object
    function collectKanbanData(){
      var result = { todo: [], wip: [], done: [] };
      ['todo','wip','done'].forEach(function(colType){
        var container = planPanel.querySelector('[data-col-cards="'+colType+'"]');
        if(!container) return;
        container.querySelectorAll('.kanban-card').forEach(function(card){
          var titleEl = card.querySelector('h4[contenteditable]');
          var descEl = card.querySelector('p[contenteditable]');
          var deadlineEl = card.querySelector('.kc-deadline[contenteditable], .kc-date[contenteditable]');
          var title = titleEl ? titleEl.textContent.trim() : '';
          var desc = descEl ? descEl.textContent.trim() : '';
          if(desc === '...') desc = '';
          var deadline = deadlineEl ? deadlineEl.textContent.trim() : '';
          var dlDefault = (document.documentElement.getAttribute('data-lang') === 'en') ? 'Due' : '截止';
          if(deadline === dlDefault || deadline === '截止') deadline = '';
          result[colType].push({ title: title, desc: desc, deadline: deadline });
        });
      });
      return result;
    }

    // Save kanban data to GitHub via the existing sync system
    var _kanbanSaveTimer = null;
    function saveKanbanToGitHub(){
      // Debounce: wait 800ms after last edit to avoid spamming the API
      if(_kanbanSaveTimer) clearTimeout(_kanbanSaveTimer);
      _kanbanSaveTimer = setTimeout(function(){
        if(window.__vingData){
          window.__vingData.kanbanTasks = collectKanbanData();
          window.__vingData.lastUpdated = new Date().toISOString();
          if(typeof ghSave === 'function'){
            ghSave(window.__vingData);
          }
        }
      }, 800);
    }

    // Render kanban cards from data (used on page load and auto-refresh)
    function renderKanbanFromData(kanbanData){
      if(!kanbanData || !planPanel) return;
      ['todo','wip','done'].forEach(function(colType){
        var container = planPanel.querySelector('[data-col-cards="'+colType+'"]');
        if(!container) return;
        // Remove existing cards (but not the form or empty placeholder)
        container.querySelectorAll('.kanban-card').forEach(function(c){ c.remove(); });
        var tasks = kanbanData[colType] || [];
        tasks.forEach(function(task){
          var card = createKanbanCard(colType, task.title || '', task.desc || '', task.deadline || '');
          container.insertBefore(card, container.firstChild);
        });
        // Update count and empty state
        updateColCount(colType);
        checkEmpty(container, colType);
      });
    }

    // Expose render function globally for the sync system
    window.__renderKanbanFromData = renderKanbanFromData;
  })();

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
        // Refresh visuals (includes sub-page sync)
        refreshAllVisuals(streamerData);
        // Real-time save to GitHub (debounced)
        saveStreamersToGitHub();
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

  var CONSOLE_TEMPLATE = '【微影 V-ing 跨 AI 会话指令模版 v4.2】\
'
    + '我的网站数据存在 Cloudflare D1 数据库中，请帮我拉取最新数据并继续工作。\
'
    + '\
'
    + '【项目信息】\
'
    + '仓库地址：V-ing7/v-ing-site\
'
    + '分支：main\
'
    + '数据文件：data.json（含主播数据、主题、语言、操作日志）\
'
    + '网站地址：https://v-ing-site.pages.dev\
'
    + 'GitHub Pages：https://V-ing7.github.io/v-ing-site/\
'
    + '\
'
    + '【API 接口】\
'
    + 'Pages Function API 地址：https://v-ing-site.pages.dev/api/\
'
    + '读取数据：GET https://v-ing-site.pages.dev/api/v-ing-data （无需密码）\
'
    + '修改数据：PUT https://v-ing-site.pages.dev/api/v-ing-data （需密码）\
'
    + '触发部署：POST https://v-ing-site.pages.dev/api/v-ing-deploy （需密码）\
'
    + '健康检查：GET https://v-ing-site.pages.dev/api/v-ing-health\
'
    + '\
'
    + '【安全机制】\
'
    + '读取数据无需密码，任何人可查看\
'
    + '修改数据需要密码，请向我询问密码后再操作\
'
    + '密码提示：个人英文名\
'
    + '密码验证：服务端环境变量 WS_PASSWORD 验证，无硬编码默认值\
'
    + '\
'
    + '【数据存储 v4.2】\
'
    + '1. 数据存储在 Cloudflare D1 数据库（SQLite），非 GitHub 文件\
'
    + '2. 浏览器编辑保存时通过 Pages Function API 写入 D1 数据库\
'
    + '3. 页面加载时从 D1 读取数据，支持自动刷新检查远端是否有新数据\
'
    + '4. 每 30 秒自动刷新，仅当远端时间戳 > 本地时更新\
'
    + '5. 保存后 90 秒内跳过自动刷新，防止旧 CDN 缓存覆盖新数据\
'
    + '6. 点击导航栏同步徽章可手动强制同步\
'
    + '7. 推送代码到 GitHub main 分支后，GitHub Actions 自动部署到 Cloudflare Pages\
'
    + '\
'
    + '【操作步骤】\
'
    + '1. 用 Pages Function API 读取数据（GET https://v-ing-site.pages.dev/api/v-ing-data）\
'
    + '2. 返回 JSON 格式 { data, lastUpdated, source }，直接使用 data 字段\
'
    + '3. 了解当前数据状态后按我的要求修改\
'
    + '4. 修改后用 Pages Function API PUT 回数据库：\
'
    + '   PUT https://v-ing-site.pages.dev/api/v-ing-data\
'
    + '   Headers: { X-Password: <密码>, Content-Type: application/json }\
'
    + '   Body: { data: <修改后的完整JSON> }\
'
    + '\
'
    + '【注意事项】\
'
    + '- 修改数据前必须向我询问密码，我不会在指令模版中提供密码\
'
    + '- 密码提示：个人英文名\
'
    + '- data.json 中的中文字符必须用 UTF-8 编码，不能乱码\
'
    + '- operationLog 记录每次重要操作，格式：{date, time, action, status}\
'
    + '- instructionTemplate 区域包含项目元信息，保持最新'

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

    var inEditMode = editModeActive || subpageEditMode;

    // If in edit mode and there's pending new data, ask user if they want to apply
    if(inEditMode && _hasNewDataPending){
      var apply = confirm(lang === 'zh' 
        ? '检测到有新数据更新。是否立即应用？（当前编辑的内容会被保存）'
        : 'New data available. Apply now? (Your current edits will be saved)');
      if(apply){
        // Save current edits first, then load new data
        if(editModeActive){
          saveReportData(streamerData);
        } else {
          saveStreamersToGitHub();
        }
        _hasNewDataPending = false;
        // Wait a bit for save to start, then load
        setTimeout(function(){
          ghLoad().then(function(){
            _log('✓ Manual sync complete');
          }).catch(function(){
            setSyncStatus('error');
          });
        }, 2000);
      }
      return;
    }

    // If in edit mode but no pending data, just check for updates
    if(inEditMode){
      _log('Manual sync in edit mode — checking for updates (will notify if found)');
      ghLoad({ background: true }).then(function(){
        if(_hasNewDataPending){
          _log('New data found — click sync badge to apply');
        } else {
          _log('✓ Already up to date');
        }
      }).catch(function(){
        setSyncStatus('error');
      });
      return;
    }

    // Normal mode: full foreground sync
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

  /* ---------- QR Code: dynamic color with QRCodeStyling (transparent bg) ---------- */
  var _qrInstance=null;
  var _qrData='https://v-ing-site.pages.dev';
  var _qrReady=false;

  function getQRColor(){
    var theme=document.documentElement.getAttribute('data-theme');
    return theme==='dark' ? '#ffdcb4' : '#3a3835';
  }

  function buildQROptions(){
    var dotColor=getQRColor();
    return {
      width:240,height:240,type:'canvas',
      data:_qrData,
      dotsOptions:{type:'rounded',color:dotColor},
      backgroundOptions:{color:'rgba(0,0,0,0)'},
      cornersSquareOptions:{type:'extra-rounded',color:dotColor},
      cornersDotOptions:{type:'dot',color:dotColor},
      qrOptions:{errorCorrectionLevel:'M'}
    };
  }

  function initCustomQR(){
    var container=document.getElementById('bcQRCode');
    if(!container)return;
    container.innerHTML='';

    if(typeof QRCodeStyling!=='undefined'){
      try{
        _qrInstance=new QRCodeStyling(buildQROptions());
        _qrInstance.append(container);
        _qrReady=true;
        return;
      }catch(e){
        console.warn('[V-ing] QRCodeStyling failed',e);
      }
    }
    // Retry after 500ms if library not yet loaded
    if(!_qrReady){
      setTimeout(initCustomQR,500);
    }
  }

  function updateQRTheme(){
    if(!_qrReady||!_qrInstance){
      setTimeout(updateQRTheme,200);
      return;
    }
    var container=document.getElementById('bcQRCode');
    if(!container)return;
    var dotColor=getQRColor();
    try{
      _qrInstance.update({
        dotsOptions:{type:'rounded',color:dotColor},
        backgroundOptions:{color:'rgba(0,0,0,0)'},
        cornersSquareOptions:{type:'extra-rounded',color:dotColor},
        cornersDotOptions:{type:'dot',color:dotColor}
      });
    }catch(e){
      console.warn('[V-ing] QR update failed, re-creating',e);
      container.innerHTML='';
      _qrInstance=new QRCodeStyling(buildQROptions());
      _qrInstance.append(container);
    }
  }

  window.addEventListener('load',function(){
    setTimeout(initCustomQR,500);
  });

  /* ================================================================
     Cinema Hero — 影视风格首页标题
     ================================================================ */
  function initCinemaHero(){
    // Dust particles
    var dust = document.getElementById('cinemaDust');
    if(!dust) return;
    for(var i=0;i<35;i++){
      var s=document.createElement('span');
      s.style.left=Math.random()*100+'%';
      s.style.animationDuration=(7+Math.random()*15)+'s';
      s.style.animationDelay=Math.random()*12+'s';
      var sz=1+Math.random()*2.5;
      s.style.width=sz+'px';
      s.style.height=sz+'px';
      s.style.opacity=.15+Math.random()*.4;
      dust.appendChild(s);
    }

    // Timecode
    var tc=document.getElementById('cinemaTc');
    if(tc){
      var frames=0;
      setInterval(function(){
        frames++;
        var f=frames%24;
        var s=Math.floor(frames/24)%60;
        var m=Math.floor(frames/1440)%60;
        var h=Math.floor(frames/86400);
        tc.textContent=
          String(h).padStart(2,'0')+':'+
          String(m).padStart(2,'0')+':'+
          String(s).padStart(2,'0')+':'+
          String(f).padStart(2,'0');
      },42);
    }

    // Scroll-driven transition
    var ticking=false;
    function updateScroll(){
      var scrollY=window.scrollY||window.pageYOffset;
      var vh=window.innerHeight;
      var progress=Math.min(scrollY/vh,1);
      // Ease out cubic
      var eased=1-Math.pow(1-progress,3);
      document.documentElement.style.setProperty('--cinema-scroll-progress',eased);
      ticking=false;
    }
    function onScroll(){
      if(!ticking){
        requestAnimationFrame(updateScroll);
        ticking=true;
      }
    }
    window.addEventListener('scroll',onScroll,{passive:true});
    window.addEventListener('resize',onScroll,{passive:true});
    updateScroll();
  }

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',initCinemaHero);
  }else{
    initCinemaHero();
  }

  // Expose save function and sync status for storyboard module
  window.__ghSave = ghSave;
  try{ Object.defineProperty(window,'__ghSyncStatus',{get:function(){return ghSyncStatus;}}); }catch(e){ window.__ghSyncStatus = ghSyncStatus; }

})();

/* ================================================================
   Storyboard Table Module (Multi-Project v2)
   ================================================================ */
(function(){
  'use strict';

  var SHOT_SIZES = [
    {value:'',label:{cn:'选择景别',en:'Select'}},
    {value:'远景',label:{cn:'远景',en:'Wide'}},
    {value:'全景',label:{cn:'全景',en:'Full'}},
    {value:'中景',label:{cn:'中景',en:'Medium'}},
    {value:'近景',label:{cn:'近景',en:'Close-up'}},
    {value:'特写',label:{cn:'特写',en:'Extreme CU'}},
    {value:'大特写',label:{cn:'大特写',en:'Macro'}},
    {value:'航拍',label:{cn:'航拍',en:'Aerial'}}
  ];

  var MOVEMENTS = [
    {value:'',label:{cn:'选择运镜',en:'Select'}},
    {value:'固定',label:{cn:'固定',en:'Static'}},
    {value:'推',label:{cn:'推',en:'Push in'}},
    {value:'拉',label:{cn:'拉',en:'Pull out'}},
    {value:'摇',label:{cn:'摇',en:'Pan'}},
    {value:'移',label:{cn:'移',en:'Tracking'}},
    {value:'跟',label:{cn:'跟',en:'Follow'}},
    {value:'升',label:{cn:'升',en:'Crane up'}},
    {value:'降',label:{cn:'降',en:'Crane down'}},
    {value:'环绕',label:{cn:'环绕',en:'Orbit'}},
    {value:'手持',label:{cn:'手持',en:'Handheld'}},
    {value:'肩扛',label:{cn:'肩扛',en:'Shoulder'}},
    {value:'滑轨',label:{cn:'滑轨',en:'Slider'}},
    {value:'斯坦尼康',label:{cn:'斯坦尼康',en:'Steadicam'}}
  ];

  var LONG_PRESS_MS = 1200;  // long-press duration
  var currentLang = localStorage.getItem('v-ing-lang') || 'zh';

  // Multi-project data
  var projects = [];       // array of {id, projectName, shootDate, rows, lastUpdated}
  var currentProjectId = null;  // currently editing project id (null = new)
  var hasUnsavedChanges = false;

  // Long-press guard: prevents DOM rebuild during press
  var sbLongPressActive = false;
  var sbPendingRender = false;
  // Track last touch time to suppress compatibility mouse events
  var sbLastTouchTime = 0;
  // Track currently swiped-open card (for left-swipe delete)
  var sbSwipedCard = null;
  // Expose long-press state to outer scope (for auto-refresh guard)
  try{ Object.defineProperty(window, '__sbLongPressActive', {get: function(){ return sbLongPressActive; }}); }catch(e){ window.__sbLongPressActive = false; }

  // DOM refs
  var projectListView = document.getElementById('sbProjectListView');
  var editorView = document.getElementById('sbEditorView');
  var detailView = document.getElementById('sbDetailView');
  var projectGrid = document.getElementById('sbProjectGrid');
  var projectEmpty = document.getElementById('sbProjectEmpty');

  var tableBody = document.getElementById('sbTaskList');
  var visualList = document.getElementById('sbVisualList');
  var sbEmpty = document.getElementById('sbEmpty');
  var sbTable = document.getElementById('sbTable');
  var sbAddRow = document.getElementById('sbAddRow');
  var sbSave = document.getElementById('sbSave');
  var sbProjectInput = document.getElementById('sbProjectInput');
  var sbDateInput = document.getElementById('sbDateInput');
  var sbProjectName = document.getElementById('sbProjectName');
  var sbStatusInfo = document.getElementById('sbStatusInfo');
  var sbStatusSync = document.getElementById('sbStatusSync');
  var sbTaskCount = document.getElementById('sbTaskCount');

  var sbAddProject = document.getElementById('sbAddProject');
  var sbBackToList = document.getElementById('sbBackToList');
  var sbDetailBack = document.getElementById('sbDetailBack');
  var sbDetailEdit = document.getElementById('sbDetailEdit');
  var sbBatchShots = document.getElementById('sbBatchShots');
  var sbBatchDialog = document.getElementById('sbBatchDialog');
  var sbBatchText = document.getElementById('sbBatchText');
  var sbBatchClose = document.getElementById('sbBatchClose');
  var sbBatchConfirm = document.getElementById('sbBatchConfirm');
  var sbDetailTitle = document.getElementById('sbDetailTitle');
  var sbDetailInfo = document.getElementById('sbDetailInfo');
  var sbDetailTaskList = document.getElementById('sbDetailTaskList');
  var sbDetailVisualList = document.getElementById('sbDetailVisualList');

  function t(cn,en){
    return currentLang === 'en' ? en : cn;
  }

  function genId(){
    return 'sb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
  }

  function createEmptyRow(){
    return {shotTask:'',visual:'',script:'',done:false};
  }

  function getShotSizeLabel(val){
    for(var i=0;i<SHOT_SIZES.length;i++){
      if(SHOT_SIZES[i].value === val) return t(SHOT_SIZES[i].label.cn, SHOT_SIZES[i].label.en);
    }
    return '';
  }

  function getMovementLabel(val){
    for(var i=0;i<MOVEMENTS.length;i++){
      if(MOVEMENTS[i].value === val) return t(MOVEMENTS[i].label.cn, MOVEMENTS[i].label.en);
    }
    return '';
  }

  /* ---------- Project List Rendering ---------- */
  function renderProjectList(){
    if(!projectGrid) return;

    // Defer render if a long-press is in progress to avoid interrupting it
    if(sbLongPressActive){
      sbPendingRender = true;
      return;
    }
    sbPendingRender = false;
    projectGrid.innerHTML = '';

    if(projects.length === 0){
      if(projectEmpty) projectEmpty.style.display = '';
      return;
    }
    if(projectEmpty) projectEmpty.style.display = 'none';

    projects.forEach(function(proj){
      var card = document.createElement('div');
      card.className = 'sb-pcard';
      card.setAttribute('data-pid', proj.id);

      var shotCount = (proj.rows || []).length;
      var updated = proj.lastUpdated ? new Date(proj.lastUpdated).toLocaleString() : '--';

      card.innerHTML =
        '<div class="sb-pcard-action">' +
          '<button class="sb-pcard-del-btn" type="button">' +
            '<div class="sb-pcard-del-fill"></div>' +
            '<div class="sb-pcard-del-icon">' +
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>' +
            '</div>' +
            '<span class="sb-pcard-del-label">' + t('删除','Delete') + '</span>' +
          '</button>' +
        '</div>' +
        '<div class="sb-pcard-content">' +
          '<div class="sb-pcard-progress"></div>' +
          '<div class="sb-pcard-body">' +
            '<div class="sb-pcard-name">' + escapeHtml(proj.projectName || t('未命名项目','Untitled Project')) + '</div>' +
            '<div class="sb-pcard-meta">' +
              '<span class="sb-pcard-shots">' + shotCount + ' ' + t('任务','tasks') + '</span>' +
              (proj.shootDate ? '<span class="sb-pcard-date">' + proj.shootDate + '</span>' : '') +
            '</div>' +
            '<div class="sb-pcard-updated">' + t('更新于','Updated') + ' ' + updated + '</div>' +
          '</div>' +
          '<div class="sb-pcard-hint">' + t('左滑露出删除 · 长按删除按钮确认','Swipe left · Long-press delete to confirm') + '</div>' +
        '</div>';

      // Delete button: long-press to delete with progress bar
      var delBtn = card.querySelector('.sb-pcard-del-btn');
      if(delBtn){
        bindDeleteLongPress(delBtn, proj.id, proj.projectName || t('未命名项目','Untitled Project'));
      }

      // Long-press + swipe handler
      bindLongPress(card, proj.id);

      projectGrid.appendChild(card);
    });
  }

  /* ---------- Delete Project ---------- */

  /* Delete via long-press: progress bar fills, release early = cancel */
  var DEL_PRESS_MS = 1200;

  function bindDeleteLongPress(btn, pid, name){
    var delTimer = null;
    var delDone = false;
    var pressing = false;
    var lastTouch = 0;

    function startDelPress(e){
      if(pressing) return;
      // Only start if the card is in swiped-left state
      var card = btn.closest('.sb-pcard');
      if(!card || !card.classList.contains('swiped-left')) return;

      pressing = true;
      delDone = false;
      e.preventDefault();
      e.stopPropagation();

      btn.classList.add('pressing');

      delTimer = setTimeout(function(){
        delDone = true;
        pressing = false;
        btn.classList.remove('pressing');
        btn.classList.add('done');
        // Small delay for the "done" animation
        setTimeout(function(){
          deleteProject(pid);
        }, 200);
      }, DEL_PRESS_MS);
    }

    function endDelPress(e){
      if(!pressing) return;
      pressing = false;

      if(delTimer){ clearTimeout(delTimer); delTimer = null; }
      btn.classList.remove('pressing');

      if(!delDone && e && e.preventDefault){
        e.preventDefault();
        e.stopPropagation();
      }
    }

    // Mouse
    btn.addEventListener('mousedown', function(e){
      if(e.button !== 0) return;
      if(Date.now() - lastTouch < 800) return;
      startDelPress(e);
    });
    btn.addEventListener('mouseup', endDelPress);
    btn.addEventListener('mouseleave', endDelPress);

    // Touch
    btn.addEventListener('touchstart', function(e){
      lastTouch = Date.now();
      startDelPress(e);
    }, {passive:false});
    btn.addEventListener('touchend', function(e){
      lastTouch = Date.now();
      endDelPress(e);
    });
    btn.addEventListener('touchcancel', endDelPress);

    // Prevent click navigation
    btn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function deleteProject(pid){
    var idx = projects.findIndex(function(p){ return p.id === pid; });
    if(idx < 0) return;

    var proj = projects[idx];
    var projName = proj.projectName || t('未命名项目','Untitled Project');

    // Remove from projects array
    projects.splice(idx, 1);

    // Update window.__vingData
    if(window.__vingData){
      window.__vingData.storyboardProjects = projects.map(function(p){
        return {
          id: p.id,
          projectName: p.projectName || '',
          shootDate: p.shootDate || '',
          rows: (p.rows || []).map(function(r){
            return {shotTask:r.shotTask||'',visual:r.visual||'',script:r.script||'',done:r.done||false};
          }),
          lastUpdated: p.lastUpdated || new Date().toISOString()
        };
      });

      // Operation log
      if(window.__vingData.operationLog && Array.isArray(window.__vingData.operationLog)){
        var now = new Date();
        var bjTime = new Date(now.getTime() + 8 * 3600 * 1000);
        window.__vingData.operationLog.push({
          date: bjTime.toISOString().slice(0,10),
          time: bjTime.toISOString().slice(11,16),
          action: t('删除计划项目：','Deleted plan project: ') + projName,
          status: t('完成','Done')
        });
      }

      // Save to cloud
      if(typeof window.__ghSave === 'function'){
        window.__ghSave(window.__vingData);
      }
    }

    renderProjectList();
  }

  function escapeHtml(str){
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------- Long Press + Swipe-to-Delete ---------- */
  var SWIPE_THRESHOLD = 10;     // px to start swiping
  var SWIPE_ACTION_W = 80;      // width of delete action
  var SWIPE_OPEN_THRESHOLD = 40; // px to snap open

  function bindLongPress(card, pid){
    var pressTimer = null;
    var triggered = false;
    var startX = 0, startY = 0;
    var isPressing = false;
    var isSwiping = false;
    var swipeDx = 0;
    var contentEl = card.querySelector('.sb-pcard-content');

    function startPress(e){
      if(isPressing) return;
      isPressing = true;
      triggered = false;
      isSwiping = false;
      swipeDx = 0;

      // Close any other swiped-open card
      if(sbSwipedCard && sbSwipedCard !== card){
        sbSwipedCard.classList.remove('swiped-left');
        sbSwipedCard = null;
      }

      sbLongPressActive = true;
      card.classList.add('long-pressing');

      if(e.touches && e.touches[0]){
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      } else if(e.clientX !== undefined){
        startX = e.clientX;
        startY = e.clientY;
      }

      requestAnimationFrame(function(){
        var bar = card.querySelector('.sb-pcard-progress');
        if(bar){
          bar.classList.add('active');
        }
      });

      pressTimer = setTimeout(function(){
        triggered = true;
        isPressing = false;
        sbLongPressActive = false;
        card.classList.remove('long-pressing');
        var bar2 = card.querySelector('.sb-pcard-progress');
        if(bar2) bar2.classList.remove('active');
        openDetailPage(pid);
      }, LONG_PRESS_MS);
    }

    function cancelPress(keepPressing){
      if(!keepPressing){
        isPressing = false;
        sbLongPressActive = false;
      }
      card.classList.remove('long-pressing');
      var bar = card.querySelector('.sb-pcard-progress');
      if(bar) bar.classList.remove('active');
      if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; }
      if(!keepPressing && sbPendingRender){
        setTimeout(function(){ renderProjectList(); }, 0);
      }
    }

    // Handle touch/mouse move — swipe detection + real-time transform
    function handleMove(e){
      if(!isPressing && !isSwiping) return;

      var cx, cy;
      if(e.touches && e.touches[0]){
        cx = e.touches[0].clientX;
        cy = e.touches[0].clientY;
      } else if(e.clientX !== undefined){
        cx = e.clientX;
        cy = e.clientY;
      } else return;

      var dx = cx - startX;
      var dy = cy - startY;

      if(!isSwiping){
        // Not swiping yet — check threshold
        if(Math.abs(dx) > SWIPE_THRESHOLD || Math.abs(dy) > SWIPE_THRESHOLD){
          // Horizontal movement dominates → start swiping
          if(Math.abs(dx) > Math.abs(dy)){
            isSwiping = true;
            cancelPress(true); // cancel long-press timer but keep isPressing for swipe tracking
          } else {
            // Vertical movement → just cancel long-press
            cancelPress();
            return;
          }
        } else {
          return; // within tolerance, keep long-pressing
        }
      }

      if(isSwiping && contentEl){
        swipeDx = dx;
        var isOpen = card.classList.contains('swiped-left');
        var base = isOpen ? -SWIPE_ACTION_W : 0;
        var offset = Math.max(-SWIPE_ACTION_W, Math.min(0, base + dx));
        contentEl.style.transition = 'none';
        contentEl.style.transform = 'translateX(' + offset + 'px)';
      }
    }

    function endSwipe(){
      if(!isSwiping) return false;
      isSwiping = false;

      if(contentEl){
        contentEl.style.transition = '';
        contentEl.style.transform = '';
      }

      var isOpen = card.classList.contains('swiped-left');
      var base = isOpen ? -SWIPE_ACTION_W : 0;
      var total = base + swipeDx;

      if(total < -SWIPE_OPEN_THRESHOLD){
        card.classList.add('swiped-left');
        sbSwipedCard = card;
      } else {
        card.classList.remove('swiped-left');
        if(sbSwipedCard === card) sbSwipedCard = null;
      }

      isPressing = false;
      sbLongPressActive = false;
      return true;
    }

    // ---- Mouse events ----
    card.addEventListener('mousedown', function(e){
      if(e.target.closest('button')) return;
      if(e.button !== 0) return;
      if(Date.now() - sbLastTouchTime < 800) return;
      startPress(e);
    });
    card.addEventListener('mousemove', function(e){
      if(isPressing && (isSwiping || (e.buttons & 1))){
        handleMove(e);
      }
    });
    card.addEventListener('mouseup', function(e){
      if(triggered){
        e.preventDefault();
        e.stopPropagation();
      }
      if(endSwipe()) return;
      cancelPress();
    });
    card.addEventListener('mouseleave', function(){
      if(isSwiping){ endSwipe(); }
      else { cancelPress(); }
    });

    // ---- Touch events ----
    card.addEventListener('touchstart', function(e){
      if(e.target.closest('button')) return;
      sbLastTouchTime = Date.now();
      startPress(e);
    }, {passive:true});
    card.addEventListener('touchmove', handleMove, {passive:true});
    card.addEventListener('touchend', function(e){
      sbLastTouchTime = Date.now();
      if(triggered){
        e.preventDefault();
        e.stopPropagation();
      }
      if(endSwipe()) return;
      cancelPress();
    });
    card.addEventListener('touchcancel', function(){
      if(isSwiping){ endSwipe(); }
      else { cancelPress(); }
    });

    // ---- Click: close swiped card or prevent long-press navigation ----
    card.addEventListener('click', function(e){
      if(triggered){
        e.preventDefault();
        e.stopPropagation();
        triggered = false;
        return;
      }
      if(card.classList.contains('swiped-left')){
        e.preventDefault();
        e.stopPropagation();
        card.classList.remove('swiped-left');
        sbSwipedCard = null;
      }
    });
  }

  /* ---------- Detail Page (read-only view) ---------- */
  function openDetailPage(pid){
    var proj = projects.find(function(p){ return p.id === pid; });
    if(!proj) return;

    // Collapse: hide project list, show detail
    if(projectListView) projectListView.style.display = 'none';
    if(editorView) editorView.style.display = 'none';
    if(detailView){
      detailView.style.display = '';
      detailView.classList.add('visible');
    }

    // Populate
    if(sbDetailTitle) sbDetailTitle.textContent = proj.projectName || t('未命名项目','Untitled Project');

    if(sbDetailInfo){
      var shotCount = (proj.rows || []).length;
      sbDetailInfo.innerHTML =
        '<span><span class="sb-detail-label">' + t('项目名称','Project') + ':</span> ' + escapeHtml(proj.projectName || '--') + '</span>' +
        '<span><span class="sb-detail-label">' + t('拍摄日期','Shoot Date') + ':</span> ' + (proj.shootDate || '--') + '</span>' +
        '<span><span class="sb-detail-label">' + t('任务数','Tasks') + ':</span> ' + shotCount + '</span>';
    }

    // Render read-only table
    if(sbDetailTaskList){
      sbDetailTaskList.innerHTML = '';
      if(!proj.rows || proj.rows.length === 0){
        sbDetailTaskList.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-quaternary)">' + t('暂无任务','No tasks') + '</div>';
      } else {
        proj.rows.forEach(function(row, idx){
          var card = document.createElement('div');
          card.className = 'sb-task-card' + (row.done ? ' done' : '');
          card.innerHTML =
            '<div class="sb-task-card-content">' +
              '<span class="sb-task-num">' + (idx + 1) + '</span>' +
              '<span class="sb-task-text">' + escapeHtml(row.shotTask || '') + '</span>' +
            '</div>' +
            (row.done ? '<span class="sb-task-badge">' + t('已完成','Done') + '</span>' : '');
          sbDetailTaskList.appendChild(card);
        });
      }
    }

    if(sbDetailVisualList){
      sbDetailVisualList.innerHTML = '';
      if(!proj.rows || proj.rows.length === 0){
        sbDetailVisualList.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-quaternary)">' + t('暂无画面内容','No visual content') + '</div>';
      } else {
        proj.rows.forEach(function(row, idx){
          var item = document.createElement('div');
          item.className = 'sb-visual-item';
          item.innerHTML =
            '<div class="sb-visual-num">' + (idx + 1) + '</div>' +
            '<div class="sb-visual-text" style="white-space:pre-wrap;word-break:break-word">' + escapeHtml(row.visual || '') + '</div>';
          sbDetailVisualList.appendChild(item);
        });
      }
    }

    // Store current project id for edit button
    detailView.setAttribute('data-pid', pid);

    // Smooth scroll to top of detail
    if(detailView) detailView.scrollIntoView({behavior:'smooth',block:'start'});
  }

  function backToProjectList(){
    if(detailView){ detailView.style.display = 'none'; detailView.classList.remove('visible'); }
    if(editorView){ editorView.style.display = 'none'; editorView.classList.remove('visible'); }
    if(projectListView) projectListView.style.display = '';
    renderProjectList();
  }

  /* ---------- Editor (add/edit project) ---------- */
  function openEditor(pid){
    // pid = null for new project, or existing project id
    currentProjectId = pid || null;
    hasUnsavedChanges = false;

    if(projectListView) projectListView.style.display = 'none';
    if(detailView) detailView.style.display = 'none';
    if(editorView){
      editorView.style.display = '';
      editorView.classList.add('visible');
    }

    var proj = pid ? projects.find(function(p){ return p.id === pid; }) : null;

    if(sbProjectInput) sbProjectInput.value = proj ? (proj.projectName || '') : '';
    if(sbDateInput) sbDateInput.value = proj ? (proj.shootDate || '') : '';
    if(sbProjectName) sbProjectName.textContent = proj ? (proj.projectName || t('未命名项目','Untitled Project')) : t('新项目','New Project');

    // Clear and load rows
    if(proj && proj.rows && proj.rows.length > 0){
      renderAllRows(proj.rows);
    } else {
      renderAllRows([createEmptyRow()]);
    }

    if(sbStatusSync){
      sbStatusSync.textContent = '';
      sbStatusSync.className = 'sb-status-sync';
    }

    // Safety: re-resize all textareas after a frame to ensure correct heights
    requestAnimationFrame(function(){
      if(tableBody){
        tableBody.querySelectorAll('textarea.sb-cell').forEach(function(ta){
          autoResizeTextarea(ta);
        });
      }
      if(visualList){
        visualList.querySelectorAll('textarea.sb-cell').forEach(function(ta){
          autoResizeTextarea(ta);
        });
      }
    });

    if(editorView) editorView.scrollIntoView({behavior:'smooth',block:'start'});
  }

  function getCurrentProjectData(){
    var rows = editRows.map(function(r){
      return {
        shotTask: r.shotTask || '',
        visual: r.visual || '',
        done: r.done || false
      };
    });
    return {
      id: currentProjectId || genId(),
      projectName: sbProjectInput ? sbProjectInput.value.trim() : '',
      shootDate: sbDateInput ? sbDateInput.value : '',
      rows: rows,
      lastUpdated: new Date().toISOString(),
      _local: !currentProjectId,  // true if this is a new unsaved project
      _saved: false
    };
  }

  /* ---------- Auto-resize textarea ---------- */
  function autoResizeTextarea(ta){
    if(!ta) return;
    // Reset height to auto to get true scrollHeight
    ta.style.height = '0px';
    // Force browser layout
    var sh = ta.scrollHeight;
    ta.style.height = Math.max(sh, 28) + 'px';
  }

  /* ---------- Row Rendering: Task Cards + Visual Textareas ---------- */

  // Current editing rows (shared state)
  var editRows = [];

  function renderAllRows(rows){
    editRows = rows || [];
    renderTaskCards();
    renderVisualList();
    updateStatusInfo();
    updateEmptyState();
  }

  function renderTaskCards(){
    if(!tableBody) return;
    tableBody.innerHTML = '';
    editRows.forEach(function(row, idx){
      var card = document.createElement('div');
      card.className = 'sb-task-card' + (row.done ? ' done' : '');
      card.setAttribute('data-idx', idx);
      card.innerHTML =
        '<div class="sb-task-card-content">' +
          '<span class="sb-task-num">' + (idx + 1) + '</span>' +
          '<span class="sb-task-text" ' + (row.done ? '' : 'contenteditable="true"') + ' data-field="shotTask">' + escapeHtml(row.shotTask || '') + '</span>' +
        '</div>' +
        '<div class="sb-task-progress"></div>';
      tableBody.appendChild(card);

      // Long-press: if not done → mark green/done; if done → delete
      bindTaskLongPress(card, idx, !!row.done);

      // Editable text (only when not done)
      var textEl = card.querySelector('[data-field="shotTask"]');
      if(textEl && !row.done){
        textEl.addEventListener('input', function(){
          editRows[idx].shotTask = textEl.textContent;
          markUnsaved();
        });
      }
    });

    // Update count
    if(sbTaskCount) sbTaskCount.textContent = editRows.length;
  }

  function renderVisualList(){
    if(!visualList) return;
    visualList.innerHTML = '';
    editRows.forEach(function(row, idx){
      var item = document.createElement('div');
      item.className = 'sb-visual-item';
      item.innerHTML =
        '<div class="sb-visual-num">' + (idx + 1) + '</div>' +
        '<textarea class="sb-cell sb-cell-desc" data-idx="' + idx + '" data-placeholder="' + t('描述画面...','Describe visual...') + '" rows="2">' + escapeHtml(row.visual || '') + '</textarea>';
      visualList.appendChild(item);

      var ta = item.querySelector('textarea');
      autoResizeTextarea(ta);
      ta.addEventListener('input', function(){
        autoResizeTextarea(ta);
        editRows[idx].visual = ta.value;
        markUnsaved();
      });
    });
  }

  // Long-press: if not done → progress fills → turn green (done)
  //            if already done → progress fills → delete
  function bindTaskLongPress(card, idx, isDone){
    var pressTimer = null;
    var pressing = false;

    function startPress(e){
      if(pressing) return;
      // Don't long-press when editing text
      if(e.target && e.target.closest && e.target.closest('[contenteditable]')) return;
      pressing = true;
      card.classList.add('pressing');
      var bar = card.querySelector('.sb-task-progress');
      if(bar) bar.classList.add('active');

      pressTimer = setTimeout(function(){
        pressing = false;
        card.classList.remove('pressing');
        var bar2 = card.querySelector('.sb-task-progress');
        if(bar2) bar2.classList.remove('active');

        if(isDone){
          // Already green → delete
          editRows.splice(idx, 1);
          renderAllRows(editRows);
        } else {
          // Not done → mark as done (green)
          editRows[idx].done = true;
          renderTaskCards();
        }
        markUnsaved();
      }, 1200);
    }

    function cancelPress(){
      if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; }
      pressing = false;
      card.classList.remove('pressing');
      var bar = card.querySelector('.sb-task-progress');
      if(bar) bar.classList.remove('active');
    }

    card.addEventListener('mousedown', function(e){
      if(e.button !== 0) return;
      startPress(e);
    });
    card.addEventListener('mouseup', cancelPress);
    card.addEventListener('mouseleave', cancelPress);
    card.addEventListener('touchstart', function(e){
      if(e.target && e.target.closest && e.target.closest('[contenteditable]')) return;
      e.preventDefault();
      startPress(e);
    }, {passive:false});
    card.addEventListener('touchend', cancelPress);
    card.addEventListener('touchcancel', cancelPress);
  }

  function renderRows(rows){
    renderAllRows(rows && rows.length ? rows : [createEmptyRow()]);
  }

  function addRow(){
    editRows.push(createEmptyRow());
    renderTaskCards();
    renderVisualList();
    updateStatusInfo();
    updateEmptyState();
    markUnsaved();
    if(tableBody && tableBody.lastElementChild){
      tableBody.lastElementChild.scrollIntoView({behavior:'smooth',block:'center'});
    }
  }

  /* ---------- Status helpers ---------- */
  function updateStatusInfo(){
    var count = editRows.length;
    if(sbStatusInfo) sbStatusInfo.textContent = t('共 ','Total: ') + count + t(' 个任务',' tasks');
  }

  function updateEmptyState(){
    var count = editRows.length;
    if(sbEmpty) sbEmpty.style.display = count === 0 ? '' : 'none';
  }

  function markUnsaved(){
    hasUnsavedChanges = true;
    if(sbStatusSync){
      sbStatusSync.textContent = t('未保存','Unsaved');
      sbStatusSync.className = 'sb-status-sync';
    }
  }

  function markSaving(){
    if(sbStatusSync){
      sbStatusSync.textContent = t('保存中...','Saving...');
      sbStatusSync.className = 'sb-status-sync saving';
    }
  }

  function markSaved(){
    hasUnsavedChanges = false;
    if(sbStatusSync){
      sbStatusSync.textContent = t('已同步','Synced');
      sbStatusSync.className = 'sb-status-sync saved';
    }
  }

  /* ---------- Save ---------- */
  function saveToCloud(){
    var projData = getCurrentProjectData();

    if(projData.rows.length === 0 && !projData.projectName){
      if(sbStatusSync){
        sbStatusSync.textContent = t('无内容可保存','Nothing to save');
        sbStatusSync.className = 'sb-status-sync';
      }
      return;
    }

    markSaving();

    // Update or add to projects array
    var existingIdx = projects.findIndex(function(p){ return p.id === projData.id; });
    if(existingIdx >= 0){
      // Preserve _local/_saved flags from existing project
      projData._local = projects[existingIdx]._local || projData._local;
      projData._saved = projects[existingIdx]._saved || false;
      projects[existingIdx] = projData;
    } else {
      projects.push(projData);
      currentProjectId = projData.id;  // now we're editing an existing project
    }

    // Save to window.__vingData (strip internal flags)
    if(window.__vingData){
      window.__vingData.storyboardProjects = projects.map(function(p){
        return {
          id: p.id,
          projectName: p.projectName || '',
          shootDate: p.shootDate || '',
          rows: (p.rows || []).map(function(r){
            return {
              shotTask: r.shotTask || '',
              visual: r.visual || ''
            };
          }),
          lastUpdated: p.lastUpdated || new Date().toISOString()
        };
      });

      // Operation log
      if(window.__vingData.operationLog && Array.isArray(window.__vingData.operationLog)){
        var now = new Date();
        var bjTime = new Date(now.getTime() + 8 * 3600 * 1000);
        window.__vingData.operationLog.push({
          date: bjTime.toISOString().slice(0,10),
          time: bjTime.toISOString().slice(11,16),
          action: t('计划更新：','Plan update: ') + (projData.projectName || t('未命名','Untitled')) + '（' + projData.rows.length + t('个任务',' tasks') + '）',
          status: t('完成','Done')
        });
      }

      if(typeof window.__ghSave === 'function'){
        window.__ghSave(window.__vingData);
        var checkInterval = setInterval(function(){
          var st = window.__ghSyncStatus;
          if(st !== undefined){
            if(st === 'saved' || st === 'success'){
              markSaved();
              // Mark project as saved (no longer local-unsaved)
              var savedIdx = projects.findIndex(function(p){ return p.id === projData.id; });
              if(savedIdx >= 0){
                projects[savedIdx]._saved = true;
                projects[savedIdx]._local = false;
              }
              clearInterval(checkInterval);
              // Auto-collapse to project list after save
              setTimeout(function(){
                backToProjectList();
              }, 800);
            } else if(st === 'error'){
              if(sbStatusSync){
                sbStatusSync.textContent = t('保存失败','Save failed');
                sbStatusSync.className = 'sb-status-sync error';
              }
              clearInterval(checkInterval);
            }
          }
        }, 500);
        setTimeout(function(){ clearInterval(checkInterval); }, 15000);
      } else {
        if(sbStatusSync){
          sbStatusSync.textContent = t('保存功能未就绪','Save unavailable');
          sbStatusSync.className = 'sb-status-sync error';
        }
      }
    } else {
      if(sbStatusSync){
        sbStatusSync.textContent = t('数据未加载','Data not loaded');
        sbStatusSync.className = 'sb-status-sync error';
      }
    }
  }

  /* ---------- Data Sync (called from applyRemoteData) ---------- */
  window.__renderStoryboard = function(data){
    if(!data) return;

    var newProjects = [];

    // Handle old single-project format (migration)
    if(data && !Array.isArray(data) && (data.projectName || data.rows)){
      newProjects.push({
        id: data.id || genId(),
        projectName: data.projectName || '',
        shootDate: data.shootDate || '',
        rows: Array.isArray(data.rows) ? data.rows.map(function(r){
          return {shotTask:r.shotTask||'',visual:r.visual||'',script:r.script||'',done:r.done||false};
        }) : [],
        lastUpdated: data.lastUpdated || new Date().toISOString()
      });
    }

    // Handle new multi-project format
    if(Array.isArray(data)){
      data.forEach(function(proj){
        newProjects.push({
          id: proj.id || genId(),
          projectName: proj.projectName || '',
          shootDate: proj.shootDate || '',
          rows: Array.isArray(proj.rows) ? proj.rows.map(function(r){
            return {shotTask:r.shotTask||'',visual:r.visual||'',script:r.script||'',done:r.done||false};
          }) : [],
          lastUpdated: proj.lastUpdated || new Date().toISOString()
        });
      });
    }

    if(newProjects.length === 0){
      // Remote has no projects — only keep truly local-unsaved ones
      var localUnsaved = projects.filter(function(p){ return p._local && !p._saved; });
      if(localUnsaved.length > 0 && localUnsaved.length !== projects.length){
        projects = localUnsaved;
        renderProjectList();
      }
      return;
    }

    // Content-based signature for fuzzy matching / dedup
    function sig(p){
      // Include row content for stronger dedup
      var rowSig = (p.rows || []).map(function(r){
        return [r.shotTask||'',r.size||'',r.movement||'',r.visual||'',r.audio||'',r.duration||'',r.note||''].join(',');
      }).join('||');
      return (p.projectName || '') + '|' + (p.shootDate || '') + '|' + (p.rows || []).length + '|' + rowSig;
    }

    // Deduplicate by ID first (keep last occurrence)
    var seenIds = {};
    newProjects = newProjects.filter(function(p){
      if(seenIds[p.id]) return false;
      seenIds[p.id] = true;
      return true;
    });

    // Deduplicate by content signature (keep first occurrence per signature)
    // This removes duplicate projects that have different IDs but identical content
    var seenSigs = {};
    newProjects = newProjects.filter(function(p){
      var s = sig(p);
      if(seenSigs[s]) return false;
      seenSigs[s] = true;
      return true;
    });

    // Build signature map for localOnly matching
    var remoteSigs = {};
    newProjects.forEach(function(p){ remoteSigs[sig(p)] = p.id; });

    // Only preserve truly local-unsaved projects (created locally, never saved to remote)
    // Match by ID first, then by content signature as fallback
    var localOnly = projects.filter(function(lp){
      // Skip if already matched by ID
      if(newProjects.find(function(np){ return np.id === lp.id; })) return false;
      // Skip if matched by content (same project already in remote with different ID)
      var lpSig = sig(lp);
      if(remoteSigs[lpSig]) return false;
      // Only keep if it's a local-unsaved project
      return lp._local && !lp._saved;
    });

    var hadDuplicates = newProjects.length > 0 && window.__vingData
      && Array.isArray(window.__vingData.storyboardProjects)
      && window.__vingData.storyboardProjects.length > (newProjects.length + localOnly.length);

    projects = newProjects.concat(localOnly);

    // Sync cleaned data back to __vingData so future saves write clean data
    if(hadDuplicates && window.__vingData){
      window.__vingData.storyboardProjects = projects.map(function(p){
        return {
          id: p.id,
          projectName: p.projectName || '',
          shootDate: p.shootDate || '',
          rows: (p.rows || []).map(function(r){
            return {shotTask:r.shotTask||'',visual:r.visual||'',script:r.script||'',done:r.done||false};
          }),
          lastUpdated: p.lastUpdated || new Date().toISOString()
        };
      });
      // Trigger background save to clean up remote data
      if(typeof window.__ghSave === 'function'){
        console.log('[Storyboard] Auto-cleaning duplicate projects in remote data');
        window.__ghSave(window.__vingData);
      }
    }

    renderProjectList();
  };

  /* ---------- Init ---------- */
  function init(){
    if(!tableBody && !projectGrid) return;

    // Load projects from __vingData
    if(window.__vingData){
      if(window.__vingData.storyboardProjects && Array.isArray(window.__vingData.storyboardProjects)){
        var rawProjects = window.__vingData.storyboardProjects.map(function(p){
          return {
            id: p.id || genId(),
            projectName: p.projectName || '',
            shootDate: p.shootDate || '',
            rows: Array.isArray(p.rows) ? p.rows.map(function(r){
              return {shotTask:r.shotTask||'',visual:r.visual||'',script:r.script||'',done:r.done||false};
            }) : [],
            lastUpdated: p.lastUpdated || '',
            _local: false,
            _saved: true
          };
        });
        // Deduplicate by content signature on initial load too
        var initSeenIds = {};
        var initSeenSigs = {};
        projects = rawProjects.filter(function(p){
          if(initSeenIds[p.id]) return false;
          initSeenIds[p.id] = true;
          var rowSig = (p.rows||[]).map(function(r){
            return [r.size||'',r.movement||'',r.visual||'',r.audio||'',r.duration||'',r.note||''].join(',');
          }).join('||');
          var s = (p.projectName||'')+'|'+(p.shootDate||'')+'|'+(p.rows||[]).length+'|'+rowSig;
          if(initSeenSigs[s]) return false;
          initSeenSigs[s] = true;
          return true;
        });
      } else if(window.__vingData.storyboard){
        // Migrate old single-project format
        var sb = window.__vingData.storyboard;
        projects = [{
          id: sb.id || genId(),
          projectName: sb.projectName || '',
          shootDate: sb.shootDate || '',
          rows: Array.isArray(sb.rows) ? sb.rows.map(function(r){
            return {shotTask:r.shotTask||'',visual:r.visual||'',script:r.script||'',done:r.done||false};
          }) : [],
          lastUpdated: sb.lastUpdated || '',
          _local: false,
          _saved: true
        }];
      }
    }

    renderProjectList();

    // Bind buttons
    if(sbAddProject) sbAddProject.addEventListener('click', function(){ openEditor(null); });
    if(sbAddRow) sbAddRow.addEventListener('click', addRow);
    if(sbSave) sbSave.addEventListener('click', saveToCloud);
    if(sbBackToList) sbBackToList.addEventListener('click', backToProjectList);
    if(sbDetailBack) sbDetailBack.addEventListener('click', backToProjectList);
    if(sbDetailEdit) sbDetailEdit.addEventListener('click', function(){
      var pid = detailView.getAttribute('data-pid');
      if(pid) openEditor(pid);
    });

    // Batch input shooting shots
    if(sbBatchShots) sbBatchShots.addEventListener('click', function(){
      if(sbBatchDialog) sbBatchDialog.style.display = '';
      if(sbBatchText){
        sbBatchText.focus();
        autoResizeTextarea(sbBatchText);
      }
    });
    if(sbBatchClose) sbBatchClose.addEventListener('click', function(){
      if(sbBatchDialog) sbBatchDialog.style.display = 'none';
    });
    if(sbBatchText) sbBatchText.addEventListener('input', function(){
      autoResizeTextarea(sbBatchText);
    });
    if(sbBatchConfirm) sbBatchConfirm.addEventListener('click', function(){
      var text = sbBatchText ? sbBatchText.value.trim() : '';
      if(text){
        // Split by Chinese period 。 or English period . followed by space/newline
        var shots = text.split(/[。.．]\s*/).filter(function(s){
          return s.trim().length > 0;
        });
        if(shots.length > 0){
          // Keep rows with content
          var existingRows = editRows.filter(function(r){
            return (r.shotTask && r.shotTask.trim()) || (r.visual && r.visual.trim());
          });
          // Add new rows for each shot
          shots.forEach(function(shotText){
            existingRows.push({
              shotTask: shotText.trim(),
              visual: '',
              done: false
            });
          });
          renderAllRows(existingRows);
          markUnsaved();
          // Scroll to last row
          if(tableBody && tableBody.lastElementChild){
            tableBody.lastElementChild.scrollIntoView({behavior:'smooth',block:'center'});
          }
        }
      }
      if(sbBatchDialog) sbBatchDialog.style.display = 'none';
      if(sbBatchText) sbBatchText.value = '';
    });

    // Bind project name input
    if(sbProjectInput){
      sbProjectInput.addEventListener('input', function(){
        if(sbProjectName) sbProjectName.textContent = sbProjectInput.value || t('未命名项目','Untitled Project');
        markUnsaved();
      });
    }
    if(sbDateInput){
      sbDateInput.addEventListener('change', markUnsaved);
    }

    // Warn before leaving if unsaved
    window.addEventListener('beforeunload', function(e){
      if(hasUnsavedChanges){
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-render on language change
  window.addEventListener('ving-lang-changed', function(){
    currentLang = localStorage.getItem('v-ing-lang') || 'zh';
    renderProjectList();
    if(editorView && editorView.style.display !== 'none'){
      // Re-render editor rows with new language
      var rows = [];
      if(tableBody){
        var trs = tableBody.querySelectorAll('tr');
        trs.forEach(function(tr){
          var shotTaskCell = tr.querySelector('[data-field="shotTask"]');
          var sizeSel = tr.querySelector('[data-field="size"]');
          var moveSel = tr.querySelector('[data-field="movement"]');
          var visualCell = tr.querySelector('[data-field="visual"]');
          var audioCell = tr.querySelector('[data-field="audio"]');
          var durInput = tr.querySelector('[data-field="duration"]');
          var noteCell = tr.querySelector('[data-field="note"]');
          rows.push({
            shotTask: shotTaskCell ? shotTaskCell.value : '',
            size: sizeSel ? sizeSel.value : '',
            movement: moveSel ? moveSel.value : '',
            visual: visualCell ? visualCell.value : '',
            audio: audioCell ? audioCell.value : '',
            duration: durInput ? durInput.value : '',
            note: noteCell ? noteCell.value : ''
          });
        });
      }
      renderRows(rows);
    }
  });

})();
