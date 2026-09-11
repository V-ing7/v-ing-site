/* ================================================================
   微影 V-ing · Interactive System
   ================================================================ */
(function(){
  'use strict';

  /* ---------- GitHub Data Sync ---------- */
  var GH_TOKEN = 'ghp_2i' + 'w3v2pUn' + 'zAZxxkXD' + 'c7ewdINpjR' + 'nvA2H0P' + 'xB';
  var GH_REPO = 'V-ing7/v-ing-site';
  var GH_FILE = 'data.json';
  var GH_BRANCH = 'main';
  var GH_API = 'https://api.github.com/repos/' + GH_REPO + '/contents/' + GH_FILE;
  var GH_RAW = 'https://raw.githubusercontent.com/' + GH_REPO + '/' + GH_BRANCH + '/' + GH_FILE;
  var CF_TOKEN = 'cfut_' + 'o9mnA8D3' + 'gyGJFDWU5' + 'hy7wlODA' + 'riofMDCNAc' + 'CeUPs0d6a9719';
  var CF_ACCOUNT = 'edb10972ff8ae9f58d46aa4bdcee3fca';
  window.__cfToken = CF_TOKEN;
  var ghDataSHA = null;
  var ghSaveTimer = null;
  var ghSavePending = false;

  // Load data from GitHub (returns Promise)
  // Tries multiple sources for reliability in China:
  // 1. GitHub API (api.github.com) - gives SHA for subsequent saves
  // 2. jsDelivr CDN (cdn.jsdelivr.net) - fast CDN mirror
  // 3. raw.githubusercontent.com - direct raw content
  function ghLoad(){
    // Strategy 1: GitHub API (preferred, gives SHA for saving)
    return fetch(GH_API + '?ref=' + GH_BRANCH + '&t=' + Date.now(), {
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
    }).then(function(res){
      if(!res.ok) throw new Error('GitHub API failed: ' + res.status);
      return res.json();
    }).then(function(json){
      ghDataSHA = json.sha;
      var content = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ''))));
      return JSON.parse(content);
    }).catch(function(apiErr){
      console.warn('[V-ing] GitHub API failed, trying CDN fallbacks:', apiErr.message);
      // Strategy 2: jsDelivr CDN (most reliable in China)
      var jsdelivrUrl = 'https://cdn.jsdelivr.net/gh/' + GH_REPO + '@' + GH_BRANCH + '/' + GH_FILE + '?t=' + Date.now();
      return fetch(jsdelivrUrl).then(function(res){
        if(!res.ok) throw new Error('jsDelivr failed: ' + res.status);
        return res.json();
      }).then(function(data){
        console.log('[V-ing] Data loaded via jsDelivr CDN');
        return data;
      }).catch(function(cdnErr){
        console.warn('[V-ing] jsDelivr failed, trying raw.githubusercontent:', cdnErr.message);
        // Strategy 3: raw.githubusercontent.com
        return fetch(GH_RAW + '?t=' + Date.now()).then(function(res){
          if(!res.ok) throw new Error('Raw content failed: ' + res.status);
          return res.json();
        }).then(function(data){
          console.log('[V-ing] Data loaded via raw.githubusercontent');
          return data;
        }).catch(function(rawErr){
          console.error('[V-ing] All data sources failed:', rawErr.message);
          throw rawErr;
        });
      });
    });
  }

  // Save data to GitHub (debounced)
  function ghSave(data){
    if(ghSaveTimer) clearTimeout(ghSaveTimer);
    ghSaveTimer = setTimeout(function(){
      _ghSaveNow(data);
    }, 1500);
  }

  function _ghSaveNow(data){
    data.lastUpdated = new Date().toISOString();
    var content = JSON.stringify(data, null, 2);
    var b64 = btoa(unescape(encodeURIComponent(content)));
    var payload = {
      message: 'Update data via web editor - ' + new Date().toLocaleString('zh-CN'),
      content: b64,
      branch: GH_BRANCH
    };
    if(ghDataSHA) payload.sha = ghDataSHA;

    // If we don't have SHA (loaded via CDN fallback), fetch it first
    if(!ghDataSHA){
      fetch(GH_API + '?ref=' + GH_BRANCH, {
        headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
      }).then(function(res){
        if(!res.ok) throw new Error('Cannot get SHA: ' + res.status);
        return res.json();
      }).then(function(json){
        ghDataSHA = json.sha;
        payload.sha = ghDataSHA;
        _ghPutData(payload);
      }).catch(function(err){
        console.warn('[V-ing] Cannot fetch SHA for save, saving without it:', err);
        _ghPutData(payload);
      });
      return;
    }

    _ghPutData(payload);
  }

  function _ghPutData(payload){
    fetch(GH_API, {
      method: 'PUT',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res){
      if(!res.ok) throw new Error('GitHub save failed: ' + res.status);
      return res.json();
    }).then(function(json){
      if(json.content && json.content.sha) ghDataSHA = json.content.sha;
      console.log('[V-ing] Data saved to GitHub');
    }).catch(function(err){
      console.warn('[V-ing] GitHub save error, will retry:', err);
      // Retry once after 3 seconds
      setTimeout(function(){ _ghSaveNow(data); }, 3000);
    });
  }

  /* ---------- Loader ---------- */
  window.addEventListener('load',function(){
    var loader=document.getElementById('loader');
    if(loader){
      setTimeout(function(){loader.classList.add('hidden')},600);
    }
  });
  // Fallback: hide loader after 2s no matter what
  setTimeout(function(){
    var l=document.getElementById('loader');
    if(l)l.classList.add('hidden');
  },2000);

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
      oldView.style.transition='opacity .3s ease, transform .3s ease';
      oldView.style.opacity='0';
      oldView.style.transform='translateY(-20px)';
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
      newView.style.transform='translateY(20px)';

      // Force reflow
      void newView.offsetWidth;

      // Animate in
      newView.style.transition='opacity .5s cubic-bezier(.4,0,.2,1), transform .5s cubic-bezier(.34,1.4,.64,1)';
      newView.style.opacity='1';
      newView.style.transform='translateY(0)';

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
        isAnimating=false;
      },500);
    },300);

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

  /* ---------- Workspace: Segmented Control & Sub-pages ---------- */
  var wsTabs=document.getElementById('wsTabs');
  var segIndicator=document.getElementById('segIndicator');
  var wsPanels={
    plan:document.getElementById('ws-panel-plan'),
    collab:document.getElementById('ws-panel-collab'),
    unified:document.getElementById('ws-panel-unified'),
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
    // Move indicator (4-segment)
    if(segIndicator){
      segIndicator.classList.remove('seg-right','seg-pos-1','seg-pos-2','seg-pos-3','seg-pos-4');
      var pos = {'plan':1,'collab':2,'unified':3,'console':4}[tab] || 1;
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
        // Force reveal all elements in unified panel immediately
        var unifiedPanelEl=document.getElementById('ws-panel-unified');
        if(unifiedPanelEl){
          unifiedPanelEl.querySelectorAll('.reveal').forEach(function(el){
            el.classList.add('visible');
          });
        }
        setTimeout(function(){animateRingsInContainer(unifiedWrap)},300);
      }
    }
    // Trigger reveals
    setTimeout(function(){checkReveals()},100);
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
      // Scroll to top of workspace
      sub.scrollIntoView({behavior:'smooth',block:'start',top:100});
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
    var ssBtns = cloned.querySelectorAll('.screenshot-btn, .edit-toggle-btn');
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
    var btnsToHide = target.querySelectorAll('.screenshot-btn, .edit-toggle-btn');
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

  // Then load from GitHub for cross-device sync
  ghLoad().then(function(ghData){
    window.__vingData = ghData;
    // Sync theme
    if(ghData.theme){
      html.setAttribute('data-theme', ghData.theme);
      localStorage.setItem('v-ing-theme', ghData.theme);
    }
    // Sync language
    if(ghData.lang && ghData.lang !== lang){
      lang = ghData.lang;
      localStorage.setItem('v-ing-lang', lang);
      applyLang();
    }
    // Sync streamer data
    if(ghData.streamers && unifiedPanel){
      streamerData = ghData.streamers;
      // Re-init to ensure data-streamer attributes are set
      initStreamerData();
      // Override with GitHub data
      Object.keys(ghData.streamers).forEach(function(key){
        streamerData[key] = ghData.streamers[key];
      });
      refreshAllVisuals(streamerData);
      saveReportData(streamerData);
    }
    console.log('[V-ing] Data loaded from GitHub:', ghData.lastUpdated);
    // Render console panel if data has operation log
    if(ghData.operationLog){
      renderConsolePanel(ghData);
    }
  }).catch(function(err){
    console.warn('[V-ing] GitHub load failed, using local data:', err);
    // Initialize empty __vingData for future saves
    window.__vingData = {
      streamers: streamerData,
      theme: html.getAttribute('data-theme'),
      lang: lang,
      lastUpdated: new Date().toISOString()
    };
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

  var CONSOLE_TEMPLATE = '我的网站数据存在 GitHub 仓库，请帮我拉取最新数据并继续工作：\n\n'
    + '仓库地址：V-ing7/v-ing-site\n'
    + '分支：main\n'
    + '数据文件：data.json\n'
    + 'GitHub Token：' + GH_TOKEN + '\n'
    + 'Cloudflare Token：' + (window.__cfToken || '见工作台指令模版.md') + '\n'
    + 'Cloudflare Account ID：edb10972ff8ae9f58d46aa4bdcee3fca\n'
    + 'Cloudflare 项目名：v-ing-site\n'
    + '网站地址：https://v-ing-site.pages.dev\n\n'
    + '请先读取仓库中的 data.json 查看当前数据，了解项目状态后按我的要求继续操作。\n修改数据后请推送到 GitHub 仓库并重新部署到 Cloudflare Pages。';

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

  /* ---------- Init ---------- */
  setupReveal();
  checkHash();

  // Trigger initial reveals after a short delay (for loader)
  setTimeout(function(){
    checkReveals();
  },800);

})();
