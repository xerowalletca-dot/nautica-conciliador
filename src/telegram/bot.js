// Bot de Telegram para administración.
//  · Recibe el estado de cuenta (Excel/CSV/TXT) → responde con un Excel por día listo para Odoo.
//  · Botón "Subir a Odoo" para cargar los días cerrados directamente.
//  · Solo atiende a los chats autorizados en Ajustes → Telegram.
import crypto from 'node:crypto';
import { TelegramClient, escapeHtml } from '../lib/telegram.js';
import { loadSettings } from '../lib/store.js';
import { analizar, analizarDesdeBanco, excelDe, subirAOdoo, resumenTexto, obtenerAnalisis } from '../conciliador/servicio.js';
import { textoSaldos, textoMovimientos, rangoExtracto, intencion, AYUDA_CONSULTAS } from './consultas.js';
import { ejecutarSincronizacion } from '../automatizacion/diaria.js';
import { norm } from '../conciliador/parser.js';
import { bancoPorCodigo } from '../bancos/catalogo.js';
import { verificarPago, leerComandoPago } from '../cobranza/verificador.js';

let estado = { activo: false, usuario: null, error: null, desde: null };
let ciclo = 0; // cambia en cada reinicio para cortar el bucle anterior
const pendientes = new Map(); // archivos esperando que el usuario elija la cuenta

export function estadoBot() {
  return { ...estado };
}

export function detenerBot() {
  ciclo++;
  estado = { activo: false, usuario: null, error: null, desde: null };
}

export async function reiniciarBot() {
  detenerBot();
  const settings = loadSettings();
  if (!settings.telegram.enabled || !settings.telegram.token) return estadoBot();
  const miCiclo = ciclo;
  const tg = new TelegramClient(settings.telegram.token);
  try {
    const me = await tg.getMe();
    estado = { activo: true, usuario: me.username, error: null, desde: new Date().toISOString() };
  } catch (err) {
    estado = { activo: false, usuario: null, error: err.message, desde: null };
    return estadoBot();
  }
  bucle(tg, miCiclo);
  return estadoBot();
}

async function bucle(tg, miCiclo) {
  let offset = 0;
  while (miCiclo === ciclo) {
    try {
      const updates = await tg.getUpdates(offset, 25);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (miCiclo !== ciclo) return;
        manejar(tg, u).catch((err) => console.error('[bot] error manejando update:', err.message));
      }
    } catch (err) {
      if (miCiclo !== ciclo) return;
      estado.error = err.message;
      console.error('[bot]', err.message);
      await new Promise((r) => setTimeout(r, err.message.includes('409') ? 15000 : 5000));
    }
  }
}

function autorizado(settings, chatId) {
  const ids = (settings.telegram.adminChatIds || []).map(String);
  return ids.includes(String(chatId));
}

function esCobranza(settings, chatId) {
  return Boolean(settings.telegram.cobranzaChatId) && String(settings.telegram.cobranzaChatId) === String(chatId);
}

const ICONO_VERIF = { confirmado: '✅', no_encontrado: '❌', reutilizado: '🚨' };

async function comandoPago(tg, chatId, texto, from) {
  let datos;
  try {
    datos = leerComandoPago(texto);
  } catch (err) {
    return tg.sendMessage(chatId, escapeHtml(err.message));
  }
  try {
    const r = await verificarPago({ ...datos, usuario: from?.username || from?.first_name || 'telegram', canal: 'telegram' });
    const s = r.solicitud;
    const titulo = { confirmado: 'PAGO CONFIRMADO', no_encontrado: 'PAGO NO ENCONTRADO', reutilizado: 'COMPROBANTE YA USADO' }[r.estado];
    return tg.sendMessage(
      chatId,
      [
        `${ICONO_VERIF[r.estado]} <b>${titulo}</b>`,
        `Cuenta: ${escapeHtml(r.cuenta)}`,
        `Ref ${escapeHtml(s.referencia)} · ${s.fechaPago.split('-').reverse().join('/')} · Bs ${escapeHtml(s.importe)}`,
        `${escapeHtml(s.cedulaPagador)} · ${escapeHtml(s.telefonoPagador)} · banco ${escapeHtml(s.bancoOrigen)}`,
        r.mensaje ? `<i>${escapeHtml(r.mensaje)}</i>` : '',
      ].filter(Boolean).join('\n'),
    );
  } catch (err) {
    return tg.sendMessage(chatId, `⚠️ No se pudo verificar: ${escapeHtml(err.message)}`);
  }
}

