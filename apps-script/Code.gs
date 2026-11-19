/**
 * Calendario de Isabella — servidor en Google Apps Script.
 * Guarda los eventos en una planilla de Google Sheets y las fotos en una carpeta de Google Drive,
 * todo dentro de la cuenta de Google de quien instala este script.
 *
 * INSTALACIÓN (una sola vez):
 *  1. Pega este archivo en script.google.com (proyecto nuevo) y guarda.
 *  2. Elige la función "configurar" arriba y presiona "Ejecutar". Acepta los permisos.
 *  3. Mira el "Registro de ejecución": ahí aparece el CÓDIGO SECRETO de la familia.
 *  4. Implementar → Nueva implementación → tipo "Aplicación web":
 *       Ejecutar como: Yo   ·   Quién tiene acceso: Cualquier persona
 *     Copia la URL que termina en /exec y pégala en app/config.js (API_URL).
 */

const HEADERS = ['id', 'date', 'time', 'title', 'notes', 'category', 'yearly', 'photos', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'endDate', 'remind', 'calId'];
const USERS = ['Enzo', 'Coni'];
const CATEGORIES = ['hito', 'salud', 'colegio', 'actividad', 'cumple', 'familia', 'otro'];
const EMOJI = { hito: '⭐', salud: '🩺', colegio: '🎒', actividad: '⚽', cumple: '🎂', familia: '💛', otro: '📌' };
const REMINDERS = ['', '60', '1440', '10080']; // minutos antes
const TZ = 'America/Santiago';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/** Ejecutar UNA vez desde el editor. Crea la carpeta, la planilla y el código secreto. */
function configurar() {
  const props = PropertiesService.getScriptProperties();

  let root;
  if (props.getProperty('ROOT_ID')) root = DriveApp.getFolderById(props.getProperty('ROOT_ID'));
  else { root = DriveApp.createFolder('Calendario Isabella'); props.setProperty('ROOT_ID', root.getId()); }

  if (!props.getProperty('FOLDER_ID')) {
    const fotos = root.createFolder('Fotos');
    props.setProperty('FOLDER_ID', fotos.getId());
  }

  if (!props.getProperty('SHEET_ID')) {
    const ss = SpreadsheetApp.create('Calendario Isabella - Eventos');
    const sh = ss.getSheets()[0];
    sh.setName('Eventos');
    sh.getRange('A:L').setNumberFormat('@'); // todo como texto (fechas sin conversiones raras)
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    props.setProperty('SHEET_ID', ss.getId());
  }

  if (!props.getProperty('SECRET')) {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += abc.charAt(Math.floor(Math.random() * abc.length));
    props.setProperty('SECRET', code);
  }

  sheet(); // agrega columnas nuevas si faltan
  const cal = calendar();
  sincronizarCalendario();

  Logger.log('Listo ✔');
  Logger.log('Calendario de Google para avisos: "' + cal.getName() + '"');
  Logger.log('Carpeta en Drive: ' + root.getUrl());
  Logger.log('CÓDIGO SECRETO de la familia: ' + props.getProperty('SECRET'));
}

/** Por si quieren cambiar el código secreto más adelante: ejecutar y ver el registro. */
function cambiarCodigoSecreto() {
  PropertiesService.getScriptProperties().deleteProperty('SECRET');
  configurar();
}

