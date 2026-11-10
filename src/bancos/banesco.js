// Conector Banesco (APIs empresariales sobre Red Hat 3scale + SSO OAuth 2.0).
//
//  · "Consulta de Cuenta" (374-TICPN-03)            → saldos de las cuentas.
//  · "Confirmación de Transacciones" (464-TICPN-01) → movimientos por rango de fechas (extracto diario)
//                                                     y verificación de pagos por referencia.
//
// Autenticación: POST tokenUrl con "Authorization: Basic base64(clientId:clientSecret)" y grant_type=client_credentials
// (o grant_type=password si se configuran usuario y clave OAuth). El token dura ~180 s: se cachea y se renueva solo.
// Banesco exige registrar la IP pública del equipo que consume las APIs.

import crypto from 'node:crypto';
import { normCedula, normTelefono, normFecha, normImporte, normBanco, BdvError } from './bdv.js';

export const AMBIENTES = {
  calidad: {
    tokenUrl: 'https://sso-sso-project.apps.desplakur3.desintra.banesco.com/auth/realms/realm-api-qa/protocol/openid-connect/token',
    saldoUrl: 'https://api-consultas-cuentas-transacciones-api-qa-apicast-production.apps.desplakur3.desintra.banesco.com/customer/products',
    movimientosUrl: '',
  },
  produccion: { tokenUrl: '', saldoUrl: '', movimientosUrl: '' }, // Banesco las entrega junto con las credenciales
};

// Valores de ejemplo del ambiente de Calidad tal como aparecen en el manual 374-TICPN-03 (tabla V1 y pág. 8).
// Sirven para probar la conexión de punta a punta; las credenciales reales de la empresa las asigna Banesco.
export const DATOS_MANUAL_QA = {
  ambiente: 'calidad',
  tokenUrl: AMBIENTES.calidad.tokenUrl,
  saldoUrl: AMBIENTES.calidad.saldoUrl,
  clientId: '3fd65d14',
  clientSecret: '34ec3e365a42bd3b3ff16bf13b6d2568',
  scope: '',
  rif: 'J-316489384',
  usuarioBanesco: 'AVILAEXPR',
};

export class BanescoError extends BdvError {}

const tokens = new Map(); // cache: clave -> { token, vence }