function cuentasActivas(settings) {
  return settings.cuentas.filter((c) => c.activa !== false);
}

function elegirCuenta(settings, texto) {
  const activas = cuentasActivas(settings);
  if (activas.length === 1) return activas[0];
  const t = norm(texto);
  if (!t) return null;
  return (
    activas.find((c) => norm(c.alias) && t.includes(norm(c.alias))) ||
    activas.find((c) => t.includes(norm(bancoPorCodigo(c.banco)?.nombre || '@@')))
  );
}

async function manejar(tg, u) {
  const settings = loadSettings();
  if (u.callback_query) return manejarBoton(tg, settings, u.callback_query);
  const msg = u.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  let texto = (msg.text || '').trim().replace(/^(\/\w+)@\w+/, '$1'); // "/saldo@MiBot" → "/saldo"

  if (texto.startsWith('/id') || (texto.startsWith('/start') && !autorizado(settings, chatId))) {
    return tg.sendMessage(chatId, `🆔 El ID de este chat es <code>${chatId}</code>.\nAgrégalo en el panel → Ajustes → Telegram para autorizarlo.`);
  }
  const admin = autorizado(settings, chatId);
  const cobranza = esCobranza(settings, chatId);
  if (!admin && !cobranza) return; // silencio para chats no autorizados

  if (/^\/(pago|verificar)\b/i.test(texto)) return comandoPago(tg, chatId, texto, msg.from);
  if (!admin) {
    if (texto.startsWith('/')) {
      return tg.sendMessage(chatId, 'Para verificar un pago móvil:\n<code>/pago CÉDULA TELÉFONO REFERENCIA FECHA MONTO BANCO</code>\nEj: <code>/pago V12345678 04141234567 123456 10/11/2026 1250,00 0102</code>');
    }
    return;
  }

  const traducido = intencion(texto);
  if (traducido) texto = `${traducido} ${texto}`;

  if (/^\/saldos?\b/i.test(texto)) {
    await tg.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    return tg.sendMessage(chatId, await textoSaldos(texto));
  }
  if (/^\/movimientos?\b/i.test(texto)) {
    await tg.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    return enviarLargo(tg, chatId, await textoMovimientos(texto));
  }
  if (/^\/extracto\b/i.test(texto)) {
    const { cuentas, especifica, desde, hasta } = rangoExtracto(texto);
    if (!cuentas.length) return tg.sendMessage(chatId, 'Ninguna cuenta tiene API de movimientos (Banesco). Para otros bancos, mándame el archivo.');
    if (cuentas.length > 1 && !especifica) {
      return tg.sendMessage(chatId, `¿De qué cuenta? Escribe por ejemplo <code>/extracto ${escapeHtml(cuentas[0].alias)} ayer</code>`);
    }
    await tg.sendMessage(chatId, '⏳ Consultando al banco…');
    return procesar(tg, chatId, () => analizarDesdeBanco(cuentas[0].id, desde ? { desde, hasta } : {}), msg.from);
  }
  if (/^\/sincronizar\b/i.test(texto)) {
    await tg.sendMessage(chatId, '🔄 Ejecutando la sincronización con los bancos…');
    try {
      const r = await ejecutarSincronizacion({ disparo: `telegram/${msg.from?.username || msg.from?.first_name || 'admin'}` });
      return tg.sendMessage(chatId, r.map((x) => `${x.ok ? '✅' : '❌'} <b>${escapeHtml(x.cuenta)}</b>: ${escapeHtml(x.mensaje)}`).join('\n'));
    } catch (err) {
      return tg.sendMessage(chatId, `⚠️ ${escapeHtml(err.message)}`);
    }
  }

  if (texto.startsWith('/start') || texto.startsWith('/ayuda')) {
    return tg.sendMessage(
      chatId,
      [
        '<b>Conciliador Náutica</b> 🧾',
        '',
        '📎 Mándame el estado de cuenta (Excel, CSV o TXT) y te devuelvo <b>un archivo por día</b> listo para Odoo.',
        'Si hay varias cuentas, escribe el alias en el mensaje del archivo (ej. <i>BANESCO</i>).',
        '',
        AYUDA_CONSULTAS,
        '',
        '/cuentas — cuentas configuradas',
        '/id — ID de este chat',
      ].join('\n'),
    );
  }
  if (texto.startsWith('/cuentas')) {
    const lista = cuentasActivas(settings).map((c) => `• <b>${escapeHtml(c.alias)}</b> — ${escapeHtml(bancoPorCodigo(c.banco)?.nombre || c.banco)} ${c.numero ? `(…${escapeHtml(c.numero.slice(-4))})` : ''}`);
    return tg.sendMessage(chatId, lista.length ? lista.join('\n') : 'No hay cuentas configuradas todavía.');
  }

  if (msg.document) {
    const archivo = msg.document.file_name || 'estado_de_cuenta';
    if (msg.document.file_size > 20 * 1024 * 1024) return tg.sendMessage(chatId, '❌ El archivo pesa más de 20 MB.');
    const buffer = await tg.downloadFile(msg.document.file_id);
    const cuenta = elegirCuenta(settings, `${msg.caption || ''} ${archivo}`);
    if (cuenta) return procesar(tg, chatId, () => analizar(buffer, archivo, cuenta.id), msg.from);
    const pid = crypto.randomBytes(6).toString('hex');
    pendientes.set(pid, { buffer, archivo, creado: Date.now() });
    const botones = cuentasActivas(settings).map((c) => [{ text: c.alias, callback_data: `cta:${pid}:${c.id}` }]);
    if (!botones.length) return tg.sendMessage(chatId, 'No hay cuentas bancarias configuradas en el panel.');
    return tg.sendMessage(chatId, `¿De qué cuenta es <b>${escapeHtml(archivo)}</b>?`, { reply_markup: { inline_keyboard: botones } });
  }
}

