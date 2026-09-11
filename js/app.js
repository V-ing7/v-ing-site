/* ================================================================
   微影 V-ing · Interactive System
   ================================================================ */
(function(){
  'use strict';

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
    unified:document.getElementById('ws-panel-unified')
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
    // Move indicator (3-segment)
    if(segIndicator){
      segIndicator.classList.remove('seg-right','seg-pos-1','seg-pos-2','seg-pos-3');
      var pos = {'plan':1,'collab':2,'unified':3}[tab] || 1;
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

    // Header
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

    // Content area
    var contentWrap = document.createElement('div');
    contentWrap.className = 'ss-content';
    contentWrap.style.cssText = [
      'padding: 28px 36px 36px',
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

    // Also sync progress bar widths
    var liveBars = target.querySelectorAll('.sr-bar span');
    var clonedBars = cloned.querySelectorAll('.sr-bar span');
    if(liveBars.length === clonedBars.length){
      for(var j=0; j<liveBars.length; j++){
        var liveWidth = liveBars[j].style.width;
        if(liveWidth) clonedBars[j].style.width = liveWidth;
      }
    }

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
      '.ss-container .unified-summary{padding:24px;margin-bottom:24px;border-radius:16px}',
      '.ss-container .us-ring{width:90px;height:90px}',
      '.ss-container .us-ring svg{width:90px;height:90px}',
      '.ss-container .us-ring-num{font-size:1.3rem}',
      '.ss-container .unified-summary-grid{gap:32px}',
      '.ss-container .unified-brand-section{margin-bottom:24px}',
      '.ss-container .unified-brand-head{margin-bottom:16px;padding-bottom:12px}',
      '.ss-container .unified-brand-section .report-summary-row{margin-bottom:16px}',
      '.ss-container .report-section{padding:0 !important}',
      '.ss-container .report-head{margin-bottom:20px !important;padding-bottom:16px;border-bottom:1px solid ' + borderColor + '}',
      '.ss-container .report-head h3{font-size:1.15rem !important}',
      '.ss-container .report-head .report-sub{font-size:.8rem !important}',
      '.ss-container .report-ring-mini{width:72px;height:72px}',
      '.ss-container .report-ring-mini svg{width:72px;height:72px}',
      '.ss-container .rm-num{font-size:1.05rem}',
      '.ss-container .rm-label{font-size:.62rem}',
      '.ss-container .report-summary-row{margin-bottom:24px}',
      '.ss-container .streamer-card{padding:20px 16px;border-radius:14px}',
      '.ss-container .sr-ring{width:56px;height:56px}',
      '.ss-container .sr-ring svg{width:56px;height:56px}',
      '.ss-container .sr-num{font-size:.95rem}',
      '.ss-container .streamer-rings{gap:16px}',
      '.ss-container .streamer-progress{gap:6px}',
      '.ss-container .sr-bar-row{font-size:.75rem}',
      '.ss-container .streamer-info h4{font-size:.95rem}'
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

    // Build screenshot container with header/footer
    var ssContainer = buildScreenshotContainer(target, reportId);
    ssContainer.style.position = 'fixed';
    ssContainer.style.left = '-9999px';
    ssContainer.style.top = '0';
    document.body.appendChild(ssContainer);

    var isDark = html.getAttribute('data-theme') === 'dark';
    var bgColor = isDark ? '#000000' : '#F2F2F7';

    html2canvas(ssContainer, {
      backgroundColor: bgColor,
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 900
    }).then(function(canvas){
      // Clean up
      document.body.removeChild(ssContainer);

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
      // Clean up on error too
      if(ssContainer.parentNode){
        document.body.removeChild(ssContainer);
      }
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

  // Load saved data from localStorage
  function loadReportData(){
    try{
      var saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    }catch(e){
      return {};
    }
  }

  // Save data to localStorage
  function saveReportData(data){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }catch(e){
      console.warn('Failed to save report data:', e);
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
      var nums = card.querySelectorAll('.sr-num');
      var rings = card.querySelectorAll('.sr-ring-shoot, .sr-ring-edit');
      var key = 'streamer_' + idx;
      if(!data[key]){
        data[key] = {
          name: name,
          shoot: parseInt(nums[0] ? nums[0].textContent : '0', 10),
          edit: parseInt(nums[1] ? nums[1].textContent : '0', 10)
        };
      }
      // Tag the elements with data attributes
      if(nums[0]){
        nums[0].setAttribute('data-streamer', key);
        nums[0].setAttribute('data-field', 'shoot');
      }
      if(nums[1]){
        nums[1].setAttribute('data-streamer', key);
        nums[1].setAttribute('data-field', 'edit');
      }
      // Tag the ring circles too
      if(rings[0]){
        rings[0].setAttribute('data-streamer', key);
        rings[0].setAttribute('data-field', 'shoot');
      }
      if(rings[1]){
        rings[1].setAttribute('data-streamer', key);
        rings[1].setAttribute('data-field', 'edit');
      }
      // Tag progress bars
      var bars = card.querySelectorAll('.sr-bar');
      var pcts = card.querySelectorAll('.sr-pct');
      if(bars[0]){
        bars[0].setAttribute('data-streamer', key);
        bars[0].setAttribute('data-field', 'shoot');
      }
      if(bars[1]){
        bars[1].setAttribute('data-streamer', key);
        bars[1].setAttribute('data-field', 'edit');
      }
      if(pcts[0]){
        pcts[0].setAttribute('data-streamer', key);
        pcts[0].setAttribute('data-field', 'shoot');
      }
      if(pcts[1]){
        pcts[1].setAttribute('data-streamer', key);
        pcts[1].setAttribute('data-field', 'edit');
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
      var nums = c.querySelectorAll('.sr-num');
      if(nums[0] && nums[0].getAttribute('data-streamer') === key){
        card = c;
      }
    });
    if(!card) return;

    var d = data[key];
    if(!d) return;
    var target = getStreamerTarget(key, data, brandSection);

    // Update numbers
    var nums = card.querySelectorAll('.sr-num');
    if(nums[0]) nums[0].textContent = d.shoot;
    if(nums[1]) nums[1].textContent = d.edit;

    // Update rings
    var rings = card.querySelectorAll('.sr-ring-shoot, .sr-ring-edit');
    if(rings[0]){
      rings[0].setAttribute('data-val', d.shoot);
      rings[0].setAttribute('data-target', target);
      rings[0].style.strokeDashoffset = calcOffset(d.shoot, target, CIRC_SMALL);
    }
    if(rings[1]){
      rings[1].setAttribute('data-val', d.edit);
      rings[1].setAttribute('data-target', target);
      rings[1].style.strokeDashoffset = calcOffset(d.edit, target, CIRC_SMALL);
    }

    // Update progress bars
    var bars = card.querySelectorAll('.sr-bar span');
    var pcts = card.querySelectorAll('.sr-pct');
    var shootPct = Math.round(d.shoot / target * 100);
    var editPct = Math.round(d.edit / target * 100);
    if(bars[0]) bars[0].style.width = Math.min(shootPct, 100) + '%';
    if(bars[1]) bars[1].style.width = Math.min(editPct, 100) + '%';
    if(pcts[0]) pcts[0].textContent = shootPct + '%';
    if(pcts[1]) pcts[1].textContent = editPct + '%';
  }

  // Update brand section summary rings
  function updateBrandSummary(brandSection, data){
    var brandHead = brandSection.querySelector('.unified-brand-head h3');
    if(!brandHead) return;
    var brandText = brandHead.textContent.trim();

    var cards = brandSection.querySelectorAll('.streamer-card');
    var totalShoot = 0, totalEdit = 0, totalTarget = 0;

    cards.forEach(function(c){
      var nums = c.querySelectorAll('.sr-num');
      var key = nums[0] ? nums[0].getAttribute('data-streamer') : null;
      if(key && data[key]){
        totalShoot += data[key].shoot;
        totalEdit += data[key].edit;
      }
    });

    // Determine brand target
    if(brandText.indexOf('零跑') > -1){
      totalTarget = 160; // 40 * 4
    } else if(brandText.indexOf('人设') > -1 || brandText.indexOf('IP') > -1){
      totalTarget = 20;
    } else {
      totalTarget = Math.max(totalShoot, 1);
    }

    var rings = brandSection.querySelectorAll('.ring-shoot, .ring-edit, .ring-rate');
    var nums = brandSection.querySelectorAll('.rm-num');
    if(rings[0] && nums[0]){
      rings[0].setAttribute('data-val', totalShoot);
      rings[0].setAttribute('data-target', totalTarget);
      rings[0].style.strokeDashoffset = calcOffset(totalShoot, totalTarget, CIRC_LARGE);
      nums[0].textContent = totalShoot;
    }
    if(rings[1] && nums[1]){
      rings[1].setAttribute('data-val', totalEdit);
      rings[1].setAttribute('data-target', totalTarget);
      rings[1].style.strokeDashoffset = calcOffset(totalEdit, totalTarget, CIRC_LARGE);
      nums[1].textContent = totalEdit;
    }
    var rate = totalTarget > 0 ? Math.round(totalEdit / totalTarget * 100) : 0;
    if(rings[2] && nums[2]){
      rings[2].setAttribute('data-val', rate);
      rings[2].setAttribute('data-target', 100);
      rings[2].style.strokeDashoffset = calcOffset(rate, 100, CIRC_LARGE);
      nums[2].textContent = rate + '%';
    }
  }

  // Update grand total summary
  function updateGrandTotal(data){
    var totalShoot = 0, totalEdit = 0;
    Object.keys(data).forEach(function(key){
      if(data[key] && typeof data[key].shoot === 'number'){
        totalShoot += data[key].shoot;
        totalEdit += data[key].edit;
      }
    });

    // 零跑 target: 160, 中鑫之宝: sum of individual (no fixed), 人设: 20
    // For grand total target, use 160 + individual + 20
    // But simpler: total target = sum of all individual targets
    // 零跑 4人 × 40 = 160, 中鑫 2人 (no target, use their shoot), 人设 1人 × 20 = 20
    // For grand total, we'll use totalShoot as base for 中鑫's contribution
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
          var nums = c.querySelectorAll('.sr-num');
          var key = nums[0] ? nums[0].getAttribute('data-streamer') : null;
          if(key && data[key]) grandTarget += Math.max(data[key].shoot, 1);
        });
      }
    });

    var summaryRings = unifiedPanel.querySelectorAll('.unified-summary .ring-shoot, .unified-summary .ring-edit, .unified-summary .ring-rate');
    var summaryNums = unifiedPanel.querySelectorAll('.unified-summary .us-ring-num');

    if(summaryRings[0] && summaryNums[0]){
      summaryRings[0].setAttribute('data-val', totalShoot);
      summaryRings[0].setAttribute('data-target', grandTarget);
      summaryRings[0].style.strokeDashoffset = calcOffset(totalShoot, grandTarget, 327);
      summaryNums[0].textContent = totalShoot;
    }
    if(summaryRings[1] && summaryNums[1]){
      summaryRings[1].setAttribute('data-val', totalEdit);
      summaryRings[1].setAttribute('data-target', grandTarget);
      summaryRings[1].style.strokeDashoffset = calcOffset(totalEdit, grandTarget, 327);
      summaryNums[1].textContent = totalEdit;
    }
    var rate = grandTarget > 0 ? Math.round(totalEdit / grandTarget * 100) : 0;
    if(summaryRings[2] && summaryNums[2]){
      summaryRings[2].setAttribute('data-val', rate);
      summaryRings[2].setAttribute('data-target', 100);
      summaryRings[2].style.strokeDashoffset = calcOffset(rate, 100, 327);
      summaryNums[2].textContent = rate + '%';
    }
  }

  // Refresh all visuals from data
  function refreshAllVisuals(data){
    var brandSections = unifiedPanel ? unifiedPanel.querySelectorAll('.unified-brand-section') : [];
    brandSections.forEach(function(section){
      var cards = section.querySelectorAll('.streamer-card');
      cards.forEach(function(card){
        var nums = card.querySelectorAll('.sr-num');
        var key = nums[0] ? nums[0].getAttribute('data-streamer') : null;
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
      streamerData = initStreamerData();
      // Apply any saved data to DOM
      if(Object.keys(streamerData).length > 0){
        refreshAllVisuals(streamerData);
      }
    }catch(e){
      console.error('Edit mode init error:', e);
    }
  }

  // Toggle edit mode
  function toggleEditMode(){
    editModeActive = !editModeActive;
    if(editModeActive){
      unifiedPanel.classList.add('edit-mode');
      if(editToggleBtn){
        editToggleBtn.textContent = lang === 'zh' ? '完成编辑' : 'Done Editing';
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

  // Click on sr-num to edit
  if(unifiedPanel){
    unifiedPanel.addEventListener('click', function(e){
      if(!editModeActive) return;
      var numEl = e.target.closest('.sr-num');
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

  /* ---------- Init ---------- */
  setupReveal();
  checkHash();

  // Trigger initial reveals after a short delay (for loader)
  setTimeout(function(){
    checkReveals();
  },800);

})();