function cfg(cuenta) {
  const api = cuenta?.api || {};
  const ambiente = api.ambiente === 'calidad' ? 'calidad' : 'produccion';
  const base = AMBIENTES[ambiente];
  const c = {
    ambiente,
    tokenUrl: api.tokenUrl?.trim() || base.tokenUrl,
    saldoUrl: api.saldoUrl?.trim() || base.saldoUrl,
    movimientosUrl: api.movimientosUrl?.trim() || base.movimientosUrl,
    clientId: api.clientId?.trim() || '',
    clientSecret: api.clientSecret || '',
    scope: api.scope?.trim() || '',
    usuario: api.usuarioBanesco?.trim() || '',
    password: api.password || '',
    rif: String(api.rif || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    ip: api.ipPublica?.trim() || '127.0.0.1',
  };
  if (!c.tokenUrl) throw new BanescoError(`Falta la URL de token (SSO) de Banesco en la cuenta ${cuenta?.alias || ''}.`);
  if (!c.clientId || !c.clientSecret) throw new BanescoError(`Faltan Client ID / Client Secret de Banesco en la cuenta ${cuenta?.alias || ''}.`);
  return c;
}

function dispositivo(c) {
  return { type: 'Servidor', description: 'Conciliador Nautica', ipAddress: c.ip };
}

async function llamar(fetchImpl, url, opts, timeoutMs = 30000) {
  try {
    return await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = err.cause?.code || err.name;
    throw new BanescoError(
      code === 'TimeoutError' ? 'Banesco no respondió a tiempo.' : `No se pudo conectar con Banesco (${new URL(url).host}): ${code || err.message}`,
      { tipo: 'conexion' },
    );
  }
}

export async function obtenerToken(cuenta, { fetchImpl = fetch } = {}) {
  const c = cfg(cuenta);
  const clave = `${c.tokenUrl}|${c.clientId}|${c.usuario}`;
  const cache = tokens.get(clave);
  if (cache && cache.vence > Date.now()) return cache.token;

  const form = new URLSearchParams();
  if (c.usuario && c.password) {
    form.set('grant_type', 'password');
    form.set('username', c.usuario);
    form.set('password', c.password);
  } else {
    form.set('grant_type', 'client_credentials');
  }
  form.set('client_id', c.clientId); // tabla V4 del manual: payload client_id
  if (c.scope) form.set('scope', c.scope);
  const res = await llamar(fetchImpl, c.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new BanescoError(`Banesco rechazó las credenciales OAuth (HTTP ${res.status}${body.error_description ? `: ${body.error_description}` : body.error ? `: ${body.error}` : ''}).`, { tipo: 'credenciales', http: res.status });
  }
  const vida = Math.max(20, Number(body.expires_in) || 180);
  tokens.set(clave, { token: body.access_token, vence: Date.now() + (vida - 15) * 1000 });
  return body.access_token;
}

export function olvidarTokens() {
  tokens.clear();
}

const MENSAJES = {
  VDE01: 'Falta un dato obligatorio en la consulta.',
  VDE02: 'Un dato de la consulta tiene un valor no permitido.',
  VRN01: 'Banesco no validó el perfil del cliente (revisa RIF, usuario y permisos de la aplicación).',
  VRN04: 'El servicio de Banesco está en horario de mantenimiento.',
  VRN05: 'Banesco reporta referencia duplicada.',
  VRN06: 'Banesco reporta datos no disponibles.',
  70005: 'Se superó el límite de registros de Banesco para la consulta.',
};

async function postApi(cuenta, url, payload, headersExtra = {}, { fetchImpl = fetch } = {}) {
  const token = await obtenerToken(cuenta, { fetchImpl });
  const res = await llamar(fetchImpl, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...headersExtra },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  const codigo = String(body?.httpStatus?.statusCode ?? res.status);
  return { http: res.status, codigo, desc: body?.httpStatus?.statusDesc || '', body };
}

function errorApi(r, contexto) {
  if (r.http === 401) return new BanescoError(`${contexto}: no autorizado (${MENSAJES[r.codigo] || 'token o credenciales inválidas'}).`, { tipo: 'credenciales', codigo: r.codigo });
  return new BanescoError(`${contexto}: ${MENSAJES[r.codigo] || r.desc || `error HTTP ${r.http}`} [${r.codigo}]`, { tipo: 'respuesta', codigo: r.codigo });
}

// ---------------- Saldos (Consulta de Cuenta) ----------------

export async function consultarSaldo(cuenta, opciones = {}) {
  const c = cfg(cuenta);
  if (!c.saldoUrl) throw new BanescoError('Falta la URL de la API de Consulta de Cuenta (saldos) de Banesco.');
  const m = c.rif.match(/^([VEJGP])(\d+)$/);
  if (!m) throw new BanescoError('Configura el RIF de la empresa (ej. J-12345678-9) en la cuenta de Banesco.');
  if (!c.usuario) throw new BanescoError('Configura el usuario de Banesco Online de la empresa en la cuenta de Banesco.');
  const r = await postApi(
    cuenta,
    c.saldoUrl,
    { dataRequest: { device: { ...dispositivo(c), sid: crypto.randomUUID() } } },
    { fintechid: c.clientId, idNumber: m[2], idType: m[1], username: c.usuario },
    opciones,
  );
  if (r.codigo !== '200' || !Array.isArray(r.body?.dataResponse)) throw errorApi(r, 'Consulta de saldo');
  return r.body.dataResponse.map((x) => ({ cuenta: x.accountId, tipo: x.accountType, saldo: Number(x.balance) }));
}

// ---------------- Movimientos (Confirmación de Transacciones · rango de fechas) ----------------

const esCredito = (t) => /^(CR|C|CREDITO|ABONO)$/i.test(String(t || '').trim());

/** Convierte un transactionDetail de Banesco al movimiento normalizado del conciliador. */
export function aMovimiento(t, i = 0) {
  const monto = Math.abs(Number(t.amount) || 0);
  const concepto = String(t.concept || '').replace(/\s+/g, ' ').trim();
  const contraparte = String(t.customerIdBen || '').trim();
  return {
    date: String(t.trnDate || '').slice(0, 10),
    hora: t.trnTime || '',
    ref: String(t.referenceNumber ?? '').trim(),
    description: [concepto, contraparte].filter(Boolean).join(' '),
    amount: Math.round((esCredito(t.trnType) ? monto : -monto) * 100) / 100,
    balance: null,
    fila: i + 1,
    tipo: t.trnType,
  };
}

function diasEntre(desde, hasta) {
  const out = [];
  const d = new Date(`${desde}T00:00:00Z`);
  const fin = new Date(`${hasta}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(fin) || d > fin) throw new BanescoError('Rango de fechas inválido.');
  while (d <= fin) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (out.length > 31) throw new BanescoError('Banesco permite consultar máximo 30 días por vez.');
  return out;
}

/** Trae los movimientos día por día (evita el límite de registros por consulta). */
export async function obtenerMovimientos(cuenta, desde, hasta, opciones = {}) {
  const c = cfg(cuenta);
  if (!c.movimientosUrl) throw new BanescoError('Falta la URL de la API de Confirmación de Transacciones de Banesco (Ajustes → Bancos).');
  const numero = String(cuenta.numero || '').replace(/\D/g, '');
  if (numero.length !== 20) throw new BanescoError(`La cuenta ${cuenta.alias} necesita su número de 20 dígitos para consultar movimientos.`);
  const todos = [];
  for (const dia of diasEntre(desde, hasta)) {
    const r = await postApi(
      cuenta,
      c.movimientosUrl,
      {
        dataRequest: {
          device: dispositivo(c),
          securityAuth: { sessionId: '' },
          transaction: { referenceNumber: '', amount: 0.0, accountId: numero, startDt: dia, endDt: dia, phoneNum: '', bankId: '' },
        },
      },
      {},
      opciones,
    );
    if (r.codigo === '70001') continue; // día sin movimientos
    if (r.codigo !== '200') throw errorApi(r, `Movimientos del ${dia}`);
    const lista = r.body?.dataResponse?.transactionDetail || [];
    for (const t of lista) todos.push(aMovimiento(t, todos.length));
  }
  // orden cronológico estable
  return todos.sort((a, b) => (a.date + a.hora).localeCompare(b.date + b.hora) || a.fila - b.fila).map((m, i) => ({ ...m, fila: i + 1 }));
}

// ---------------- Verificación de pagos (Confirmación de Transacciones · por referencia) ----------------

/** Normaliza el pago reportado por el cliente. Para Banesco la cédula es opcional. */
export function normalizarPago(pago) {
  const referencia = String(pago.referencia ?? '').replace(/\D/g, '');
  if (referencia.length < 4) throw new BanescoError('La referencia debe tener al menos los últimos 6 dígitos.');
  return {
    cedulaPagador: pago.cedulaPagador ? normCedula(pago.cedulaPagador) : '',
    telefonoPagador: pago.telefonoPagador ? normTelefono(pago.telefonoPagador, 'Teléfono del pagador') : '',
    referencia,
    fechaPago: normFecha(pago.fechaPago),
    importe: normImporte(pago.importe),
    bancoOrigen: normBanco(pago.bancoOrigen || '0134'),
  };
}

/** Elige la modalidad de búsqueda del manual según los datos disponibles. */
export function armarBusqueda(s, cuenta) {
  const ult6 = s.referencia.slice(-6);
  if (s.bancoOrigen === '0134' && s.referencia.length >= 10) {
    return { modalidad: 'referencia completa', transaction: { referenceNumber: s.referencia } };
  }
  if (s.telefonoPagador) {
    return {
      modalidad: 'pago móvil (últimos 6 + teléfono)',
      transaction: { referenceNumber: ult6, startDt: s.fechaPago, phoneNum: `58${s.telefonoPagador.slice(1)}`, bankId: s.bancoOrigen },
    };
  }
  const numero = String(cuenta.numero || '').replace(/\D/g, '');
  if (numero.length !== 20) throw new BanescoError('Para verificar una transferencia sin teléfono, la cuenta necesita su número de 20 dígitos.');
  return { modalidad: 'transferencia (últimos 6 + cuenta)', transaction: { referenceNumber: ult6, accountId: numero, startDt: s.fechaPago, bankId: s.bancoOrigen } };
}

export async function consultarPago(cuenta, pago, opciones = {}) {
  const c = cfg(cuenta);
  if (!c.movimientosUrl) throw new BanescoError('Falta la URL de la API de Confirmación de Transacciones de Banesco (Ajustes → Bancos).');
  const solicitud = normalizarPago(pago);
  const { modalidad, transaction } = armarBusqueda(solicitud, cuenta);
  const r = await postApi(cuenta, c.movimientosUrl, { dataRequest: { device: dispositivo(c), securityAuth: { sessionId: '' }, transaction } }, {}, opciones);
  if (r.codigo === '70001') {
    return { confirmado: false, codigo: r.codigo, mensaje: `Banesco no encuentra la transacción (${modalidad}).`, montoBanco: null, solicitud, ambiente: c.ambiente };
  }
  if (r.codigo !== '200') throw errorApi(r, 'Verificación de pago');
  const lista = (r.body?.dataResponse?.transactionDetail || []).map(aMovimiento);
  const candidatos = lista.filter((m) => m.amount > 0 && m.ref.replace(/^0+/, '').endsWith(solicitud.referencia.slice(-6)));
  const exacto = candidatos.find((m) => Math.abs(m.amount - Number(solicitud.importe)) < 0.005);
  if (exacto) {
    return { confirmado: true, codigo: r.codigo, mensaje: `Transacción encontrada: ${exacto.description} · ${exacto.date} ${exacto.hora}`.trim(), montoBanco: exacto.amount, solicitud, ambiente: c.ambiente, detalle: exacto };
  }
  const otro = candidatos[0];
  return {
    confirmado: false,
    codigo: r.codigo,
    mensaje: otro ? `Banesco tiene esa referencia pero por Bs ${otro.amount.toFixed(2)}, no por ${solicitud.importe}.` : `Banesco respondió sin una transacción que coincida (${modalidad}).`,
    montoBanco: otro?.amount ?? null,
    solicitud,
    ambiente: c.ambiente,
  };
}

// ---------------- Prueba de conexión ----------------

export async function probar(cuenta, opciones = {}) {
  const partes = [];
  let ok = true;
  try {
    await obtenerToken(cuenta, opciones);
    partes.push('token OAuth ✔');
  } catch (err) {
    return { ok: false, mensaje: `Banesco: ${err.message}` };
  }
  const c = cfg(cuenta);
  if (c.saldoUrl && c.rif && c.usuario) {
    try {
      const s = await consultarSaldo(cuenta, opciones);
      partes.push(`saldos ✔ (${s.length} cuenta(s))`);
    } catch (err) {
      ok = false;
      partes.push(`saldos ✖ ${err.message}`);
    }
  } else partes.push('saldos: falta URL, RIF o usuario Banesco Online');
  if (c.movimientosUrl && String(cuenta.numero || '').replace(/\D/g, '').length === 20) {
    try {
      const hoy = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10);
      const m = await obtenerMovimientos(cuenta, hoy, hoy, opciones);
      partes.push(`movimientos ✔ (${m.length} hoy)`);
    } catch (err) {
      ok = false;
      partes.push(`movimientos ✖ ${err.message}`);
    }
  } else {
    ok = false;
    partes.push('movimientos: falta URL de Confirmación de Transacciones o el número de cuenta de 20 dígitos');
  }
  return { ok, mensaje: `Banesco (${c.ambiente}): ${partes.join(' · ')}` };
}