function doGet() {
  return ContentService.createTextOutput('Calendario de Isabella: servidor funcionando ✔');
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad_request' }); }

  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || String(req.key || '').trim().toUpperCase() !== secret) return out({ ok: false, error: 'auth' });
  const user = USERS.indexOf(req.user) >= 0 ? req.user : 'Familia';

  try {
    switch (req.action) {
      case 'ping': return out({ ok: true });
      case 'list': return out({ ok: true, events: listEvents() });
      case 'save': return out({ ok: true, event: withLock(() => saveEvent(req.event, user)) });
      case 'delete': withLock(() => deleteEvent(String(req.id))); return out({ ok: true });
      case 'upload': return out({ ok: true, id: uploadPhoto(req) });
      case 'photo': return out(Object.assign({ ok: true }, getPhoto(String(req.id))));
      default: return out({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return out({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

/* ---------- Eventos ---------- */

function sheet() {
  const sh = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getSheetByName('Eventos');
  if (sh.getLastColumn() < HEADERS.length) {
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  }
  return sh;
}

function rowToEvent(r) {
  const o = {};
  HEADERS.forEach((h, i) => { o[h] = r[i]; });
  if (o.date instanceof Date) o.date = Utilities.formatDate(o.date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (o.time instanceof Date) o.time = Utilities.formatDate(o.time, Session.getScriptTimeZone(), 'HH:mm');
  if (o.endDate instanceof Date) o.endDate = Utilities.formatDate(o.endDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  o.id = String(o.id); o.date = String(o.date); o.time = String(o.time || '');
  o.endDate = String(o.endDate || ''); o.remind = String(o.remind || ''); o.calId = String(o.calId || '');
  o.title = String(o.title || ''); o.notes = String(o.notes || '');
  o.yearly = o.yearly === true || String(o.yearly).toUpperCase() === 'TRUE' || o.yearly === 'sí';
  try { o.photos = o.photos ? JSON.parse(o.photos) : []; } catch (e) { o.photos = []; }
  return o;
}

function eventToRow(o) {
  return HEADERS.map((h) => {
    if (h === 'photos') return JSON.stringify(o.photos || []);
    if (h === 'yearly') return o.yearly ? 'TRUE' : 'FALSE';
    return o[h] == null ? '' : String(o[h]);
  });
}

function listEvents() {
  const sh = sheet();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues()
    .filter((r) => r[0] && r[1])
    .map(rowToEvent);
}

function findRow(sh, id) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const ids = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return i + 2;
  return -1;
}

function saveEvent(ev, user) {
  if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(String(ev.date))) throw new Error('Fecha inválida');
  const clean = {
    date: String(ev.date),
    time: /^\d{2}:\d{2}$/.test(String(ev.time || '')) ? String(ev.time) : '',
    title: String(ev.title || '').slice(0, 120),
    notes: String(ev.notes || '').slice(0, 4000),
    category: CATEGORIES.indexOf(ev.category) >= 0 ? ev.category : 'otro',
    yearly: !!ev.yearly,
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(String(ev.endDate || '')) && String(ev.endDate) > String(ev.date) ? String(ev.endDate) : '',
    remind: REMINDERS.indexOf(String(ev.remind || '')) >= 0 ? String(ev.remind || '') : '',
    photos: (Array.isArray(ev.photos) ? ev.photos : [])
      .filter((p) => p && typeof p.f === 'string' && typeof p.t === 'string')
      .map((p) => ({ f: p.f, t: p.t }))
  };
  if (!clean.title) throw new Error('Falta el título');

  const sh = sheet();
  const now = new Date().toISOString();
  const row = ev.id ? findRow(sh, String(ev.id)) : -1;

  if (row > 0) {
    const old = rowToEvent(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]);
    // Mover a la papelera las fotos que se quitaron del evento
    old.photos.forEach((p) => {
      if (!clean.photos.some((q) => q.f === p.f)) { trashFile(p.f); trashFile(p.t); }
    });
    const full = Object.assign({}, clean, { id: old.id, createdBy: old.createdBy, createdAt: old.createdAt, updatedBy: user, updatedAt: now, calId: old.calId });
    full.calId = syncCalendarEvent(full);
    sh.getRange(row, 1, 1, HEADERS.length).setValues([eventToRow(full)]);
    return full;
  }
  const full = Object.assign({}, clean, { id: Utilities.getUuid(), createdBy: user, createdAt: now, updatedBy: user, updatedAt: now, calId: '' });
  full.calId = syncCalendarEvent(full);
  sh.appendRow(eventToRow(full));
  return full;
}

function deleteEvent(id) {
  const sh = sheet();
  const row = findRow(sh, id);
  if (row < 0) return;
  const old = rowToEvent(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]);
  old.photos.forEach((p) => { trashFile(p.f); trashFile(p.t); });
  removeCalendarEvent(old.calId);
  sh.deleteRow(row);
}

/* ---------- Google Calendar (avisos) ---------- */

function calendar() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CAL_ID');
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar('Isabella', {
      timeZone: TZ, color: CalendarApp.Color.PINK, summary: 'Eventos de Isabella (se llena solo desde la app del calendario)'
    });
    props.setProperty('CAL_ID', cal.getId());
  }
  return cal;
}

/** Fecha "de día completo" (mediodía en la zona del script, para que no se corra el día). */
function dayDate(ds, plusDays) {
  const p = ds.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2] + (plusDays || 0), 12, 0, 0);
}
function dateTimeAt(ds, hhmm) {
  return Utilities.parseDate(ds + ' ' + hhmm, TZ, 'yyyy-MM-dd HH:mm');
}

