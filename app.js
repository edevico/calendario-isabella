/* Calendario de Isabella — app (PWA) */
(() => {
  'use strict';

  const CFG = window.CAL_CONFIG || {};
  const DEMO = !CFG.API_URL;
  const USERS = CFG.USERS || ['Enzo', 'Coni'];

  const CATS = [
    { id: 'hito', name: 'Hito', emoji: '⭐', color: '#f4a531' },
    { id: 'salud', name: 'Salud', emoji: '🩺', color: '#e05a6d' },
    { id: 'colegio', name: 'Colegio', emoji: '🎒', color: '#4a8fe0' },
    { id: 'actividad', name: 'Actividad', emoji: '⚽', color: '#3bb07a' },
    { id: 'cumple', name: 'Cumpleaños', emoji: '🎂', color: '#c25fd6' },
    { id: 'familia', name: 'Familia', emoji: '💛', color: '#f07b4f' },
    { id: 'otro', name: 'Otro', emoji: '📌', color: '#8a8f9c' }
  ];
  const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  const $ = (s, r = document) => r.querySelector(s);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => ymd(new Date());
  const longDate = (s) => { const d = parseDate(s); return `${DAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`; };
  const shortDate = (s) => { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* nada */ } }
  };

  const now = new Date();
  const state = {
    user: null, key: null,
    events: [],
    year: now.getFullYear(), month: now.getMonth(),
    yearView: now.getFullYear(),
    selected: todayStr(),
    view: 'mes'
  };

  /* ================= API ================= */
  async function api(action, data = {}) {
    if (DEMO) return demoApi(action, data);
    let res;
    try {
      res = await fetch(CFG.API_URL, {
        method: 'POST',
        // text/plain evita el "preflight" CORS que Apps Script no soporta
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, key: state.key, user: state.user, ...data })
      });
    } catch {
      throw Object.assign(new Error('Sin conexión a internet'), { code: 'offline' });
    }
    let json;
    try { json = await res.json(); } catch { throw new Error('Respuesta inválida del servidor'); }
    if (!json.ok) throw Object.assign(new Error(json.error === 'auth' ? 'Código secreto incorrecto' : (json.message || json.error || 'Error')), { code: json.error });
    return json;
  }

  // Modo demo: todo en este dispositivo
  function demoApi(action, d) {
    const evs = store.get('cal-demo-events', []);
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    switch (action) {
      case 'ping': return Promise.resolve({ ok: true });
      case 'list': return Promise.resolve({ ok: true, events: evs });
      case 'save': {
        const e = { ...d.event, updatedBy: state.user, updatedAt: new Date().toISOString() };
        const i = evs.findIndex((x) => x.id === e.id);
        if (i >= 0) {
          const removed = (evs[i].photos || []).filter((p) => !(e.photos || []).some((q) => q.f === p.f));
          removed.forEach((p) => { store.del('cal-demo-photo-' + p.f); store.del('cal-demo-photo-' + p.t); });
          e.createdBy = evs[i].createdBy; e.createdAt = evs[i].createdAt; evs[i] = e;
        } else {
          e.id = uid(); e.createdBy = state.user; e.createdAt = e.updatedAt; evs.push(e);
        }
        store.set('cal-demo-events', evs);
        return Promise.resolve({ ok: true, event: e });
      }
      case 'delete': {
        const e = evs.find((x) => x.id === d.id);
        (e?.photos || []).forEach((p) => { store.del('cal-demo-photo-' + p.f); store.del('cal-demo-photo-' + p.t); });
        store.set('cal-demo-events', evs.filter((x) => x.id !== d.id));
        return Promise.resolve({ ok: true });
      }
      case 'upload': {
        const id = uid();
        if (!store.set('cal-demo-photo-' + id, { data: d.data, mime: d.mime })) {
          return Promise.reject(new Error('El modo demo no tiene más espacio para fotos'));
        }
        return Promise.resolve({ ok: true, id });
      }
      case 'photo': {
        const p = store.get('cal-demo-photo-' + d.id, null);
        return p ? Promise.resolve({ ok: true, ...p }) : Promise.reject(new Error('Foto no encontrada'));
      }
    }
    return Promise.reject(new Error('Acción desconocida'));
  }

  /* ================= Fotos ================= */
  const photoMem = new Map();
  function b64ToBlob(b64, mime) {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'image/jpeg' });
  }
  function photoURL(id) {
    if (!id) return Promise.reject(new Error('sin id'));
    if (photoMem.has(id)) return photoMem.get(id);
    const p = (async () => {
      const cacheKey = new URL('foto/' + encodeURIComponent(id), location.href).href;
      let blob = null;
      try { const c = await caches.open('cal-fotos'); const r = await c.match(cacheKey); if (r) blob = await r.blob(); } catch { /* sin caché */ }
      if (!blob) {
        const j = await api('photo', { id });
        blob = b64ToBlob(j.data, j.mime);
        try { const c = await caches.open('cal-fotos'); await c.put(cacheKey, new Response(blob, { headers: { 'Content-Type': j.mime || 'image/jpeg' } })); } catch { /* sin caché */ }
      }
      return URL.createObjectURL(blob);
    })();
    photoMem.set(id, p);
    p.catch(() => photoMem.delete(id));
    return p;
  }
  function fillImg(img, id) { photoURL(id).then((u) => { img.src = u; }).catch(() => { img.alt = '⚠️'; }); }

  async function resizeImage(file, max, quality) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
    } finally { URL.revokeObjectURL(url); }
  }

  /* ================= Eventos ================= */
  function occursOn(e, ds) {
    if (e.date === ds) return true;
    return e.yearly && e.date < ds && e.date.slice(5) === ds.slice(5);
  }
  const sortEv = (a, b) => (a.time || '99').localeCompare(b.time || '99') || a.title.localeCompare(b.title);
  function eventsOn(ds) { return state.events.filter((e) => occursOn(e, ds)).sort(sortEv); }
  function yearsSince(e, ds) { return parseDate(ds).getFullYear() - parseDate(e.date).getFullYear(); }

  async function refresh(silent) {
    const btn = $('#refreshBtn'); btn.classList.add('spin');
    try {
      const j = await api('list');
      state.events = (j.events || []).filter((e) => e && e.id && e.date);
      store.set('cal-events-cache', state.events);
      render();
    } catch (err) {
      if (err.code === 'auth') { logout(); return; }
      if (!silent) toast(err.code === 'offline' ? 'Sin internet: mostrando lo último guardado' : err.message);
    } finally { btn.classList.remove('spin'); }
  }

  /* ================= Render ================= */
  function render() {
    if (state.view === 'mes') renderMonth();
    else if (state.view === 'ano') renderYear();
    else if (state.view === 'lista') renderList();
    else renderGallery();
  }

  function renderMonth() {
    const { year: y, month: m } = state;
    $('#monthTitle').textContent = `${MONTHS[m]} ${y}`;
    const grid = $('#grid'); grid.innerHTML = '';
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const today = todayStr();
    for (let i = 0; i < offset; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'cell empty' }));
    for (let d = 1; d <= days; d++) {
      const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
      const evs = eventsOn(ds);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell' + (ds === today ? ' today' : '') + (ds === state.selected ? ' selected' : '');
      b.setAttribute('aria-label', `${d} de ${MONTHS[m]}${evs.length ? `, ${evs.length} evento${evs.length > 1 ? 's' : ''}` : ''}`);
      b.innerHTML = `<span class="num">${d}</span>` + (evs.length ? `<span class="dots">${evs.slice(0, 3).map((e) => `<span class="dot" style="background:${(CAT[e.category] || CAT.otro).color}"></span>`).join('')}</span>` : '');
      const withPhoto = evs.find((e) => e.photos && e.photos.length);
      if (withPhoto) {
        b.classList.add('photo');
        photoURL(withPhoto.photos[0].t).then((u) => { b.style.backgroundImage = `url("${u}")`; }).catch(() => {});
      }
      b.addEventListener('click', () => {
        if (state.selected === ds) { openEditor(null, ds); return; } // segundo toque = agregar
        state.selected = ds; renderMonth();
      });
      grid.appendChild(b);
    }
    renderDay();
  }

  function eventCard(e, ds, showDate) {
    const c = CAT[e.category] || CAT.otro;
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'card';
    card.style.setProperty('--cat', c.color);
    const yrs = e.yearly && ds && yearsSince(e, ds) > 0 ? ` · ${yearsSince(e, ds)} año${yearsSince(e, ds) > 1 ? 's' : ''}` : '';
    const sub = [e.time || null, c.name + yrs, e.updatedBy || e.createdBy ? `por ${e.updatedBy || e.createdBy}` : null].filter(Boolean).join(' · ');
    card.innerHTML = `
      <div class="card-emoji">${c.emoji}</div>
      <div class="card-main">
        ${showDate ? `<div class="list-date">${esc(longDate(ds))}${ds.slice(0, 4) !== String(new Date().getFullYear()) ? ' ' + ds.slice(0, 4) : ''}</div>` : ''}
        <div class="card-title">${esc(e.title || '(sin título)')}</div>
        <div class="card-sub">${esc(sub)}</div>
        ${e.notes ? `<div class="card-notes">${esc(e.notes)}</div>` : ''}
        ${e.photos && e.photos.length ? `<div class="card-thumbs"></div>` : ''}
      </div>`;
    if (e.photos && e.photos.length) {
      const strip = card.querySelector('.card-thumbs');
      e.photos.forEach((p) => { const img = document.createElement('img'); img.className = 'thumb'; img.alt = ''; fillImg(img, p.t); strip.appendChild(img); });
    }
    card.addEventListener('click', () => openEditor(e));
    return card;
  }

  function renderDay() {
    const panel = $('#dayPanel'); panel.innerHTML = '';
    const ds = state.selected;
    const head = document.createElement('div'); head.className = 'day-head';
    const ld = longDate(ds);
    head.textContent = ds === todayStr() ? 'Hoy, ' + ld : ld.charAt(0).toUpperCase() + ld.slice(1);
    panel.appendChild(head);
    const evs = eventsOn(ds);
    if (!evs.length) {
      const empty = document.createElement('div'); empty.className = 'empty-day';
      empty.innerHTML = `Nada anotado este día.<br><button type="button" class="btn primary">＋ Agregar algo</button>`;
      empty.querySelector('button').addEventListener('click', () => openEditor(null, ds));
      panel.appendChild(empty);
    } else evs.forEach((e) => panel.appendChild(eventCard(e, ds)));
  }

  function renderYear() {
    const y = state.yearView;
    $('#yearTitle').textContent = y;
    const wrap = $('#yearGrid'); wrap.innerHTML = '';
    const today = todayStr();
    for (let m = 0; m < 12; m++) {
      const box = document.createElement('button'); box.type = 'button';
      box.className = 'mini' + (y === now.getFullYear() && m === now.getMonth() ? ' current' : '');
      const offset = (new Date(y, m, 1).getDay() + 6) % 7;
      const days = new Date(y, m + 1, 0).getDate();
      let cells = ''; let count = 0;
      for (let i = 0; i < offset; i++) cells += '<span></span>';
      for (let d = 1; d <= days; d++) {
        const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
        const evs = eventsOn(ds); count += evs.length;
        const col = evs.length ? (CAT[evs[0].category] || CAT.otro).color : '';
        cells += `<span class="${evs.length ? 'ev' : ''}${ds === today ? ' td' : ''}"${col ? ` style="background:${col}"` : ''}>${d}</span>`;
      }
      box.innerHTML = `<h3>${MONTHS[m]}</h3><div class="mini-grid">${cells}</div><div class="mini-count">${count ? `${count} evento${count > 1 ? 's' : ''}` : '&nbsp;'}</div>`;
      box.addEventListener('click', () => { state.year = y; state.month = m; state.selected = `${y}-${pad(m + 1)}-01`; if (y === now.getFullYear() && m === now.getMonth()) state.selected = todayStr(); setView('mes'); });
      wrap.appendChild(box);
    }
  }

  function renderList() {
    const today = todayStr();
    const occ = [];
    const horizon = new Date(); horizon.setFullYear(horizon.getFullYear() + 1);
    const thisYear = new Date().getFullYear();
    state.events.forEach((e) => {
      if (e.yearly) {
        [thisYear, thisYear + 1].forEach((yy) => { const ds = `${yy}${e.date.slice(4)}`; if (ds >= e.date) occ.push({ e, ds }); });
        if (e.date < today) occ.push({ e, ds: e.date, origin: true });
      } else occ.push({ e, ds: e.date });
    });
    const up = occ.filter((o) => o.ds >= today && o.ds <= ymd(horizon) && !o.origin).sort((a, b) => a.ds.localeCompare(b.ds) || sortEv(a.e, b.e)).slice(0, 30);
    const seen = new Set();
    const past = occ.filter((o) => o.ds < today && (!o.e.yearly || o.origin))
      .sort((a, b) => b.ds.localeCompare(a.ds) || (b.e.updatedAt || '').localeCompare(a.e.updatedAt || ''))
      .filter((o) => !seen.has(o.e.id) && seen.add(o.e.id)).slice(0, 30);
    const fill = (el, arr, msg) => {
      el.innerHTML = '';
      if (!arr.length) { el.innerHTML = `<div class="empty-day">${msg}</div>`; return; }
      arr.forEach((o) => el.appendChild(eventCard(o.e, o.ds, true)));
    };
    fill($('#upcoming'), up, 'No hay nada agendado próximamente.');
    fill($('#recent'), past, 'Todavía no hay recuerdos anotados.');
  }

  function renderGallery() {
    const g = $('#gallery'); g.innerHTML = '';
    const items = [];
    state.events.filter((e) => e.photos && e.photos.length).sort((a, b) => b.date.localeCompare(a.date))
      .forEach((e) => e.photos.forEach((p) => items.push({ e, p })));
    if (!items.length) { g.innerHTML = '<div class="empty-day gallery-empty">Aún no hay fotos. Agrega una a cualquier evento con ＋.</div>'; return; }
    items.forEach(({ e, p }) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'gal-item';
      b.innerHTML = `<img alt=""><span>${esc(shortDate(e.date))} · ${esc(e.title)}</span>`;
      fillImg(b.querySelector('img'), p.t);
      b.addEventListener('click', () => openViewer(p.f, `${e.title} — ${shortDate(e.date)}`, p.t));
      g.appendChild(b);
    });
  }

  function setView(v) {
    state.view = v;
    document.querySelectorAll('.view').forEach((el) => { el.hidden = el.id !== 'view-' + v; });
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    window.scrollTo(0, 0);
    render();
  }

  /* ================= Editor ================= */
  let draft = null;
  function openEditor(ev, ds) {
    draft = ev
      ? { ...ev, photos: [...(ev.photos || [])], newPhotos: [] }
      : { id: null, date: ds || state.selected, time: '', title: '', notes: '', category: 'hito', yearly: false, photos: [], newPhotos: [] };
    $('#sheetTitle').textContent = ev ? 'Editar evento' : 'Nuevo evento';
    $('#fTitle').value = draft.title;
    $('#fDate').value = draft.date;
    $('#fTime').value = draft.time || '';
    $('#fNotes').value = draft.notes || '';
    $('#fYearly').checked = !!draft.yearly;
    $('#sheetDelete').hidden = !ev;
    const meta = [];
    if (ev?.createdBy) meta.push(`Creado por ${ev.createdBy}`);
    if (ev?.updatedBy && ev.updatedAt) meta.push(`última edición: ${ev.updatedBy}, ${new Date(ev.updatedAt).toLocaleDateString('es-CL')}`);
    $('#fMeta').textContent = meta.join(' · ');
    renderCats(); renderDraftPhotos();
    $('#sheet').hidden = false;
    document.body.style.overflow = 'hidden';
    if (!ev) setTimeout(() => $('#fTitle').focus(), 280);
  }
  function closeEditor() { $('#sheet').hidden = true; document.body.style.overflow = ''; draft = null; }

  function renderCats() {
    const wrap = $('#fCats'); wrap.innerHTML = '';
    CATS.forEach((c) => {
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'cat' + (draft.category === c.id ? ' on' : '');
      b.style.setProperty('--c', c.color);
      b.textContent = `${c.emoji} ${c.name}`;
      b.addEventListener('click', () => { draft.category = c.id; if (c.id === 'cumple') $('#fYearly').checked = true; renderCats(); });
      wrap.appendChild(b);
    });
  }

  function renderDraftPhotos() {
    const strip = $('#fPhotos'); strip.innerHTML = '';
    draft.photos.forEach((p, i) => {
      const it = document.createElement('div'); it.className = 'pitem';
      it.innerHTML = '<img alt=""><button type="button" aria-label="Quitar foto">✕</button>';
      fillImg(it.querySelector('img'), p.t);
      it.querySelector('img').addEventListener('click', () => openViewer(p.f, draft.title, p.t));
      it.querySelector('button').addEventListener('click', () => { draft.photos.splice(i, 1); renderDraftPhotos(); });
      strip.appendChild(it);
    });
    draft.newPhotos.forEach((p, i) => {
      const it = document.createElement('div'); it.className = 'pitem';
      it.innerHTML = '<img alt=""><button type="button" aria-label="Quitar foto">✕</button>';
      it.querySelector('img').src = p.thumb;
      it.querySelector('button').addEventListener('click', () => { draft.newPhotos.splice(i, 1); renderDraftPhotos(); });
      strip.appendChild(it);
    });
  }

  async function addFiles(files) {
    if (!files || !files.length || !draft) return;
    busy(true, 'Preparando fotos…');
    try {
      for (const f of files) {
        if (!f.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp)$/i.test(f.name)) continue;
        const full = await resizeImage(f, 1600, 0.82);
        const thumb = await resizeImage(f, 360, 0.72);
        draft.newPhotos.push({ full, thumb });
      }
    } catch (err) { toast(err.message); }
    busy(false);
    renderDraftPhotos();
  }

  async function saveDraft() {
    if (!draft) return;
    const title = $('#fTitle').value.trim();
    if (!title) { toast('Escribe un título'); $('#fTitle').focus(); return; }
    const date = $('#fDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Elige un día'); return; }
    const ev = {
      id: draft.id, date, time: $('#fTime').value || '', title,
      notes: $('#fNotes').value.trim(), category: draft.category, yearly: $('#fYearly').checked,
      photos: [...draft.photos]
    };
    try {
      const total = draft.newPhotos.length;
      for (let i = 0; i < total; i++) {
        busy(true, total > 1 ? `Subiendo foto ${i + 1} de ${total}…` : 'Subiendo foto…');
        const p = draft.newPhotos[i];
        const f = await api('upload', { kind: 'full', mime: 'image/jpeg', data: p.full.split(',')[1], name: `${date}_${title}` });
        const t = await api('upload', { kind: 'thumb', mime: 'image/jpeg', data: p.thumb.split(',')[1], name: `${date}_${title}_mini` });
        ev.photos.push({ f: f.id, t: t.id });
        draft.photos.push({ f: f.id, t: t.id }); // si algo falla luego, no se suben de nuevo
      }
      draft.newPhotos = [];
      busy(true, 'Guardando…');
      const j = await api('save', { event: ev });
      const i = state.events.findIndex((x) => x.id === j.event.id);
      if (i >= 0) state.events[i] = j.event; else state.events.push(j.event);
      store.set('cal-events-cache', state.events);
      busy(false); closeEditor();
      state.selected = date;
      const d = parseDate(date); state.year = d.getFullYear(); state.month = d.getMonth();
      render();
      toast('Guardado ✓');
    } catch (err) {
      busy(false);
      if (err.code === 'auth') { logout(); return; }
      toast('No se pudo guardar: ' + err.message);
    }
  }

  async function deleteDraft() {
    if (!draft || !draft.id) return;
    if (!confirm(`¿Eliminar "${draft.title}"? Esto no se puede deshacer.`)) return;
    busy(true, 'Eliminando…');
    try {
      await api('delete', { id: draft.id });
      state.events = state.events.filter((e) => e.id !== draft.id);
      store.set('cal-events-cache', state.events);
      busy(false); closeEditor(); render(); toast('Eliminado');
    } catch (err) { busy(false); toast('No se pudo eliminar: ' + err.message); }
  }

  /* ================= Visor ================= */
  function openViewer(fullId, caption, thumbId) {
    const img = $('#viewerImg'); img.removeAttribute('src');
    if (thumbId) photoURL(thumbId).then((u) => { if (!img.src) img.src = u; }).catch(() => {});
    photoURL(fullId).then((u) => { img.src = u; }).catch(() => toast('No se pudo cargar la foto'));
    $('#viewerCaption').textContent = caption || '';
    $('#viewer').hidden = false;
  }

  /* ================= UI helpers ================= */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function busy(on, text) { $('#busy').hidden = !on; if (text) $('#busyText').textContent = text; }

  /* ================= Sesión ================= */
  function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false;
    $('#demoNote').hidden = !DEMO;
    const pick = $('#userPick'); pick.innerHTML = '';
    let chosen = state.user || null;
    USERS.forEach((u) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'user-btn' + (u === chosen ? ' on' : '');
      b.textContent = `Soy ${u}`;
      b.addEventListener('click', () => { chosen = u; pick.querySelectorAll('.user-btn').forEach((x) => x.classList.toggle('on', x === b)); });
      pick.appendChild(b);
    });
    $('#loginBtn').onclick = async () => {
      const code = $('#codeInput').value.trim();
      const msg = $('#loginMsg');
      if (!chosen) { msg.textContent = '¿Eres Enzo o Coni? Toca tu nombre.'; return; }
      if (!code && !DEMO) { msg.textContent = 'Escribe el código secreto'; return; }
      msg.textContent = '';
      state.user = chosen; state.key = code || 'demo';
      busy(true, 'Entrando…');
      try {
        await api('ping');
        store.set('cal-session', { user: state.user, key: state.key });
        busy(false); startApp();
      } catch (err) { busy(false); msg.textContent = err.message; }
    };
  }
  function logout() {
    store.del('cal-session'); state.key = null;
    toast('Vuelve a ingresar el código');
    showLogin();
  }

  function startApp() {
    $('#login').hidden = true; $('#app').hidden = false;
    $('#whoami').textContent = `Hola, ${state.user} 👋`;
    $('#demoBanner').hidden = !DEMO;
    state.events = store.get('cal-events-cache', []) || [];
    if (DEMO) state.events = store.get('cal-demo-events', []);
    setView(state.view);
    refresh(true);
  }

  /* ================= Eventos de la UI ================= */
  function bind() {
    $('.dow').innerHTML = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<div>${d}</div>`).join('');
    document.querySelectorAll('.child-name').forEach((el) => { el.textContent = CFG.CHILD || 'Isabella'; });
    const moveMonth = (n) => {
      let m = state.month + n, y = state.year;
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      state.month = m; state.year = y;
      const t = todayStr();
      state.selected = (t.slice(0, 7) === `${y}-${pad(m + 1)}`) ? t : `${y}-${pad(m + 1)}-01`;
      renderMonth();
    };
    $('#prevMonth').addEventListener('click', () => moveMonth(-1));
    $('#nextMonth').addEventListener('click', () => moveMonth(1));
    $('#monthTitle').addEventListener('click', () => { state.yearView = state.year; setView('ano'); });
    $('#todayBtn').addEventListener('click', () => { const d = new Date(); state.year = d.getFullYear(); state.month = d.getMonth(); state.selected = todayStr(); renderMonth(); });
    $('#prevYear').addEventListener('click', () => { state.yearView--; renderYear(); });
    $('#nextYear').addEventListener('click', () => { state.yearView++; renderYear(); });

    // Deslizar para cambiar de mes
    let sx = null, sy = null;
    const grid = $('#grid');
    grid.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    grid.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) moveMonth(dx < 0 ? 1 : -1);
      sx = null;
    });

    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      if (t.dataset.view === 'ano') state.yearView = state.year;
      setView(t.dataset.view);
    }));
    $('#fab').addEventListener('click', () => openEditor(null, state.view === 'mes' ? state.selected : todayStr()));
    $('#refreshBtn').addEventListener('click', () => refresh(false));

    $('#sheetCancel').addEventListener('click', closeEditor);
    $('#sheetSave').addEventListener('click', saveDraft);
    $('#sheetDelete').addEventListener('click', deleteDraft);
    $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeEditor(); });
    $('#fTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    $('#fCamera').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
    $('#fGallery').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

    $('#viewerClose').addEventListener('click', () => { $('#viewer').hidden = true; });
    $('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') $('#viewer').hidden = true; });

    $('#menuBtn').addEventListener('click', () => { $('#menu').hidden = false; });
    $('#menuClose').addEventListener('click', () => { $('#menu').hidden = true; });
    $('#menu').addEventListener('click', (e) => { if (e.target.id === 'menu') $('#menu').hidden = true; });
    $('#switchUser').addEventListener('click', () => { $('#menu').hidden = true; state.user = null; store.del('cal-session'); showLogin(); });
    $('#installHelp').addEventListener('click', () => {
      $('#menu').hidden = true;
      alert('iPhone: abre este link en Safari → botón Compartir (cuadro con flecha) → "Agregar a pantalla de inicio".\n\nAndroid: abre este link en Chrome → menú ⋮ → "Instalar app" o "Agregar a pantalla principal".');
    });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.key) refresh(true); });
  }

  /* ================= Inicio ================= */
  bind();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const s = store.get('cal-session', null);
  if (s && s.user && s.key) { state.user = s.user; state.key = s.key; startApp(); } else showLogin();
})();
