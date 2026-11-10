// Orquesta el flujo completo, compartido por el panel web y por el bot de Telegram:
// archivo → movimientos → días → Excel / Odoo / Telegram.
import crypto from 'node:crypto';
import { parseStatement } from './parser.js';
import { construirDias, todayIn, ddmmyyyy } from './reglas.js';
import { excelDelDia, nombreArchivo } from './excel.js';
import { OdooClient } from '../lib/odoo.js';
import { TelegramClient } from '../lib/telegram.js';
import { loadSettings, addHistory, alreadyUploaded, loadHistory } from '../lib/store.js';
import { bancoPorCodigo } from '../bancos/catalogo.js';
import { obtenerMovimientos } from '../bancos/conectores.js';

const analisis = new Map(); // id -> { creado, cuenta, archivo, resultado }
const TTL_MS = 6 * 60 * 60 * 1000;

function limpiarViejos() {
  const limite = Date.now() - TTL_MS;
  for (const [id, a] of analisis) if (a.creado < limite) analisis.delete(id);
}

export function obtenerCuenta(settings, cuentaId) {
  const cuenta = settings.cuentas.find((c) => c.id === cuentaId);
  if (!cuenta) throw new Error('Cuenta bancaria no encontrada. Configúrala en Ajustes → Bancos.');
  return cuenta;
}

export async function analizar(buffer, archivo, cuentaId, { ahora = new Date() } = {}) {
  const settings = loadSettings();
  const cuenta = obtenerCuenta(settings, cuentaId);
  const lectura = await parseStatement(buffer, archivo, { referenciaLargo: Number(cuenta.referenciaLargo) || 0 });
  return registrarAnalisis(settings, cuenta, lectura, archivo, ahora);
}

/** Último día cargado a Odoo para una cuenta (o null). */
export function ultimoDiaSubido(cuentaId) {
  return loadHistory().find((h) => h.tipo === 'odoo' && h.ok && h.cuentaId === cuentaId)?.dia || null;
}

function sumarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Rango por defecto para traer del banco: desde el día siguiente al último cargado (máx. 7 días atrás) hasta ayer.
 * Así, el martes trae sábado, domingo y lunes automáticamente.
 */
export function rangoPendiente(cuentaId, hoy) {
  const ayer = sumarDias(hoy, -1);
  const ultimo = ultimoDiaSubido(cuentaId);
  let desde = ultimo ? sumarDias(ultimo, 1) : ayer;
  const limite = sumarDias(hoy, -7);
  if (desde < limite) desde = limite;
  return { desde: desde > ayer ? ayer : desde, hasta: ayer };
}

/** Trae los movimientos directo de la API del banco y arma los días igual que con un archivo. */
export async function analizarDesdeBanco(cuentaId, { desde, hasta, ahora = new Date() } = {}) {
  const settings = loadSettings();
  const cuenta = obtenerCuenta(settings, cuentaId);
  const hoy = todayIn(settings.empresa.zonaHoraria, ahora);
  const rango = desde && hasta ? { desde, hasta } : rangoPendiente(cuenta.id, hoy);
  const movimientos = await obtenerMovimientos(cuenta, rango.desde, rango.hasta);
  const lectura = { movimientos, columnas: { origen: 'API del banco' }, hoja: 'API', filaEncabezado: 0, advertencias: [] };
  const nombre = rango.desde === rango.hasta ? `API ${ddmmyyyy(rango.desde)}` : `API ${ddmmyyyy(rango.desde)} → ${ddmmyyyy(rango.hasta)}`;
  const a = registrarAnalisis(settings, cuenta, lectura, nombre, ahora);
  a.rango = rango;
  return a;
}

function registrarAnalisis(settings, cuenta, lectura, archivo, ahora) {
  limpiarViejos();
  const hoy = todayIn(settings.empresa.zonaHoraria, ahora);
  const resultado = construirDias(lectura.movimientos, { cuenta, reglas: settings.reglas, hoy });
  for (const dia of resultado.dias) {
    const previo = alreadyUploaded(cuenta.id, dia.date);
    if (previo) {
      dia.yaSubido = { fecha: previo.fecha, statementId: previo.statementId };
      if (dia.estado === 'listo') {
        dia.estado = 'subido';
        dia.motivo = `Ya se cargó a Odoo el ${new Date(previo.fecha).toLocaleString('es-VE')}.`;
      }
    }
  }
  const id = crypto.randomUUID();
  const registro = {
    id,
    creado: Date.now(),
    archivo,
    cuenta: { id: cuenta.id, alias: cuenta.alias, banco: cuenta.banco, bancoNombre: bancoPorCodigo(cuenta.banco)?.nombre || cuenta.banco },
    columnas: lectura.columnas,
    hoja: lectura.hoja,
    filaEncabezado: lectura.filaEncabezado,
    advertencias: [...lectura.advertencias, ...resultado.advertencias],
    hoy: resultado.hoy,
    dias: resultado.dias,
  };
  analisis.set(id, registro);
  return registro;
}

export function obtenerAnalisis(id) {
  const a = analisis.get(id);
  if (!a) throw new Error('El análisis expiró o no existe. Vuelve a subir el archivo.');
  return a;
}

