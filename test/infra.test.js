import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conciliador-test-'));
process.env.APP_SECRET = 'clave-de-prueba';

const store = await import('../src/lib/store.js');
const { OdooClient, guessDbFromUrl, normalizeOdooUrl } = await import('../src/lib/odoo.js');

test('los ajustes se guardan cifrados y los secretos no salen al navegador', () => {
  const s = store.defaultSettings();
  s.odoo = { url: 'https://x.odoo.com', db: 'x', username: 'bot@x.com', secret: 'super-secreta-123' };
  s.cuentas = [{ id: 'c1', alias: 'BANESCO', api: { clientId: 'id', clientSecret: 'cs-987654' } }];
  store.saveSettings(s);
  const crudo = fs.readFileSync(path.join(process.env.DATA_DIR, 'ajustes.enc.json'), 'utf8');
  assert.ok(!crudo.includes('super-secreta-123'));
  assert.ok(!crudo.includes('bot@x.com'));
  assert.equal(store.loadSettings().odoo.secret, 'super-secreta-123');

  const m = store.maskSettings(store.loadSettings());
  assert.equal(m.odoo.secret, '');
  assert.equal(m.odoo.secretGuardado, true);
  assert.equal(m.odoo.secretPista, '••••••••');
  assert.equal(m.cuentas[0].api.clientSecret, '');
});

test('un secreto vacío mantiene el guardado; __BORRAR__ lo elimina', () => {
  const actual = store.loadSettings();
  const desdeNavegador = store.maskSettings(actual);
  desdeNavegador.odoo.username = 'otro@x.com';
  const unido = store.mergeIncoming(desdeNavegador, actual);
  assert.equal(unido.odoo.secret, 'super-secreta-123');
  assert.equal(unido.odoo.username, 'otro@x.com');
  assert.equal(unido.cuentas[0].api.clientSecret, 'cs-987654');
  assert.equal(unido.odoo.secretGuardado, undefined);

  desdeNavegador.odoo.secret = store.CLEAR;
  assert.equal(store.mergeIncoming(desdeNavegador, actual).odoo.secret, '');
});

test('historial evita doble carga del mismo día', () => {
  store.addHistory({ tipo: 'odoo', ok: true, cuentaId: 'c1', dia: '2026-10-20', statementId: 5 });
  assert.ok(store.alreadyUploaded('c1', '2026-10-20'));
  assert.equal(store.alreadyUploaded('c1', '2026-10-21'), undefined);
});

test('URL y base de datos de odoo.sh', () => {
  const url = 'https://somostuapoyogerencial-nautica-pruebas-dev-40705121.dev.odoo.com/odoo';
  assert.equal(normalizeOdooUrl(url), 'https://somostuapoyogerencial-nautica-pruebas-dev-40705121.dev.odoo.com');
  assert.equal(guessDbFromUrl(url), 'somostuapoyogerencial-nautica-pruebas-dev-40705121');
});

test('OdooClient: autentica y crea el extracto con sus líneas', async () => {
  const llamadas = [];
  const fakeFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    llamadas.push(body.params);
    const { service, method, args } = body.params;
    let result;
    if (service === 'common' && method === 'authenticate') result = args[2] === 'ok' ? 7 : false;
    else if (service === 'object') result = 99;
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  const bad = new OdooClient({ url: 'https://x.odoo.com', username: 'u', secret: 'mal' }, { fetchImpl: fakeFetch });
  await assert.rejects(bad.authenticate(), /incorrectos/);

  const odoo = new OdooClient({ url: 'https://x.odoo.com', username: 'u', secret: 'ok' }, { fetchImpl: fakeFetch });
  const id = await odoo.createStatement({
    journalId: 3,
    name: 'BANESCO 20/10/2026',
    lines: [{ date: '2026-10-20', etiqueta: 'COMISIÓN BANCARIA', referencia: '00012', importe: -383.26, narration: 'Banesco Pago Movil' }],
    balanceEnd: 100,
  });
  assert.equal(id, 99);
  const crear = llamadas.at(-1).args;
  assert.deepEqual(crear.slice(0, 5), ['x', 7, 'ok', 'account.bank.statement', 'create']);
  assert.deepEqual(crear[5][0].line_ids[0], [0, 0, { journal_id: 3, date: '2026-10-20', payment_ref: 'COMISIÓN BANCARIA', ref: '00012', amount: -383.26, narration: 'Banesco Pago Movil' }]);
  assert.equal(crear[5][0].balance_end_real, 100);
});
