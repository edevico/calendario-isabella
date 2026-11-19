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

const HEADERS = ['id', 'date', 'time', 'title', 'notes', 'category', 'yearly', 'photos', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'];
const USERS = ['Enzo', 'Coni'];
const CATEGORIES = ['hito', 'salud', 'colegio', 'actividad', 'cumple', 'familia', 'otro'];
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

  Logger.log('Listo ✔');
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
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID')).getSheetByName('Eventos');
}

function rowToEvent(r) {
  const o = {};
  HEADERS.forEach((h, i) => { o[h] = r[i]; });
  if (o.date instanceof Date) o.date = Utilities.formatDate(o.date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (o.time instanceof Date) o.time = Utilities.formatDate(o.time, Session.getScriptTimeZone(), 'HH:mm');
  o.id = String(o.id); o.date = String(o.date); o.time = String(o.time || '');
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
    const full = Object.assign({}, clean, { id: old.id, createdBy: old.createdBy, createdAt: old.createdAt, updatedBy: user, updatedAt: now });
    sh.getRange(row, 1, 1, HEADERS.length).setValues([eventToRow(full)]);
    return full;
  }
  const full = Object.assign({}, clean, { id: Utilities.getUuid(), createdBy: user, createdAt: now, updatedBy: user, updatedAt: now });
  sh.appendRow(eventToRow(full));
  return full;
}

function deleteEvent(id) {
  const sh = sheet();
  const row = findRow(sh, id);
  if (row < 0) return;
  const old = rowToEvent(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]);
  old.photos.forEach((p) => { trashFile(p.f); trashFile(p.t); });
  sh.deleteRow(row);
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
