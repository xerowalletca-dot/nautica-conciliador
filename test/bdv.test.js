import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conciliador-bdv-'));
process.env.APP_SECRET = 'clave-de-prueba';

const bdv = await import('../src/bancos/bdv.js');
const store = await import('../src/lib/store.js');
const { verificarPago, leerComandoPago } = await import('../src/cobranza/verificador.js');

const cuenta = { id: 'bdv1', alias: 'BDV NAUTICA', banco: '0102', activa: true, api: { ambiente: 'produccion', apiKey: 'CLAVE-PRUEBA-0001', telefonoDestino: '0412 714 1363' } };
const pago = { cedulaPagador: 'v-27.037.606', telefonoPagador: '+58 412-7141363', referencia: '123112313', fechaPago: '12/02/2023', importe: '120,00', bancoOrigen: '102' };

/** fetch simulado que responde como el manual del BDV y guarda lo que se le envió. */
function bancoFalso(respuesta, http = 200) {
  const llamadas = [];
  const fetchImpl = async (url, opts) => {
    llamadas.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return { status: http, ok: http >= 200 && http < 300, json: async () => (typeof respuesta === 'function' ? respuesta(JSON.parse(opts.body)) : respuesta) };
  };
  return { fetchImpl, llamadas };
}

const OK_1000 = (b) => ({ code: 1000, message: `Monto: ${b.importe} - estatus : Transaccion realizada`, data: { status: '1000', amount: b.importe, reason: 'Transaccion realizada' }, status: 200 });
const NO_EXISTE = { code: 1010, message: 'No se pudo validar el movimiento: Registro solicitado no existe', data: null, status: 200 };

test('normaliza los datos al formato exacto del manual', () => {
  assert.deepEqual(bdv.armarSolicitud(pago, cuenta), {
    cedulaPagador: 'V27037606',
    telefonoPagador: '04127141363',
    telefonoDestino: '04127141363',
    referencia: '123112313',
    fechaPago: '2023-02-12',
    importe: '120.00',
    bancoOrigen: '0102',
  });
  assert.equal(bdv.normImporte('1.250,50'), '1250.50');
  assert.equal(bdv.normCedula('E 81234567'), 'E81234567');
  assert.equal(bdv.normCedula('12345678'), 'V12345678');
  assert.throws(() => bdv.normTelefono('0212123456'), /celular de 11 dígitos/);
  assert.throws(() => bdv.normFecha('2023/31/31'), /Fecha inválida/);
  assert.throws(() => bdv.normImporte('0'), /Monto inválido/);
});

test('envía POST con X-API-Key al endpoint de producción y confirma el código 1000', async () => {
  const { fetchImpl, llamadas } = bancoFalso(OK_1000);
  const r = await bdv.consultarPago(cuenta, pago, { fetchImpl });
  assert.equal(r.confirmado, true);
  assert.equal(r.codigo, 1000);
  assert.equal(r.montoBanco, 120);
  assert.equal(llamadas[0].url, 'https://bdvconciliacion.banvenez.com:443/getMovement');
  assert.equal(llamadas[0].headers['X-API-Key'], 'CLAVE-PRUEBA-0001');
  assert.equal(llamadas[0].headers['Content-Type'], 'application/json');
  assert.equal(llamadas[0].body.importe, '120.00');
});

test('ambiente de calidad usa el endpoint y la clave pública del manual', async () => {
  const { fetchImpl, llamadas } = bancoFalso(OK_1000);
  await bdv.consultarPago({ ...cuenta, api: { ambiente: 'calidad', telefonoDestino: '04127141363' } }, pago, { fetchImpl });
  assert.equal(llamadas[0].url, 'http://200.11.243.176:444/getMovement');
  assert.equal(llamadas[0].headers['X-API-Key'], bdv.API_KEY_CALIDAD);
});

test('código 1010: el pago no existe', async () => {
  const { fetchImpl } = bancoFalso(NO_EXISTE);
  const r = await bdv.consultarPago(cuenta, pago, { fetchImpl });
  assert.equal(r.confirmado, false);
  assert.equal(r.codigo, 1010);
  assert.match(r.mensaje, /no existe/);
});