async function enviarLargo(tg, chatId, texto) {
  // Telegram admite ~4096 caracteres por mensaje
  const bloques = [];
  let actual = '';
  for (const linea of texto.split('\n')) {
    if ((actual + linea).length > 3800) {
      bloques.push(actual);
      actual = '';
    }
    actual += `${linea}\n`;
  }
  if (actual.trim()) bloques.push(actual);
  for (const b of bloques) await tg.sendMessage(chatId, b);
}

async function procesar(tg, chatId, obtener, from) {
  let a;
  try {
    a = await obtener();
  } catch (err) {
    return tg.sendMessage(chatId, `❌ ${escapeHtml(err.message)}`);
  }
  if (!a.dias.length) return tg.sendMessage(chatId, `${resumenTexto(a)}\nSin movimientos en el rango consultado.`);
  const listos = a.dias.filter((d) => d.estado === 'listo');
  const markup = listos.length
    ? { reply_markup: { inline_keyboard: [[{ text: `📤 Subir ${listos.length} día(s) a Odoo`, callback_data: `odoo:${a.id}` }]] } }
    : {};
  await tg.sendMessage(chatId, resumenTexto(a), markup);
  for (const d of listos) {
    const { buffer: xlsx, nombre } = await excelDe(a.id, d.date);
    await tg.sendDocument(chatId, xlsx, nombre);
  }
  a.solicitadoPor = from?.username || from?.first_name || 'telegram';
}

async function manejarBoton(tg, settings, q) {
  const chatId = q.message?.chat?.id;
  if (!autorizado(settings, chatId)) return tg.answerCallback(q.id, 'Chat no autorizado');
  const [tipo, a, b] = String(q.data || '').split(':');

  if (tipo === 'cta') {
    const p = pendientes.get(a);
    pendientes.delete(a);
    if (!p) return tg.answerCallback(q.id, 'El archivo expiró, mándalo de nuevo.');
    await tg.answerCallback(q.id, 'Procesando…');
    return procesar(tg, chatId, () => analizar(p.buffer, p.archivo, b), q.from);
  }

  if (tipo === 'odoo') {
    await tg.answerCallback(q.id, 'Subiendo a Odoo…');
    try {
      const an = obtenerAnalisis(a);
      const fechas = an.dias.filter((d) => d.estado === 'listo').map((d) => d.date);
      const res = await subirAOdoo(a, fechas, { usuario: q.from?.username || q.from?.first_name || 'telegram' });
      const texto = res.map((r) => `${r.ok ? '✅' : '❌'} ${r.date.split('-').reverse().join('/')}: ${escapeHtml(r.mensaje)}`).join('\n');
      return tg.sendMessage(chatId, texto || 'No había días listos para subir.');
    } catch (err) {
      return tg.sendMessage(chatId, `❌ ${escapeHtml(err.message)}`);
    }
  }
  return tg.answerCallback(q.id, '');
}

// Limpia archivos pendientes viejos (30 min)
setInterval(() => {
  const lim = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of pendientes) if (v.creado < lim) pendientes.delete(k);
}, 5 * 60 * 1000).unref();
