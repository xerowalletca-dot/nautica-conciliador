// Conector "API Conciliación BDV" (Banco de Venezuela, manual MDU-006 v1, enero 2024).
//
// Qué hace: confirma si un PAGO MÓVIL específico llegó a la cuenta de la empresa.
// Qué NO hace: no lista movimientos ni descarga el estado de cuenta.
//
//   POST {endpoint}/getMovement   Header: X-API-Key   Content-Type: application/json
//   { cedulaPagador, telefonoPagador, telefonoDestino, referencia, fechaPago (YYYY-MM-DD), importe ("120.00"), bancoOrigen ("0102") }
//   → { code: 1000, message, data: { status, amount, reason }, status: 200 }   (cualquier code ≠ 1000 es error)

import { parseAmount, parseDate } from '../conciliador/parser.js';

export const ENDPOINTS = {
  produccion: 'https://bdvconciliacion.banvenez.com:443/getMovement',
  calidad: 'http://200.11.243.176:444/getMovement',
};
// Clave pública del ambiente de calidad, publicada en el propio manual del BDV (no sirve en producción).
export const API_KEY_CALIDAD = '96R7T1T5J2134T5YFC2GF15SDFG4BD1Z';

export class BdvError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

// ---------------- Normalización de datos ----------------

export function normCedula(v) {
  const s = String(v ?? '').toUpperCase().replace(/[\s.\-_]/g, '');
  if (!s) throw new BdvError('Falta la cédula del pagador.');
  const m = s.match(/^([VEJGP])?0*(\d{5,10})$/);
  if (!m) throw new BdvError(`Cédula inválida: "${v}". Usa el formato V12345678.`);
  return `${m[1] || 'V'}${m[2]}`;
}

export function normTelefono(v, campo = 'teléfono') {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.startsWith('58') && d.length === 12) d = `0${d.slice(2)}`;
  if (d.length === 10 && d.startsWith('4')) d = `0${d}`;
  if (!/^04\d{9}$/.test(d)) throw new BdvError(`${campo} inválido: "${v}". Debe ser un celular de 11 dígitos, ej. 04121234567.`);
  return d;
}

export function normFecha(v) {
  const f = parseDate(v);
  if (!f) throw new BdvError(`Fecha inválida: "${v}". Usa dd/mm/aaaa.`);
  return f;
}

export function normImporte(v) {
  const n = typeof v === 'number' ? v : parseAmount(v);
  if (!n || n <= 0) throw new BdvError(`Monto inválido: "${v}".`);
  return Math.abs(n).toFixed(2);
}

export function normBanco(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (!d || d.length > 4) throw new BdvError(`Banco de origen inválido: "${v}". Usa el código de 4 dígitos, ej. 0102.`);
  return d.padStart(4, '0');
}

export function normReferencia(v) {
  const s = String(v ?? '').replace(/\s/g, '');
  if (!s) throw new BdvError('Falta la referencia del pago.');
  return s;
}

/** Arma el JSON de entrada exacto que pide el manual. (normalizarPago es el nombre genérico que usa el verificador) */
export function armarSolicitud(pago, cuenta) {
  return {
    cedulaPagador: normCedula(pago.cedulaPagador),
    telefonoPagador: normTelefono(pago.telefonoPagador, 'Teléfono del pagador'),
    telefonoDestino: normTelefono(pago.telefonoDestino || cuenta?.api?.telefonoDestino, 'Teléfono destino (Pago Móvil de la empresa)'),
    referencia: normReferencia(pago.referencia),
    fechaPago: normFecha(pago.fechaPago),
    importe: normImporte(pago.importe),
    bancoOrigen: normBanco(pago.bancoOrigen),
  };
}

export const normalizarPago = armarSolicitud;

function configuracion(cuenta) {
  const api = cuenta?.api || {};
  const ambiente = api.ambiente === 'calidad' ? 'calidad' : 'produccion';
  const url = api.baseUrl?.trim() || ENDPOINTS[ambiente];
  const apiKey = api.apiKey || (ambiente === 'calidad' ? API_KEY_CALIDAD : '');
  if (!apiKey) throw new BdvError(`La cuenta ${cuenta?.alias || ''} no tiene API Key del BDV (Ajustes → Bancos).`);
  return { url, apiKey, ambiente };
}

/**
 * Llama al BDV. Devuelve { confirmado, codigo, mensaje, montoBanco, solicitud, ambiente }.
 * Lanza BdvError solo por problemas de conexión, credenciales o datos de entrada.
 */
export async function consultarPago(cuenta, pago, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const { url, apiKey, ambiente } = configuracion(cuenta);
  const solicitud = armarSolicitud(pago, cuenta);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify(solicitud),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const code = err.cause?.code || err.name;
    const tls = /CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(String(code));
    throw new BdvError(
      tls
        ? `El certificado del BDV no es reconocido por este equipo (${code}). Instala la cadena de certificados del banco y arranca con NODE_EXTRA_CA_CERTS.`
        : code === 'TimeoutError'
          ? 'El BDV no respondió a tiempo. Intenta de nuevo en unos minutos.'
          : `No se pudo conectar con el BDV (${url}): ${code || err.message}`,
      { tipo: 'conexion' },
    );
  }

  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    throw new BdvError('El BDV rechazó la API Key (no autorizada). Verifica la clave generada en BDVenLínea Empresas.', { tipo: 'credenciales', http: res.status });
  }
  if (res.status === 400 || body?.status === 400) {
    throw new BdvError('El BDV rechazó el formato de la solicitud (400 Bad Request).', { tipo: 'formato', http: 400, detalle: body });
  }
  if (!res.ok || !body || typeof body.code === 'undefined') {
    throw new BdvError(`Respuesta inesperada del BDV (HTTP ${res.status}).`, { tipo: 'respuesta', http: res.status, detalle: body });
  }

  const codigo = Number(body.code);
  const confirmado = codigo === 1000;
  const montoBanco = body.data?.amount != null ? parseAmount(String(body.data.amount)) : null;
  const montoCoincide = montoBanco == null || Math.abs(montoBanco - Number(solicitud.importe)) < 0.005;
  return {
    confirmado: confirmado && montoCoincide,
    codigo,
    mensaje: confirmado && !montoCoincide ? `El banco confirma el pago pero por ${montoBanco}, no por ${solicitud.importe}.` : body.message || body.data?.reason || '',
    montoBanco,
    solicitud,
    ambiente,
  };
}

/**
 * Prueba la conexión y la API Key con un pago ficticio.
 * La respuesta esperada es code 1010 "Registro solicitado no existe": significa que la clave fue aceptada.
 */
export async function probar(cuenta, opciones = {}) {
  const hoy = new Date().toISOString().slice(0, 10);
  const telefonoDestino = cuenta?.api?.telefonoDestino;
  try {
    const r = await consultarPago(
      cuenta,
      { cedulaPagador: 'V1000000', telefonoPagador: '04120000000', telefonoDestino: telefonoDestino || '04120000000', referencia: '000000', fechaPago: hoy, importe: '0.01', bancoOrigen: '0102' },
      opciones,
    );
    const avisoTel = telefonoDestino ? '' : ' Falta configurar el teléfono Pago Móvil de la empresa.';
    return {
      ok: !avisoTel,
      mensaje: `BDV (${r.ambiente}): conexión y API Key aceptadas (respuesta ${r.codigo}: ${r.mensaje}).${avisoTel}`,
    };
  } catch (err) {
    return { ok: false, mensaje: `BDV: ${err.message}` };
  }
}
