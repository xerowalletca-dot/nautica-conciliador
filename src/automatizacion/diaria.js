// Proceso automático de cada mañana (para cuentas cuyo banco ofrece API de movimientos, ej. Banesco):
//   1. Trae del banco los días cerrados que faltan (el martes trae sábado, domingo y lunes).
//   2. Arma un extracto por día con las reglas de siempre (comisiones, sin día en curso, sin duplicados).
//   3. Envía el resumen y los Excel a administración por Telegram, con botón "Subir a Odoo".
//   4. Si está activado, los sube a Odoo directamente.
import { loadSettings, addHistory, loadHistory } from '../lib/store.js';
import { todayIn, ddmmyyyy } from '../conciliador/reglas.js';
import { analizarDesdeBanco, subirAOdoo, excelDe, resumenTexto, ultimoDiaSubido } from '../conciliador/servicio.js';
import { capacidades } from '../bancos/conectores.js';
import { TelegramClient, escapeHtml } from '../lib/telegram.js';

let timer = null;
let corriendo = false;

export function cuentasSincronizables(settings = loadSettings()) {
  return settings.cuentas.filter((c) => c.activa !== false && c.sincronizar !== false && c.modo === 'api' && capacidades(c.banco).movimientos);
}

function horaLocal(timeZone, ahora = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora);
}

function yaCorrioHoy(hoy) {
  return loadHistory().some((h) => h.tipo === 'automatizacion' && h.hoy === hoy && h.disparo === 'programado');
}

async function avisar(settings, texto, extra) {
  if (!settings.telegram.token) return;
  const tg = new TelegramClient(settings.telegram.token);
  for (const chat of settings.telegram.adminChatIds || []) {
    await tg.sendMessage(chat, texto, extra).catch((err) => console.error('[auto] Telegram:', err.message));
  }
}

async function enviarExcels(settings, a, fechas) {
  if (!settings.telegram.token) return;
  const tg = new TelegramClient(settings.telegram.token);
  for (const date of fechas) {
    const { buffer, nombre } = await excelDe(a.id, date);
    for (const chat of settings.telegram.adminChatIds || []) {
      await tg.sendDocument(chat, buffer, nombre).catch((err) => console.error('[auto] Telegram:', err.message));
    }
  }
}

/**
 * Ejecuta la sincronización para todas las cuentas con API (o solo una).
 * @returns resumen por cuenta
 */
export async function ejecutarSincronizacion({ disparo = 'manual', cuentaId = null, ahora = new Date() } = {}) {
  if (corriendo) throw new Error('Ya hay una sincronización en curso.');
  corriendo = true;
  const settings = loadSettings();
  const auto = settings.automatizacion || {};
  const hoy = todayIn(settings.empresa.zonaHoraria, ahora);
  const resultados = [];
  try {
    const cuentas = cuentasSincronizables(settings).filter((c) => !cuentaId || c.id === cuentaId);
    if (!cuentas.length) throw new Error('No hay cuentas con API de movimientos en modo "API del banco" (Ajustes → Bancos).');
    for (const cuenta of cuentas) {
      try {
        const ultimo = ultimoDiaSubido(cuenta.id);
        const ayer = new Date(Date.parse(`${hoy}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
        if (ultimo && ultimo >= ayer && disparo === 'programado') {
          resultados.push({ cuenta: cuenta.alias, ok: true, mensaje: `Al día (último cargado ${ddmmyyyy(ultimo)}).` });
          continue;
        }
        const a = await analizarDesdeBanco(cuenta.id, { ahora });
        const listos = a.dias.filter((d) => d.estado === 'listo');
        const fechas = listos.map((d) => d.date);
        let subidos = [];
        if (auto.subirOdoo && fechas.length) {
          subidos = await subirAOdoo(a.id, fechas, { usuario: `auto-${disparo}` });
        }
        if (auto.enviarTelegram !== false) {
          const botones =
            !auto.subirOdoo && fechas.length
              ? { reply_markup: { inline_keyboard: [[{ text: `📤 Subir ${fechas.length} día(s) a Odoo`, callback_data: `odoo:${a.id}` }]] } }
              : {};
          const encabezado = `🌅 <b>Extracto automático</b> (${disparo})\n`;
          const pie = subidos.length ? `\n\n${subidos.map((r) => `${r.ok ? '✅' : '❌'} ${ddmmyyyy(r.date)}: ${escapeHtml(r.mensaje)}`).join('\n')}` : '';
          await avisar(settings, encabezado + resumenTexto(a) + (a.dias.length ? '' : '\nSin movimientos en el rango.') + pie, botones);
          await enviarExcels(settings, a, fechas);
        }
        resultados.push({
          cuenta: cuenta.alias,
          ok: true,
          analisisId: a.id,
          rango: a.rango,
          dias: a.dias.map((d) => ({ fecha: d.fecha, estado: d.estado, movimientos: d.totales.movimientos })),
          subidos,
          mensaje: `${a.dias.length} día(s), ${fechas.length} listo(s)${subidos.length ? `, ${subidos.filter((s) => s.ok).length} subido(s) a Odoo` : ''}.`,
        });
      } catch (err) {
        resultados.push({ cuenta: cuenta.alias, ok: false, mensaje: err.message });
        await avisar(settings, `⚠️ <b>Extracto automático ${escapeHtml(cuenta.alias)}</b>: ${escapeHtml(err.message)}`);
      }
    }
    return resultados;
  } finally {
    addHistory({ tipo: 'automatizacion', ok: resultados.every((r) => r.ok), hoy, disparo, resultados });
    corriendo = false;
  }
}

export function iniciarProgramador() {
  if (timer) clearInterval(timer);
  timer = setInterval(async () => {
    try {
      const settings = loadSettings();
      const auto = settings.automatizacion || {};
      if (!auto.activa) return;
      const tz = settings.empresa.zonaHoraria;
      const hoy = todayIn(tz);
      if (horaLocal(tz) < (auto.hora || '07:00') || yaCorrioHoy(hoy) || corriendo) return;
      if (!cuentasSincronizables(settings).length) return;
      console.log(`[auto] Sincronización programada ${hoy}`);
      await ejecutarSincronizacion({ disparo: 'programado' });
    } catch (err) {
      console.error('[auto]', err.message);
    }
  }, 60 * 1000);
  timer.unref();
}

export function estadoAutomatizacion() {
  const settings = loadSettings();
  const ultima = loadHistory().find((h) => h.tipo === 'automatizacion');
  return { ...(settings.automatizacion || {}), cuentas: cuentasSincronizables(settings).map((c) => c.alias), ultima: ultima || null, corriendo };
}