/** Minutos antes del inicio. En eventos de día completo, el aviso cae a las 18:00 del día anterior. */
function reminderMinutes(ev) {
  const r = Number(ev.remind || 0);
  if (!r) return 0;
  if (ev.time) return r;
  if (r >= 10080) return 6 * 1440 + 360; // 1 semana antes, 18:00
  return 360;                              // día anterior, 18:00
}

function removeCalendarEvent(calId) {
  if (!calId) return;
  try {
    const cal = calendar();
    const s = cal.getEventSeriesById(calId);
    if (s) { s.deleteEventSeries(); return; }
  } catch (e) { /* sigue */ }
  try { const ev = calendar().getEventById(calId); if (ev) ev.deleteEvent(); } catch (e) { /* ya no existe */ }
}

/** Crea (o recrea) el evento en Google Calendar. Devuelve su id. Nunca hace fallar el guardado. */
function syncCalendarEvent(ev) {
  try {
    removeCalendarEvent(ev.calId);
    const cal = calendar();
    const title = (EMOJI[ev.category] || '') + ' ' + ev.title;
    const by = ev.updatedBy || ev.createdBy;
    const opts = { description: (ev.notes ? ev.notes + '\n\n' : '') + '— Calendario de Isabella' + (by ? ' · anotado por ' + by : '') };
    const last = ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date;
    let item;
    if (!ev.time) {
      if (ev.yearly) item = cal.createAllDayEventSeries(title, dayDate(ev.date), CalendarApp.newRecurrence().addYearlyRule(), opts);
      else item = cal.createAllDayEvent(title, dayDate(ev.date), dayDate(last, 1), opts);
    } else {
      const start = dateTimeAt(ev.date, ev.time);
      const end = new Date(dateTimeAt(last, ev.time).getTime() + 60 * 60 * 1000);
      if (ev.yearly) item = cal.createEventSeries(title, start, end, CalendarApp.newRecurrence().addYearlyRule(), opts);
      else item = cal.createEvent(title, start, end, opts);
    }
    item.removeAllReminders();
    const min = reminderMinutes(ev);
    if (min) item.addPopupReminder(min);
    return item.getId();
  } catch (err) {
    console.error('No se pudo sincronizar con Calendar: ' + err);
    return ev.calId || '';
  }
}

/** Pasa todos los eventos a Google Calendar (se ejecuta dentro de "configurar"). */
function sincronizarCalendario() {
  const sh = sheet();
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const rows = sh.getRange(2, 1, n, HEADERS.length).getValues();
  rows.forEach((r, i) => {
    if (!r[0] || !r[1]) return;
    const ev = rowToEvent(r);
    if (!ev.remind && (ev.yearly || ev.date >= today)) ev.remind = '1440';
    ev.calId = syncCalendarEvent(ev);
    sh.getRange(i + 2, 1, 1, HEADERS.length).setValues([eventToRow(ev)]);
  });
}

/* ---------- Fotos ---------- */

function photosFolder() {
  return DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FOLDER_ID'));
}

function uploadPhoto(req) {
  const mime = /^image\/(jpeg|png|webp)$/.test(req.mime) ? req.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(req.data || ''));
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw new Error('Foto vacía o demasiado grande');
  const folder = photosFolder();
  const sub = req.kind === 'thumb' ? subfolder(folder, 'miniaturas') : folder;
  const name = String(req.name || 'foto').replace(/[\\/:*?"<>|]/g, '').slice(0, 80) + '.jpg';
  return sub.createFile(Utilities.newBlob(bytes, mime, name)).getId();
}

function subfolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Solo entrega archivos que estén dentro de la carpeta de fotos de la app. */
function insideAppFolder(file) {
  const rootId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  const parents = file.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() === rootId) return true;
    const gp = p.getParents();
    while (gp.hasNext()) if (gp.next().getId() === rootId) return true;
  }
  return false;
}

function getPhoto(id) {
  const file = DriveApp.getFileById(id);
  if (!insideAppFolder(file) || file.isTrashed()) throw new Error('Foto no disponible');
  const blob = file.getBlob();
  return { mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function trashFile(id) {
  try { const f = DriveApp.getFileById(id); if (insideAppFolder(f)) f.setTrashed(true); } catch (e) { /* ya no existe */ }
}

/* ---------- Utilidades ---------- */

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
