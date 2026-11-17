/* 瞅瞅附近有啥 —— 路痴友好版（纯静态 / 免 key / 任意平台可发布）
   附近 POI：腾讯地图官方「周边搜索 URI API」结果页（iframe，结果页本身按距离列出店名与距离）。
   导航：工作台在「顶层窗口」发起腾讯「路线规划 URI API」，页面载入即静默预热定位，链接带起点坐标。
   收藏：五角星 → 店名 / 什么好吃好喝；位置由手机定位自动记下（跨域读不到腾讯结果页里的店名，不编造）。
   打车：四选一面板。高德/滴滴为已实测可打开的官方网页版；哈啰/腾讯出行服务只有小程序，给名称与微信内路径。
   合规：地图只用腾讯（GCJ-02），页面不内置、不索要任何 key；不收集、不上传他人位置。 */
(function () {
  'use strict';

  /* ---------------- 广告位（默认关闭）---------------- */
  const ADS = { enabled: false, topHtml: '', bottomHtml: '' };
  function mountAds() {
    if (!ADS.enabled) return;
    const t = document.getElementById('adTop'), b = document.getElementById('adBottom');
    if (t && ADS.topHtml) { t.innerHTML = ADS.topHtml; t.hidden = false; }
    if (b && ADS.bottomHtml) { b.innerHTML = ADS.bottomHtml; b.hidden = false; }
  }

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const COLORS = {
    '奶茶': '#F08CB4', '咖啡': '#B08A6A', '美食': '#FFA45B', '甜品': '#E88FB0',
    '便利店': '#68C79A', '超市': '#6FB6F0', '公园': '#68C79A', '其他': '#F08CB4',
  };
  const colorOf = cat => COLORS[cat] || COLORS['其他'];
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cc_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cc_' + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem('cc_' + k); } catch (e) {} },
  };

  const SEARCH_URI = 'https://apis.map.qq.com/uri/v1/search';
  const ROUTE_URI = 'https://apis.map.qq.com/uri/v1/routeplan';
  const REFERER = 'chouchou';        // 应用名标识，不是 key
  const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/;
  const CENTER_TTL = 30 * 60 * 1000; // 定位 30 分钟过期，旅游换城市不会用旧坐标

  /* 打车入口：前两个是实测 200 的官方网页版；后两个只有小程序，不编造 H5 链接 */
  const TAXI = {
    amap: { label: '高德打车', url: 'https://m.amap.com/taxi' },
    didi: { label: '滴滴打车', url: 'https://common.diditaxi.com.cn/general/webEntry' },
    hello: { label: '哈啰打车', url: 'https://hellobike.com/', copy: '哈啰打车' },
    tencent: { label: '腾讯出行服务', url: '', copy: '腾讯出行服务' },
  };
  /* 换个词再找：都是真实搜索关键词，不是编造的店名清单 */
  const RELATED = {
    '奶茶': ['奶茶店', '茶饮', '果茶', '咖啡'],
    '公园': ['公园', '广场', '景区', '休息区'],
    '咖啡': ['咖啡馆', '茶座', '书店', '甜品'],
    '公共厕所': ['公共厕所', '洗手间', '公厕'],
    '便利店': ['便利店', '小卖部', '超市'],
    '美食': ['小吃', '面馆', '快餐', '餐馆'],
    '地铁站': ['地铁站', '地铁口', '公交站'],
    '超市': ['超市', '便利店', '菜市场'],
    '高铁站': ['高铁站', '火车站', '客运站'],
  };

  let center = store.get('center', null);
  if (center && (!center.ts || Date.now() - center.ts > CENTER_TTL)) { center = null; store.del('center'); }
  let view = 'map';
  let currentUri = '';
  let currentKw = store.get('kw', '奶茶');
  let editingId = null;
  let favCoord = null;

  /* ---------------- 收藏数据（兼容旧版「记一家店」）---------------- */
  function loadFavs() {
    const fav = store.get('fav', []);
    const old = store.get('manual', []);
    const out = fav.slice();
    old.forEach(o => {
      if (!out.some(x => x.id === o.id)) out.push({
        id: o.id, name: o.name || '未命名', cat: COLORS[o.cat] ? o.cat : '其他',
        reco: '', address: o.address || '', loc: null, again: true,
        ts: o.ts || Date.now(), photo: '',
      });
    });
    return out;
  }
  function saveFavs() { store.set('fav', rows); }
  let rows = loadFavs();

  /* ---------------- 坐标 ---------------- */
  const PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;
  function outOfChina(lat, lng) { return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55); }
  function tLat(x, y) {
    let r = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
    r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
    return r;
  }
  function tLng(x, y) {
    let r = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
    r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
    r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
    r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
    return r;
  }
  function wgs2gcj(lat, lng) {
    if (outOfChina(lat, lng)) return { lat, lng };
    let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
    const rad = lat / 180 * PI, magic = 1 - EE * Math.sin(rad) * Math.sin(rad), sq = Math.sqrt(magic);
    dLat = dLat * 180 / ((AXIS * (1 - EE)) / (magic * sq) * PI);
    dLng = dLng * 180 / (AXIS / sq * Math.cos(rad) * PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  function status(msg, type) {
    const s = $('#status');
    s.hidden = false;
    s.className = 'status ' + (type || 'info');
    s.innerHTML = msg;
  }

  /* ---------------- 免 key 周边搜索 ---------------- */
  function validCenter() {
    if (!center || !center.ts || Date.now() - center.ts > CENTER_TTL) return null;
    return center;
  }
  function buildSearch(kw, radius, addr) {
    const p = new URLSearchParams();
    p.set('keyword', kw);
    p.set('referer', REFERER);
    const cm = (addr || '').match(COORD_RE);
    if (cm) {
      const lat = +cm[1], lng = +cm[2];
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) setCenter({ lat, lng }, addr);
    }
    const c = validCenter();
    if (c && (!addr || addr === c.label || addr === '我的当前位置')) {
      p.set('center', c.lat.toFixed(6) + ',' + c.lng.toFixed(6));
      p.set('radius', String(radius));
      return { uri: SEARCH_URI + '?' + p.toString(), desc: '以你的定位为中心 · 半径 ' + radius + ' 米' };
    }
    if (addr) {
      p.set('region', addr);
      return { uri: SEARCH_URI + '?' + p.toString(), desc: '在「' + addr + '」范围内找' };
    }
    p.set('center', 'CurrentLocation');
    p.set('radius', String(radius));
    return { uri: SEARCH_URI + '?' + p.toString(), desc: '手机自动定位 · 半径 ' + radius + ' 米' };
  }
  function loadFrame(uri) {
    const f = $('#qqFrame');
    if (!f) return;
    f.src = 'about:blank';
    setTimeout(() => { f.src = uri; }, 30);
  }
  function refreshGoBtn() {
    const b = $('#btnGoMap');
    if (!b) return;
    const t = ($('#dest').value || '').trim() || currentKw;
    b.textContent = '🧭 去最近的「' + t + '」· 点一下直接导航';
  }
  function renderNearby(kw, radius) {
    $('#nearbyTitle').textContent = '附近还有哪些「' + kw + '」';
    $('#nearbyDesc').textContent =
      '下面这张腾讯地图结果页，就是按距离从近到远排好的附近「' + kw + '」清单（店名、距离都在结果页里）。点「在新窗口打开 ↗」可看完整清单，并直接点任一家的「去这里」。';
    $('#radiusChips').innerHTML = '<span class="t">换范围：</span>' +
      [1000, 2000, 3000, 5000].map(r =>
        '<span class="chip' + (r === radius ? ' on' : '') + '" data-r="' + r + '">' + (r / 1000) + ' 公里内</span>').join('');
    const rel = RELATED[kw] || [];
    $('#relatedChips').innerHTML = rel.length
      ? '<span class="t">换个词再找：</span>' + rel.map(k => '<span class="chip" data-k="' + esc(k) + '">' + esc(k) + '</span>').join('')
      : '';
  }
  function search(kwOverride, radiusOverride, keepView, scroll) {
    const addr = $('#addr').value.trim();
    const kw = (kwOverride || currentKw || '奶茶').trim();
    const radius = radiusOverride || +$('#radius').value || 3000;
    currentKw = kw;
    $('#radius').value = String(radius);
    store.set('kw', kw); store.set('radius', radius);
    const q = buildSearch(kw, radius, addr);
    currentUri = q.uri;
    loadFrame(q.uri);
    if (!keepView) setView('map');
    $('#frameMeta').innerHTML = '「<b>' + esc(kw) + '</b>」· ' + esc(q.desc);
    refreshGoBtn();
    renderNearby(kw, radius);
    if (scroll) {
      try { $('#viewMap').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    }
    return q;
  }
  function searchFromBar() {
    const kw = ($('#q').value || '').trim();
    if (!kw) { $('#q').focus(); return; }
    $$('.scene[data-kw]').forEach(x => x.classList.remove('on'));
    $('#dest').value = kw;
    $('#bikeBar').hidden = true;
    search(kw, null, false, true);
  }
  function selectKeyword(kw) {
    $$('.scene[data-kw]').forEach(x => x.classList.remove('on'));
    $('#q').value = kw;
    $('#dest').value = kw;
    $('#bikeBar').hidden = true;
    search(kw, null, false, true);
  }
  function openNew() {
    if (!currentUri) return;
    const a = document.createElement('a');
    a.href = currentUri; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------------- 定位（静默预热，不打扰、不阻塞）---------------- */
  function setCenter(c, label) {
    center = { lat: c.lat, lng: c.lng, label: label || '', ts: Date.now() };
    store.set('center', center);
  }
  function silentGeo(cb) {
    if (!navigator.geolocation) { cb(null); return; }
    let done = false;
    const finish = g => { if (done) return; done = true; cb(g); };
    try {
      navigator.geolocation.getCurrentPosition(
        pos => { const g = wgs2gcj(pos.coords.latitude, pos.coords.longitude); finish(g.lat.toFixed(6) + ',' + g.lng.toFixed(6)); },
        () => finish(null),
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
      );
    } catch (e) { finish(null); }
    setTimeout(() => finish(null), 6800);
  }
  function locate() {
    if (!navigator.geolocation) { status('这个浏览器不给定位，留空也能用。', 'warn'); return; }
    status('正在定位…（只在本机用，不上传）', 'info');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const g = wgs2gcj(pos.coords.latitude, pos.coords.longitude);
        setCenter(g, '我的当前位置');
        $('#addr').value = '我的当前位置';
        search();
        status('定位成功，已按你的位置重新排好。', 'ok');
      },
      () => status('定位没拿到，留空也能用。', 'warn'),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  /* ---------------- 直接导航（顶层窗口，起点自动；收藏可带终点坐标）---------------- */
  function getDest() { return ($('#dest').value || '').trim() || currentKw; }
  function routeUrl(type, dest, fromcoord, tocoord) {
    const p = new URLSearchParams();
    p.set('type', type);
    if (fromcoord) { p.set('from', '我的位置'); p.set('fromcoord', fromcoord); }
    p.set('to', dest);
    if (tocoord) p.set('tocoord', tocoord);
    p.set('referer', REFERER);
    return ROUTE_URI + '?' + p.toString();
  }
  function goRoute(type, destOverride, tocoord) {
    const dest = (destOverride || getDest()).trim();
    if (!dest) return;
    const c = validCenter();
    const from = c ? c.lat.toFixed(6) + ',' + c.lng.toFixed(6) : null;
    const url = routeUrl(type, dest, from, tocoord || null);
    const win = window.open(url, '_blank', 'noopener');
    if (!win) location.href = url;
  }
  function goBike() {
    $('#bikeBar').hidden = false;
    if (validCenter()) { search('共享单车', 1000); return; }
    silentGeo(g => {
      if (g) { const a = g.split(','); setCenter({ lat: +a[0], lng: +a[1] }, '我的当前位置'); }
      search('共享单车', 1000);
    });
  }

  /* ---------------- 打车：四选一 ---------------- */
  function openTop(url) {
    const win = window.open(url, '_blank', 'noopener');
    if (!win) location.href = url;
  }
  function copyText(t) {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(t);
      else {
        const ta = document.createElement('textarea');
        ta.value = t; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
    } catch (e) {}
  }
  function openTaxi(destOverride) {
    const dest = (destOverride || getDest()).trim() || '附近';
    $('#taxiDest').textContent = dest;
    $('#taxiHint').textContent = '已把「' + dest + '」复制好，打开后粘到「终点」就行。';
    copyText(dest);
    $('#taxiModal').hidden = false;
  }
  function closeTaxi() { $('#taxiModal').hidden = true; }
  function chooseTaxi(key) {
    const t = TAXI[key];
    if (!t) return;
    const dest = $('#taxiDest').textContent;
    if (t.url) openTop(t.url);
    if (t.copy) {
      // 既有官网又有小程序名时，两件都做：打开官网 + 复制小程序名
      copyText(t.copy);
      $('#taxiHint').textContent = '已复制「' + t.copy + '」' + (t.url ? '，并打开官网' : '') +
        '。微信搜索框粘贴搜小程序，或走 我 → 服务 → 出行服务；终点填「' + dest + '」。';
    } else {
      $('#taxiHint').textContent = '已打开' + t.label + '；目的地「' + dest + '」已复制，粘到终点即可。';
    }
  }

  /* ---------------- 视图 ---------------- */
  function setView(v) {
    view = v;
    $$('.tab[data-v]').forEach(t => t.classList.toggle('active', t.dataset.v === v));
    $('#layoutCards').hidden = v !== 'cards';
    $('#viewMap').hidden = v !== 'map';
  }

  /* ---------------- 五角星收藏 ---------------- */
  function guessCat(kw) {
    const m = { '奶茶': '奶茶', '咖啡': '咖啡', '美食': '美食', '公园': '公园', '便利店': '便利店' };
    return m[kw] || '其他';
  }
  function pickCat(v) {
    const sel = $('#fCat');
    sel.value = $$('#fCat option').some(o => o.value === v) ? v : '其他';
  }
  function showFavGeo(c) {
    const el = $('#favGeo');
    if (c) {
      favCoord = { lat: c.lat, lng: c.lng };
      el.className = 'geoline';
      el.textContent = '📍 已自动记下当前位置：' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5);
    } else {
      favCoord = null;
      el.className = 'geoline warn';
      el.textContent = '📍 暂时没拿到定位，可以先收藏，之后再补位置备注';
    }
  }
  function openFav(id) {
    editingId = id || null;
    const r = id ? rows.find(x => x.id === id) : null;
    $('#favTitle').textContent = r ? '✏️ 编辑这家店' : '⭐ 记下这家好吃的';
    $('#favSave').textContent = r ? '保存修改' : '⭐ 收藏';
    $('#fName').value = r ? r.name : '';
    $('#fReco').value = r ? (r.reco || '') : '';
    $('#fAddr').value = r ? (r.address || '') : '';
    pickCat(r ? (r.cat || '其他') : guessCat(currentKw));
    $('#fAgain').checked = r ? !!r.again : true;
    showFavGeo(validCenter());
    if (!validCenter()) {
      silentGeo(g => {
        if (!g) return;
        const a = g.split(',');
        setCenter({ lat: +a[0], lng: +a[1] }, '我的当前位置');
        showFavGeo(validCenter());
      });
    }
    $('#favModal').hidden = false;
    setTimeout(() => { if (!r) $('#fName').focus(); }, 60);
  }
  function closeFav() { $('#favModal').hidden = true; editingId = null; }
  function saveFav() {
    const name = $('#fName').value.trim();
    if (!name) { $('#fName').focus(); return; }
    const c = validCenter();
    const loc = c ? { lat: c.lat, lng: c.lng } : favCoord;
    const fields = {
      name, reco: $('#fReco').value.trim(), address: $('#fAddr').value.trim(),
      cat: $('#fCat').value || '其他', again: $('#fAgain').checked,
    };
    if (editingId) {
      const r = rows.find(x => x.id === editingId);
      if (r) { Object.assign(r, fields); if (loc && !r.loc) r.loc = loc; }
    } else {
      rows.unshift(Object.assign({ id: 'fav_' + uid(), ts: Date.now(), loc, photo: '' }, fields));
    }
    saveFavs();
    renderAll();
    closeFav();
    setView('cards');
  }

  /* ---------------- 渲染 ---------------- */
  function photoData(id) { return store.get('photo_' + id, ''); }
  function renderAll() {
    renderCards();
    $('#count').textContent = rows.length ? '已收藏 ' + rows.length + ' 家' : '实时结果在地图里';
  }
  function renderCards() {
    const box = $('#cards');
    const q = ($('#favSearch').value || '').trim().toLowerCase();
    if (!rows.length) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1"><b>⭐</b>还没收藏任何店。<br>在地图上看到想记的，点右下角五角星。</div>';
      return;
    }
    const list = rows.filter(r => !q || [r.name, r.reco, r.address, r.cat].some(x => String(x || '').toLowerCase().includes(q)));
    if (!list.length) {
      box.innerHTML = '<div class="empty" style="grid-column:1/-1"><b>✿</b>没找到，换个词试试。</div>';
      return;
    }
    box.innerHTML = list.map(r => {
      const id = esc(r.id), src = photoData(r.id) || r.photo;
      const where = r.address || (r.loc ? '已记下当时的定位坐标' : '位置未记下');
      const when = r.ts ? new Date(r.ts).toLocaleDateString('zh-CN') : '早先记的';
      const col = colorOf(r.cat);
      return '<article class="pcard">' +
        '<div class="photo">' +
          (src ? '<img src="' + esc(src) + '" alt="' + esc(r.name) + ' 门店图" referrerpolicy="no-referrer">'
               : '<div class="ph"><b>▧</b>还没补图<br>可以自己加一张实拍</div>') +
          '<div class="dist" style="color:' + col + '">' + (r.again ? '⭐ 想再去' : '已收藏') + '</div>' +
          '<label class="up">' + (src ? '换张图' : '补张图') + '<input type="file" accept="image/*" data-photo="' + id + '"></label>' +
        '</div>' +
        '<div class="pbody">' +
          '<div class="pname">⭐ ' + esc(r.name) + '</div>' +
          '<span class="ptag" style="background:' + col + '22;color:' + col + '">' + esc(r.cat || '其他') + ' · ' + esc(when) + '</span>' +
          (r.reco ? '<div class="reco"><b>好吃 / 好喝：</b>' + esc(r.reco) + '</div>'
                  : '<div class="reco empty">还没写什么好吃，点「改推荐」补一句</div>') +
          '<div class="pmeta">📍 ' + esc(where) + '</div>' +
          '<div class="pops">' +
            '<button class="btn sm" data-favgo="' + id + '">🚶 去这里</button>' +
            '<button class="btn sm" data-favtaxi="' + id + '">🚗 打车去</button>' +
            '<button class="btn sm" data-favedit="' + id + '">✏️ 改推荐</button>' +
            (r.address ? '<button class="btn sm" data-copy="' + esc(r.address) + '">复制地址</button>' : '') +
            '<button class="btn sm" data-favdel="' + id + '">移除</button>' +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  /* ---------------- 图片 ---------------- */
  function savePhoto(id, file) {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        const r = Math.min(1, 480 / Math.max(im.width, im.height));
        c.width = Math.round(im.width * r); c.height = Math.round(im.height * r);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        try { store.set('photo_' + id, c.toDataURL('image/jpeg', .72)); renderCards(); }
        catch (e) { alert('图片存不下，换张小一点的'); }
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $('#btnLocate').onclick = locate;
    $('#btnSearch').onclick = searchFromBar;
    $('#btnQ').onclick = searchFromBar;
    $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') searchFromBar(); });
    $('#btnReload').onclick = () => search();
    $('#btnOpenNew').onclick = openNew;
    $('#addr').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    $('#dest').addEventListener('input', refreshGoBtn);

    $$('.scene[data-kw]').forEach(b => b.onclick = () => {
      $$('.scene[data-kw]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('#q').value = '';
      $('#dest').value = b.dataset.kw;
      $('#bikeBar').hidden = true;
      search(b.dataset.kw, null, false, true);
    });
    $$('.chip[data-k]').forEach(c => c.onclick = () => selectKeyword(c.dataset.k));
    $('#nearbyPanel').addEventListener('click', e => {
      const r = e.target.closest('[data-r]');
      if (r) { search(currentKw, +r.dataset.r, false, false); return; }
      const k = e.target.closest('[data-k]');
      if (k) selectKeyword(k.dataset.k);
    });

    $('#btnWalk').onclick = () => goRoute('walk');
    $('#btnGoMap').onclick = () => goRoute('walk');
    $('#btnBike').onclick = goBike;
    $('#btnTaxi').onclick = () => openTaxi();
    $('#btnToBike').onclick = () => goRoute('walk', '共享单车');

    $('#taxiClose').onclick = closeTaxi;
    $('#taxiModal').addEventListener('click', e => {
      if (e.target.id === 'taxiModal') { closeTaxi(); return; }
      const b = e.target.closest('[data-taxi]');
      if (b) chooseTaxi(b.dataset.taxi);
    });

    $('#btnFav').onclick = () => openFav();
    $('#btnFavMap').onclick = () => openFav();
    $('#btnFavNew').onclick = () => openFav();
    $('#favClose').onclick = closeFav;
    $('#favCancel').onclick = closeFav;
    $('#favSave').onclick = saveFav;
    $('#favModal').addEventListener('click', e => { if (e.target.id === 'favModal') closeFav(); });
    $('#fName').addEventListener('keydown', e => { if (e.key === 'Enter') saveFav(); });
    $('#fAddr').addEventListener('keydown', e => { if (e.key === 'Enter') saveFav(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeFav(); closeTaxi(); } });
    $('#favSearch').addEventListener('input', renderCards);

    $$('.tab[data-v]').forEach(t => t.onclick = () => setView(t.dataset.v));

    $('#cards').addEventListener('change', e => {
      const f = e.target.closest('[data-photo]');
      if (f && f.files[0]) savePhoto(f.dataset.photo, f.files[0]);
    });
    $('#cards').addEventListener('click', e => {
      const go = e.target.closest('[data-favgo]');
      if (go) {
        const r = rows.find(x => x.id === go.dataset.favgo);
        if (r) goRoute('walk', r.name, r.loc ? r.loc.lat.toFixed(6) + ',' + r.loc.lng.toFixed(6) : null);
        return;
      }
      const tx = e.target.closest('[data-favtaxi]');
      if (tx) { const r = rows.find(x => x.id === tx.dataset.favtaxi); openTaxi(r ? r.name : ''); return; }
      const ed = e.target.closest('[data-favedit]');
      if (ed) { openFav(ed.dataset.favedit); return; }
      const cp = e.target.closest('[data-copy]');
      if (cp) { copyText(cp.dataset.copy); cp.textContent = '已复制'; setTimeout(() => cp.textContent = '复制地址', 1400); return; }
      const dl = e.target.closest('[data-favdel]');
      if (dl) { rows = rows.filter(x => x.id !== dl.dataset.favdel); saveFavs(); renderAll(); }
    });
  }

  /* ---------------- 启动 ---------------- */
  bind();
  const radius = store.get('radius', 3000);
  $('#radius').value = String(radius);
  if (validCenter() && center.label) $('#addr').value = center.label;
  $('#dest').value = currentKw;
  $$('.scene[data-kw]').forEach(b => b.classList.toggle('on', b.dataset.kw === currentKw));
  renderAll();
  setView('map');
  search(currentKw, radius);
  mountAds();

  setTimeout(() => {
    if (validCenter()) return;
    silentGeo(g => {
      if (!g) return;
      const a = g.split(',');
      setCenter({ lat: +a[0], lng: +a[1] }, '我的当前位置');
      search(currentKw, null, true);
    });
  }, 700);
})();
