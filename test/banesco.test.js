import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conciliador-banesco-'));
process.env.APP_SECRET = 'clave-de-prueba';

const banesco = await import('../src/bancos/banesco.js');
const store = await import('../src/lib/store.js');
const { analizarDesdeBanco, rangoPendiente } = await import('../src/conciliador/servicio.js');
const { verificarPago } = await import('../src/cobranza/verificador.js');
const { ejecutarSincronizacion } = await import('../src/automatizacion/diaria.js');
const { leerArgumentos, intencion } = await import('../src/telegram/consultas.js');

const cuenta = {
  id: 'ban1',
  alias: 'BANESCO',
  banco: '0134',
  numero: '0134-0804-10-8041005394',
  modo: 'api',
  activa: true,
  sincronizar: true,
  referenciaLargo: 11,
  comision: { porcentaje: 0.3, ratioMaximo: 1, palabrasClave: ['COMISION'] },
  api: {
    ambiente: 'produccion',
    clientId: 'cli123',
    clientSecret: 'sec456',
    rif: 'J-50044931-3',
    usuarioBanesco: 'NAUTICAEMP',
    tokenUrl: 'https://sso.banesco.test/token',
    saldoUrl: 'https://api.banesco.test/customer/products',
    movimientosUrl: 'https://api.banesco.test/transactions/confirm',
    ipPublica: '181.225.47.130',
  },
};

// Movimientos simulados por día, en el formato de "transactionDetail" del manual
const MOVS = {
  '2026-11-07': [
    { referenceNumber: '62931833923', amount: 127754.63, currencyCode: 'BS ', trnDate: '2026-11-07', trnTime: '10:01:00', concept: 'PAGO MOVIL         ', customerIdBen: 'V025753821', trnType: 'DB' },
    { referenceNumber: '62931833923', amount: 383.26, currencyCode: 'BS ', trnDate: '2026-11-07', trnTime: '10:01:01', concept: 'COMISION PAGO MOVIL', customerIdBen: '', trnType: 'DB' },
  ],
  '2026-11-08': [],
  '2026-11-09': [
    { referenceNumber: '00024655439', amount: 4464.04, currencyCode: 'BS ', trnDate: '2026-11-09', trnTime: '08:30:00', concept: 'PPV 0108', customerIdBen: 'J309269577', trnType: 'CR' },
    { referenceNumber: '99914186486', amount: 1250.0, currencyCode: 'BS ', trnDate: '2026-11-09', trnTime: '09:15:00', concept: 'PAGO MOVIL INTERB', customerIdBen: 'V012345678', trnType: 'CR' },
  ],
  '2026-11-10': [{ referenceNumber: '11111111111', amount: 50, trnDate: '2026-11-10', trnTime: '07:00:00', concept: 'HOY', customerIdBen: '', trnType: 'CR' }],
};

let llamadas = [];
function instalarBanco() {
  llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const headers = opts.headers || {};
    llamadas.push({ url, headers, body: opts.body });
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (url === cuenta.api.tokenUrl) {
      const esperado = `Basic ${Buffer.from('cli123:sec456').toString('base64')}`;
      if (headers.Authorization !== esperado) return json(401, { error: 'invalid_client' });
      return json(200, { access_token: 'TOKEN-JWT', expires_in: 180, token_type: 'bearer' });
    }
    if (headers.Authorization !== 'Bearer TOKEN-JWT') return json(401, { httpStatus: null, dataResponse: null });
    const body = JSON.parse(opts.body);
    if (url === cuenta.api.saldoUrl) {
      return json(200, { httpStatus: { statusCode: '200', statusDesc: 'OK' }, dataResponse: [{ accountId: '0134************5394', accountType: 'DDA', balance: 45201.21 }] });
    }
    if (url === cuenta.api.movimientosUrl) {
      const t = body.dataRequest.transaction;
      let lista;
      if (t.startDt && t.endDt) lista = MOVS[t.startDt] || [];
      else lista = Object.values(MOVS).flat().filter((m) => m.referenceNumber.endsWith(t.referenceNumber));
      if (!lista.length) return json(400, { httpStatus: { statusCode: '70001', statusDesc: 'Consulta sin resultados' }, dataResponse: null });
      return json(200, { httpStatus: { statusCode: '200', statusDesc: 'OK' }, dataResponse: { transactionDetail: lista } });
    }
    return json(404, {});
  };
}

beforeEach(() => {
  banesco.olvidarTokens();
  instalarBanco();
  const s = store.defaultSettings();
  s.cuentas = [cuenta];
  store.saveSettings(s);
});

