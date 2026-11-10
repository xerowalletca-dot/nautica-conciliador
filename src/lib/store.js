// Almacenamiento local de ajustes (cifrado AES-256-GCM) e historial.
// Las claves de Odoo, bancos y Telegram NUNCA se guardan en texto plano ni se devuelven completas al navegador.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.js';

const SETTINGS_FILE = path.join(DATA_DIR, 'ajustes.enc.json');
const HISTORY_FILE = path.join(DATA_DIR, 'historial.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

// Campos considerados secretos en cualquier nivel del objeto de ajustes.
export const SECRET_KEYS = ['secret', 'token', 'clientSecret', 'apiKey', 'password'];
export const CLEAR = '__BORRAR__';

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function masterKey() {
  ensureDir();
  let secret = process.env.APP_SECRET;
  if (!secret) {
    if (!fs.existsSync(SECRET_FILE)) {
      fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decrypt(payload) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

export function defaultSettings() {
  return {
    empresa: { nombre: 'Náutica / Farma', zonaHoraria: 'America/Caracas' },
    odoo: { url: '', db: '', username: '', secret: '' },
    telegram: { enabled: false, token: '', adminChatIds: [], cobranzaChatId: '' },
    reglas: {
      excluirHoy: true,
      etiquetaComision: 'COMISIÓN BANCARIA',
      // 'copiar' = Etiqueta igual a la descripción del banco (como el archivo real que suben hoy)
      // 'vacia'  = Etiqueta vacía salvo comisiones (como dice el prompt)
      modoEtiqueta: 'copiar',
    },
    automatizacion: {
      activa: false, // trae el extracto de los bancos con API cada mañana
      hora: '07:00', // hora de Caracas
      enviarTelegram: true, // manda resumen + Excel a administración
      subirOdoo: false, // si es true, sube a Odoo sin esperar confirmación
    },
    cuentas: [],
  };
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadSettings() {
  ensureDir();
  if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
  try {
    return deepMerge(defaultSettings(), decrypt(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))));
  } catch (err) {
    throw new Error(`No se pudo descifrar ${SETTINGS_FILE}. ¿Cambió APP_SECRET o data/.secret? (${err.message})`);
  }
}

export function saveSettings(settings) {
  ensureDir();
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(encrypt(settings)), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}

function last4(v) {
  const s = String(v || '');
  // Solo se muestran los últimos 4 caracteres de claves largas (API keys, tokens), nunca de contraseñas cortas.
  return s.length >= 20 ? `••••${s.slice(-4)}` : '••••••••';
}

/** Copia de los ajustes sin secretos, para enviar al navegador. */
export function maskSettings(value) {
  if (Array.isArray(value)) return value.map(maskSettings);
  if (typeof value !== 'object' || value === null) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.includes(k)) {
      out[k] = '';
      out[`${k}Guardado`] = Boolean(v);
      out[`${k}Pista`] = v ? last4(v) : '';
    } else {
      out[k] = maskSettings(v);
    }
  }
  return out;
}

/**
 * Une lo que llega del navegador con lo guardado: un secreto vacío significa "mantener el actual",
 * y CLEAR significa "borrarlo". Las cuentas se emparejan por id.
 */
export function mergeIncoming(incoming, current) {
  if (Array.isArray(incoming)) {
    return incoming.map((item) => {
      const prev = Array.isArray(current) && item && item.id ? current.find((c) => c && c.id === item.id) : undefined;
      return mergeIncoming(item, prev);
    });
  }
  if (typeof incoming !== 'object' || incoming === null) return incoming;
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (/(Guardado|Pista)$/.test(k) && SECRET_KEYS.includes(k.replace(/(Guardado|Pista)$/, ''))) continue;
    if (SECRET_KEYS.includes(k)) {
      if (v === CLEAR) out[k] = '';
      else if (v === '' || v === undefined || v === null) out[k] = current?.[k] ?? '';
      else out[k] = String(v).trim();
    } else {
      out[k] = mergeIncoming(v, current?.[k]);
    }
  }
  return out;
}

// ---------------- Historial ----------------

export function loadHistory() {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function addHistory(entry) {
  const list = loadHistory();
  list.unshift({ id: crypto.randomUUID(), fecha: new Date().toISOString(), ...entry });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 2000), null, 2));
  return list[0];
}

/** ¿Ya se cargó a Odoo este día para esta cuenta? */
export function alreadyUploaded(cuentaId, dia) {
  return loadHistory().find((h) => h.tipo === 'odoo' && h.ok && h.cuentaId === cuentaId && h.dia === dia);
}