export async function excelDe(id, date) {
  const a = obtenerAnalisis(id);
  const dia = a.dias.find((d) => d.date === date);
  if (!dia) throw new Error(`No hay movimientos del ${date} en el archivo.`);
  return { buffer: await excelDelDia(dia), nombre: nombreArchivo(a.cuenta.alias, date) };
}

export function odooDesdeAjustes(settings = loadSettings()) {
  return new OdooClient(settings.odoo);
}

function clave(l) {
  return `${l.date}|${String(l.ref || l.referencia || '').trim()}|${Number(l.amount ?? l.importe).toFixed(2)}`;
}

/** Sube a Odoo los días indicados. Nunca sube días "esperar" (hoy o futuros) y no duplica. */
export async function subirAOdoo(id, fechas, { forzar = false, usuario = 'panel' } = {}) {
  const a = obtenerAnalisis(id);
  const settings = loadSettings();
  const cuenta = obtenerCuenta(settings, a.cuenta.id);
  if (!cuenta.diarioOdooId) throw new Error(`La cuenta ${cuenta.alias} no tiene un diario de Odoo asignado (Ajustes → Bancos).`);
  const odoo = odooDesdeAjustes(settings);
  await odoo.authenticate();

  const objetivo = a.dias.filter((d) => fechas.includes(d.date));
  const existentes = await odoo.existingLines(cuenta.diarioOdooId, objetivo.map((d) => d.date));
  const yaEnOdoo = new Set(existentes.map(clave));

  const resultados = [];
  for (const dia of objetivo) {
    if (dia.estado === 'esperar') {
      resultados.push({ date: dia.date, ok: false, mensaje: dia.motivo });
      continue;
    }
    if (dia.estado === 'subido' && !forzar) {
      resultados.push({ date: dia.date, ok: false, mensaje: dia.motivo });
      continue;
    }
    const repetidas = dia.lineas.filter((l) => yaEnOdoo.has(clave(l)));
    if (repetidas.length && !forzar) {
      resultados.push({
        date: dia.date,
        ok: false,
        mensaje: `Odoo ya tiene ${repetidas.length} de ${dia.lineas.length} líneas de este día en el diario (misma fecha, referencia e importe). No se subió para no duplicar.`,
      });
      continue;
    }
    try {
      const nombre = `${cuenta.alias} ${dia.fecha}`;
      const saldoFinal = dia.saldos?.disponible && !dia.saldos.errores.length ? dia.saldos.saldoFinal : undefined;
      const statementId = await odoo.createStatement({ journalId: cuenta.diarioOdooId, name: nombre, lines: dia.lineas, balanceEnd: saldoFinal });
      dia.estado = 'subido';
      dia.motivo = 'Cargado a Odoo ahora.';
      addHistory({ tipo: 'odoo', ok: true, cuentaId: cuenta.id, cuenta: cuenta.alias, dia: dia.date, statementId, lineas: dia.lineas.length, totales: dia.totales, archivo: a.archivo, usuario });
      resultados.push({ date: dia.date, ok: true, statementId, mensaje: `Extracto "${nombre}" creado en Odoo (${dia.lineas.length} líneas).` });
    } catch (err) {
      addHistory({ tipo: 'odoo', ok: false, cuentaId: cuenta.id, cuenta: cuenta.alias, dia: dia.date, error: err.message, archivo: a.archivo, usuario });
      resultados.push({ date: dia.date, ok: false, mensaje: err.message });
    }
  }
  return resultados;
}

export function formatoBs(n) {
  return new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

export function resumenTexto(a) {
  const lineas = [`<b>🏦 ${a.cuenta.alias}</b> · ${a.archivo}`];
  for (const d of a.dias) {
    const icono = d.estado === 'listo' ? '✅' : d.estado === 'subido' ? '☑️' : '⏳';
    lineas.push(
      `${icono} <b>${d.fecha}</b> · ${d.totales.movimientos} mov · ` +
        `+${formatoBs(d.totales.creditos)} / ${formatoBs(d.totales.debitos)}` +
        (d.totales.comisiones ? ` · ${d.totales.comisiones} comisión(es)` : '') +
        (d.estado !== 'listo' ? `\n    <i>${d.motivo}</i>` : ''),
    );
  }
  if (a.advertencias.length) lineas.push(`\n⚠️ ${a.advertencias.length} advertencia(s). Revísalas en el panel.`);
  return lineas.join('\n');
}

/** Envía los Excel de los días listos a los chats de administración. */
export async function enviarATelegram(id, fechas) {
  const settings = loadSettings();
  const chats = settings.telegram.adminChatIds || [];
  if (!chats.length) throw new Error('No hay chats de administración configurados en Ajustes → Telegram.');
  const tg = new TelegramClient(settings.telegram.token);
  const a = obtenerAnalisis(id);
  const enviados = [];
  for (const date of fechas) {
    const { buffer, nombre } = await excelDe(id, date);
    const dia = a.dias.find((d) => d.date === date);
    for (const chat of chats) {
      await tg.sendDocument(chat, buffer, nombre, `📄 ${a.cuenta.alias} ${ddmmyyyy(date)} · ${dia.totales.movimientos} movimientos`);
    }
    enviados.push(nombre);
  }
  return enviados;
}