test('token OAuth: Basic base64(clientId:secret) + client_credentials, y se reutiliza', async () => {
  await banesco.obtenerToken(cuenta);
  await banesco.obtenerToken(cuenta);
  const tokenCalls = llamadas.filter((l) => l.url === cuenta.api.tokenUrl);
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].body, 'grant_type=client_credentials&client_id=cli123');
  assert.equal(tokenCalls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('credenciales malas → error claro', async () => {
  await assert.rejects(banesco.obtenerToken({ ...cuenta, api: { ...cuenta.api, clientSecret: 'mal' } }), /rechazó las credenciales OAuth/);
});

test('saldo: envía fintechid, idNumber, idType y username', async () => {
  const s = await banesco.consultarSaldo(cuenta);
  assert.deepEqual(s, [{ cuenta: '0134************5394', tipo: 'DDA', saldo: 45201.21 }]);
  const h = llamadas.at(-1).headers;
  assert.deepEqual([h.fintechid, h.idNumber, h.idType, h.username], ['cli123', '500449313', 'J', 'NAUTICAEMP']);
});

test('movimientos: consulta día por día, 70001 = día vacío, CR positivo y DB negativo', async () => {
  const m = await banesco.obtenerMovimientos(cuenta, '2026-11-07', '2026-11-09');
  assert.equal(m.length, 4);
  assert.deepEqual(m.map((x) => x.amount), [-127754.63, -383.26, 4464.04, 1250]);
  assert.equal(m[1].description, 'COMISION PAGO MOVIL');
  assert.equal(m[0].description, 'PAGO MOVIL V025753821');
  const tx = JSON.parse(llamadas.at(-1).body).dataRequest.transaction;
  assert.equal(tx.accountId, '01340804108041005394');
  assert.equal(tx.startDt, '2026-11-09');
  assert.equal(llamadas.filter((l) => l.url === cuenta.api.movimientosUrl).length, 3);
});

test('extracto desde la API: comisión detectada, fin de semana y día en curso en espera', async () => {
  const a = await analizarDesdeBanco('ban1', { desde: '2026-11-07', hasta: '2026-11-10', ahora: new Date('2026-11-10T15:00:00Z') });
  assert.deepEqual(a.dias.map((d) => [d.fecha, d.estado]), [
    ['07/11/2026', 'listo'],
    ['09/11/2026', 'listo'],
    ['10/11/2026', 'esperar'],
  ]);
  const com = a.dias[0].lineas[1];
  assert.equal(com.etiqueta, 'COMISIÓN BANCARIA');
  assert.equal(com.importe, -383.26);
});

test('rango pendiente: sin historial = ayer; con historial = día siguiente al último hasta ayer', () => {
  assert.deepEqual(rangoPendiente('ban1', '2026-11-10'), { desde: '2026-11-09', hasta: '2026-11-09' });
  store.addHistory({ tipo: 'odoo', ok: true, cuentaId: 'ban1', dia: '2026-11-06' });
  assert.deepEqual(rangoPendiente('ban1', '2026-11-10'), { desde: '2026-11-07', hasta: '2026-11-09' });
});

test('verificación Banesco: pago móvil interbancario por últimos 6 dígitos + teléfono', async () => {
  const r = await verificarPago({ cuentaId: 'BANESCO', pago: { cedulaPagador: '', telefonoPagador: '04141234567', referencia: '4186486', fechaPago: '09/11/2026', importe: '1.250,00', bancoOrigen: '0102' } });
  assert.equal(r.estado, 'confirmado');
  const tx = JSON.parse(llamadas.at(-1).body).dataRequest.transaction;
  assert.deepEqual(tx, { referenceNumber: '186486', startDt: '2026-11-09', phoneNum: '584141234567', bankId: '0102' });

  const otra = await verificarPago({ cuentaId: 'BANESCO', pago: { telefonoPagador: '04141234567', referencia: '186486', fechaPago: '09/11/2026', importe: '1.250,00', bancoOrigen: '0102' } });
  assert.equal(otra.estado, 'reutilizado');
});

test('verificación Banesco: monto distinto y referencia inexistente', async () => {
  const mal = await verificarPago({ cuentaId: 'BANESCO', pago: { referencia: '00024655439', fechaPago: '09/11/2026', importe: '9999', bancoOrigen: '0134' } });
  assert.equal(mal.estado, 'no_encontrado');
  assert.match(mal.mensaje, /por Bs 4464.04/);
  const nada = await verificarPago({ cuentaId: 'BANESCO', pago: { referencia: '55555555555', fechaPago: '09/11/2026', importe: '10', bancoOrigen: '0134' } });
  assert.equal(nada.estado, 'no_encontrado');
});

test('sincronización completa (sin Telegram ni Odoo configurados)', async () => {
  const r = await ejecutarSincronizacion({ disparo: 'prueba', ahora: new Date('2026-11-10T15:00:00Z') });
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, true);
  // la prueba anterior dejó el 06/11 como cargado: trae del 07 al 09 (sábado, domingo y lunes)
  assert.deepEqual(r[0].rango, { desde: '2026-11-07', hasta: '2026-11-09' });
  assert.match(r[0].mensaje, /2 día\(s\), 2 listo/);
  assert.equal(store.loadHistory()[0].tipo, 'automatizacion');
});

test('Telegram: lee cuenta y fechas de la consulta, y entiende frases', () => {
  const s = store.loadSettings();
  const a = leerArgumentos('/movimientos banesco 07/11/2026 ayer', s, 'movimientos');
  assert.equal(a.cuentas[0].id, 'ban1');
  assert.deepEqual(a.fechas, ['2026-11-07', 'ayer']);
  assert.equal(intencion('cuál es el saldo de banesco?'), '/saldo');
  assert.equal(intencion('qué movimientos hubo ayer'), '/movimientos');
  assert.equal(intencion('hola'), null);
});