test('si el banco confirma otro monto, NO se da por confirmado', async () => {
  const { fetchImpl } = bancoFalso({ code: 1000, message: 'ok', data: { status: '1000', amount: '12.00', reason: 'Transaccion realizada' }, status: 200 });
  const r = await bdv.consultarPago(cuenta, pago, { fetchImpl });
  assert.equal(r.confirmado, false);
  assert.match(r.mensaje, /por 12/);
});

test('errores: 400 de contrato, clave rechazada, sin API Key', async () => {
  await assert.rejects(
    bdv.consultarPago(cuenta, pago, bancoFalso({ timestamp: 'x', path: '/getMovement', status: 400, error: 'Bad Request', requestId: 'c7' }, 400)),
    /formato de la solicitud/,
  );
  await assert.rejects(bdv.consultarPago(cuenta, pago, bancoFalso({}, 401)), /rechazó la API Key/);
  await assert.rejects(bdv.consultarPago({ ...cuenta, api: { telefonoDestino: '04127141363' } }, pago), /no tiene API Key/);
});

test('probar(): un 1010 con datos ficticios significa que la clave fue aceptada', async () => {
  const r = await bdv.probar(cuenta, bancoFalso(NO_EXISTE));
  assert.equal(r.ok, true);
  assert.match(r.mensaje, /API Key 1 aceptadas/);
  const sinTel = await bdv.probar({ ...cuenta, api: { ...cuenta.api, telefonoDestino: '' } }, bancoFalso(NO_EXISTE));
  assert.equal(sinTel.ok, false);
  assert.match(sinTel.mensaje, /teléfono Pago Móvil/);
});

test('dos API Keys de la misma empresa: si el BDV rechaza la primera, usa la segunda', async () => {
  const usadas = [];
  const fetchImpl = async (url, opts) => {
    usadas.push(opts.headers['X-API-Key']);
    if (opts.headers['X-API-Key'] === 'CLAVE-VIEJA') return { status: 401, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => OK_1000(JSON.parse(opts.body)) };
  };
  const dos = { ...cuenta, api: { ...cuenta.api, apiKey: 'CLAVE-VIEJA', apiKey2: 'CLAVE-BUENA' } };
  const r = await bdv.consultarPago(dos, pago, { fetchImpl });
  assert.equal(r.confirmado, true);
  assert.equal(r.claveUsada, 2);
  assert.deepEqual(usadas, ['CLAVE-VIEJA', 'CLAVE-BUENA']);
  await assert.rejects(bdv.consultarPago({ ...dos, api: { ...dos.api, apiKey2: 'CLAVE-VIEJA' } }, pago, { fetchImpl }), /rechazó la API Key/);
});

test('verificador: confirma una vez y bloquea el comprobante reutilizado', async () => {
  const s = store.defaultSettings();
  s.cuentas = [cuenta];
  store.saveSettings(s);
  const { fetchImpl, llamadas } = bancoFalso(OK_1000);

  const r1 = await verificarPago({ cuentaId: '', pago, usuario: 'cobranza' }, { fetchImpl });
  assert.equal(r1.estado, 'confirmado');

  // mismo pago, referencia escrita con ceros a la izquierda: igual se detecta
  const r2 = await verificarPago({ cuentaId: 'BDV NAUTICA', pago: { ...pago, referencia: '000123112313' }, usuario: 'otra' }, { fetchImpl });
  assert.equal(r2.estado, 'reutilizado');
  assert.match(r2.mensaje, /YA fue verificado/);
  assert.equal(llamadas.length, 1, 'el segundo intento no debe ni consultar al banco');

  const hist = store.loadHistory().filter((h) => h.tipo === 'verificacion');
  assert.deepEqual(hist.map((h) => h.estado), ['reutilizado', 'confirmado']);
});

test('comando de Telegram /pago', () => {
  const r = leerComandoPago('/pago V12345678 04141234567 123456 10/11/2026 1.250,00 0102 NAUTICA');
  assert.deepEqual(r, {
    pago: { cedulaPagador: 'V12345678', telefonoPagador: '04141234567', referencia: '123456', fechaPago: '10/11/2026', importe: '1.250,00', bancoOrigen: '0102' },
    cuentaId: 'NAUTICA',
  });
  assert.throws(() => leerComandoPago('/pago V1 0414'), /Formato/);
});
