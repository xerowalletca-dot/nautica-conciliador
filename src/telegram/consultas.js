// Consultas de administración por Telegram: saldos, movimientos, extracto del día y sincronización.
import { loadSettings } from '../lib/store.js';
import { capacidades, consultarSaldo, obtenerMovimientos } from '../bancos/conectores.js';
import { bancoPorCodigo } from '../bancos/catalogo.js';
import { parseDate, norm } from '../conciliador/parser.js';
import { todayIn, ddmmyyyy } from '../conciliador/reglas.js';
import { formatoBs } from '../conciliador/servicio.js';
import { escapeHtml } from '../lib/telegram.js';

/** Separa del texto: la cuenta (por alias o banco) y las fechas. */
export function leerArgumentos(texto, settings, capacidad) {
  const cuerpo = String(texto).replace(/^\/\S+/, ' ').trim();
  const t = ` ${norm(cuerpo)} `;
  const candidatas = settings.cuentas.filter((c) => c.activa !== false && (!capacidad || capacidades(c.banco)[capacidad]));
  const ordenadas = [...candidatas].sort((a, b) => b.alias.length - a.alias.length);
  const porAlias = ordenadas.find((c) => norm(c.alias) && t.includes(` ${norm(c.alias)} `));
  const porBanco = candidatas.find((c) => {
    const n = norm(bancoPorCodigo(c.banco)?.nombre || '@@');
    return t.includes(n) || t.includes(` ${n.split(' ')[0]} `);
  });
  const fechas = cuerpo.split(/\s+/).map((x) => (/^hoy$/i.test(x) ? 'hoy' : /^ayer$/i.test(x) ? 'ayer' : parseDate(x))).filter(Boolean);
  return { cuentas: porAlias ? [porAlias] : porBanco ? [porBanco] : candidatas, fechas, especifica: Boolean(porAlias || porBanco) };
}

function resolverFecha(f, hoy) {
  if (f === 'hoy') return hoy;
  if (f === 'ayer') return new Date(Date.parse(`${hoy}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10);
  return f;
}

export async function textoSaldos(texto) {
  const settings = loadSettings();
  const { cuentas } = leerArgumentos(texto, settings, 'saldo');
  if (!cuentas.length) return 'Ninguna cuenta configurada tiene API de saldos (Banesco).';
  const lineas = ['💰 <b>Saldos</b>'];
  for (const c of cuentas) {
    try {
      const saldos = await consultarSaldo(c);
      lineas.push(`\n<b>${escapeHtml(c.alias)}</b>`);
      for (const s of saldos) lineas.push(`• ${escapeHtml(s.cuenta)} (${escapeHtml(s.tipo)}): <b>Bs ${formatoBs(s.saldo)}</b>`);
      if (!saldos.length) lineas.push('• Sin cuentas en la respuesta.');
    } catch (err) {
      lineas.push(`\n<b>${escapeHtml(c.alias)}</b>: ⚠️ ${escapeHtml(err.message)}`);
    }
  }
  return lineas.join('\n');
}

export async function textoMovimientos(texto, { max = 30 } = {}) {
  const settings = loadSettings();
  const hoy = todayIn(settings.empresa.zonaHoraria);
  const { cuentas, fechas } = leerArgumentos(texto, settings, 'movimientos');
  if (!cuentas.length) return 'Ninguna cuenta configurada tiene API de movimientos (Banesco).';
  const desde = resolverFecha(fechas[0] || 'hoy', hoy);
  const hasta = resolverFecha(fechas[1] || fechas[0] || 'hoy', hoy);
  const salida = [];
  for (const c of cuentas) {
    try {
      const movs = await obtenerMovimientos(c, desde, hasta);
      const cre = movs.filter((m) => m.amount > 0).reduce((s, m) => s + m.amount, 0);
      const deb = movs.filter((m) => m.amount < 0).reduce((s, m) => s + m.amount, 0);
      const rango = desde === hasta ? ddmmyyyy(desde) : `${ddmmyyyy(desde)} → ${ddmmyyyy(hasta)}`;
      salida.push(
        `📊 <b>${escapeHtml(c.alias)}</b> · ${rango}${desde === hoy || hasta === hoy ? ' (día en curso)' : ''}`,
        `${movs.length} mov · <b>+${formatoBs(cre)}</b> / <b>${formatoBs(deb)}</b> · neto ${formatoBs(cre + deb)}`,
      );
      for (const m of movs.slice(-max)) {
        salida.push(`${m.amount > 0 ? '🟢' : '🔴'} ${m.hora ? m.hora.slice(0, 5) : ddmmyyyy(m.date).slice(0, 5)} ${formatoBs(m.amount)} · ${escapeHtml(m.description).slice(0, 40)} · <code>${escapeHtml(m.ref)}</code>`);
      }
      if (movs.length > max) salida.push(`… y ${movs.length - max} más (usa /extracto para el archivo completo).`);
      salida.push('');
    } catch (err) {
      salida.push(`📊 <b>${escapeHtml(c.alias)}</b>: ⚠️ ${escapeHtml(err.message)}`, '');
    }
  }
  return salida.join('\n').trim();
}

export function rangoExtracto(texto) {
  const settings = loadSettings();
  const hoy = todayIn(settings.empresa.zonaHoraria);
  const { cuentas, fechas, especifica } = leerArgumentos(texto, settings, 'movimientos');
  const desde = fechas[0] ? resolverFecha(fechas[0], hoy) : null;
  const hasta = fechas[1] ? resolverFecha(fechas[1], hoy) : desde;
  return { cuentas, especifica, desde, hasta };
}

export const AYUDA_CONSULTAS = [
  '💰 /saldo [cuenta] — saldos en línea (Banesco)',
  '📊 /movimientos [cuenta] [fecha] [hasta] — movimientos (por defecto hoy)',
  '📄 /extracto [cuenta] [fecha] — Excel para Odoo desde el banco (por defecto lo pendiente)',
  '🔄 /sincronizar — corre ahora el proceso automático de la mañana',
  '🔎 /pago CÉDULA TELÉFONO REFERENCIA FECHA MONTO BANCO [cuenta] — verificar un pago',
  'También puedes escribir: <i>saldo banesco</i>, <i>movimientos de ayer</i>…',
].join('\n');

/** Traduce frases sencillas a comandos. */
export function intencion(texto) {
  const t = norm(texto);
  if (t.startsWith('/')) return null;
  if (/\bsaldos?\b|\bcuanto hay\b|\bdisponible\b/.test(t)) return '/saldo';
  if (/\bmovimientos?\b|\bque entro\b|\bque ha entrado\b/.test(t)) return '/movimientos';
  if (/\bextracto\b|\bestado de cuenta\b/.test(t)) return '/extracto';
  if (/\bsincroniza/.test(t)) return '/sincronizar';
  if (/\bayuda\b|\bcomandos\b/.test(t)) return '/ayuda';
  return null;
}
