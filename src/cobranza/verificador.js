// Verificación de pagos de clientes (cobranza) contra la API del banco.
// Además de preguntar al banco, bloquea comprobantes REUTILIZADOS: un mismo pago solo se acepta una vez.
import { loadSettings, loadHistory, addHistory } from '../lib/store.js';
import { conectorDe } from '../bancos/conectores.js';
import { armarSolicitud } from '../bancos/bdv.js';
import { bancoPorCodigo } from '../bancos/catalogo.js';

export function cuentasVerificables(settings = loadSettings()) {
  return settings.cuentas.filter((c) => c.activa !== false && conectorDe(c)?.consultarPago);
}

function elegirCuenta(settings, cuentaId) {
  const lista = cuentasVerificables(settings);
  if (!lista.length) throw new Error('No hay cuentas con API de verificación (configura una cuenta del Banco de Venezuela con su API Key).');
  if (!cuentaId) {
    if (lista.length === 1) return lista[0];
    throw new Error(`Indica la cuenta: ${lista.map((c) => c.alias).join(', ')}.`);
  }
  const norm = String(cuentaId).trim().toUpperCase();
  const c = lista.find((x) => x.id === cuentaId || x.alias.toUpperCase() === norm);
  if (!c) throw new Error(`La cuenta "${cuentaId}" no existe o no tiene API de verificación.`);
  return c;
}

const claveDePago = (s) => `${s.bancoOrigen}|${s.referencia.replace(/^0+/, '')}|${s.fechaPago}`;

/** Busca si este pago ya fue aceptado antes (comprobante reutilizado). */
export function pagoYaAceptado(cuentaId, solicitud, historial = loadHistory()) {
  const k = claveDePago(solicitud);
  return historial.find((h) => h.tipo === 'verificacion' && h.estado === 'confirmado' && h.cuentaId === cuentaId && h.clave === k);
}

/**
 * @returns {{ estado: 'confirmado'|'no_encontrado'|'reutilizado', mensaje, cuenta, solicitud, previo? }}
 */
export async function verificarPago({ cuentaId, pago, usuario = 'panel', canal = 'panel' }, opciones = {}) {
  const settings = loadSettings();
  const cuenta = elegirCuenta(settings, cuentaId);
  const conector = conectorDe(cuenta);
  const solicitud = armarSolicitud(pago, cuenta); // valida y normaliza antes de llamar al banco
  const base = { tipo: 'verificacion', cuentaId: cuenta.id, cuenta: cuenta.alias, clave: claveDePago(solicitud), ...resumen(solicitud), usuario, canal };

  const previo = pagoYaAceptado(cuenta.id, solicitud);
  if (previo) {
    const mensaje = `Este pago YA fue verificado y aceptado el ${new Date(previo.fecha).toLocaleString('es-VE')} (${previo.usuario}). Posible comprobante reutilizado.`;
    addHistory({ ...base, ok: false, estado: 'reutilizado', mensaje, previoId: previo.id });
    return { estado: 'reutilizado', mensaje, cuenta: cuenta.alias, solicitud, previo };
  }

  let r;
  try {
    r = await conector.consultarPago(cuenta, solicitud, opciones);
  } catch (err) {
    addHistory({ ...base, ok: false, estado: 'error', mensaje: err.message });
    throw err;
  }
  const estado = r.confirmado ? 'confirmado' : 'no_encontrado';
  addHistory({ ...base, ok: r.confirmado, estado, codigo: r.codigo, mensaje: r.mensaje, ambiente: r.ambiente });
  return { estado, mensaje: r.mensaje, codigo: r.codigo, montoBanco: r.montoBanco, cuenta: cuenta.alias, solicitud, ambiente: r.ambiente };
}

function resumen(s) {
  return {
    referencia: s.referencia,
    fechaPago: s.fechaPago,
    importe: s.importe,
    cedula: s.cedulaPagador,
    telefono: s.telefonoPagador,
    bancoOrigen: s.bancoOrigen,
    bancoOrigenNombre: bancoPorCodigo(s.bancoOrigen)?.nombre || s.bancoOrigen,
  };
}

export function historialVerificaciones(limite = 200) {
  return loadHistory().filter((h) => h.tipo === 'verificacion').slice(0, limite);
}

/**
 * Lee el comando de Telegram:
 *   /pago V12345678 04141234567 123456 10/11/2026 1.250,00 0102 [ALIAS]
 * (cédula, teléfono del pagador, referencia, fecha, monto, banco de origen, cuenta opcional)
 */
export function leerComandoPago(texto) {
  const partes = String(texto).trim().split(/\s+/).slice(1);
  if (partes.length < 6) {
    throw new Error('Formato: /pago CÉDULA TELÉFONO REFERENCIA FECHA MONTO BANCO [CUENTA]\nEj: /pago V12345678 04141234567 123456 10/11/2026 1250,00 0102');
  }
  const [cedulaPagador, telefonoPagador, referencia, fechaPago, importe, bancoOrigen, cuenta] = partes;
  return { pago: { cedulaPagador, telefonoPagador, referencia, fechaPago, importe, bancoOrigen }, cuentaId: cuenta || '' };
}
