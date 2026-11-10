import './lib/env.js';
import crypto from 'node:crypto';
import express from 'express';
import { PUBLIC_DIR } from './lib/paths.js';
import { loadSettings, saveSettings, maskSettings, mergeIncoming, loadHistory, defaultSettings } from './lib/store.js';
import { OdooClient, guessDbFromUrl, normalizeOdooUrl } from './lib/odoo.js';
import { TelegramClient } from './lib/telegram.js';
import { BANCOS, MODOS, nuevaCuenta } from './bancos/catalogo.js';
import { DATOS_MANUAL_QA } from './bancos/banesco.js';
import { DATOS_MANUAL_CALIDAD } from './bancos/bdv.js';
import { probarCuenta, capacidades, consultarSaldo } from './bancos/conectores.js';
import { ejecutarSincronizacion, iniciarProgramador, estadoAutomatizacion } from './automatizacion/diaria.js';
import { verificarPago, cuentasVerificables, historialVerificaciones } from './cobranza/verificador.js';
import { analizar, analizarDesdeBanco, rangoPendiente, obtenerAnalisis, excelDe, subirAOdoo, enviarATelegram } from './conciliador/servicio.js';
import { todayIn } from './conciliador/reglas.js';
import { reiniciarBot, estadoBot } from './telegram/bot.js';

const app = express();
const PORT = Number(process.env.PORT) || 3900;
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Protección opcional del panel con usuario/clave (ADMIN_USER / ADMIN_PASSWORD en .env).
if (process.env.ADMIN_PASSWORD) {
  const user = process.env.ADMIN_USER || 'admin';
  const esperado = Buffer.from(`${user}:${process.env.ADMIN_PASSWORD}`);
  app.use((req, res, next) => {
    const [tipo, valor] = (req.headers.authorization || '').split(' ');
    const recibido = tipo === 'Basic' ? Buffer.from(valor || '', 'base64') : Buffer.alloc(0);
    if (recibido.length === esperado.length && crypto.timingSafeEqual(recibido, esperado)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Conciliador"');
    res.status(401).send('Autenticación requerida');
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

const ruta = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[${req.method} ${req.path}]`, err.message);
    res.status(err.status || 400).json({ error: err.message });
  });

// ---------------- Ajustes ----------------

app.get('/api/ajustes', ruta((req, res) => res.json(maskSettings(loadSettings()))));

app.put('/api/ajustes', ruta(async (req, res) => {
  const actual = loadSettings();
  const entrada = mergeIncoming(req.body || {}, actual);
  const nuevo = { ...defaultSettings(), ...actual, ...entrada };
  if (nuevo.odoo.url) nuevo.odoo.url = normalizeOdooUrl(nuevo.odoo.url);
  if (nuevo.odoo.url && !nuevo.odoo.db) nuevo.odoo.db = guessDbFromUrl(nuevo.odoo.url);
  nuevo.telegram.adminChatIds = (nuevo.telegram.adminChatIds || []).map((x) => String(x).trim()).filter(Boolean);
  saveSettings(nuevo);
  const telegramCambio = JSON.stringify(actual.telegram) !== JSON.stringify(nuevo.telegram);
  if (telegramCambio) await reiniciarBot();
  res.json(maskSettings(nuevo));
}));

// Agrega o actualiza UNA cuenta sin tocar las demás (útil para cargar claves desde la terminal del propio equipo).
app.post('/api/cuentas', ruta(async (req, res) => {
  const entrada = req.body || {};
  if (!entrada.banco) throw new Error('Falta el código del banco (ej. "0102").');
  const s = loadSettings();
  const id = entrada.id || `cta_${crypto.randomBytes(4).toString('hex')}`;
  const previa = s.cuentas.find((c) => c.id === id);
  const base = previa || { ...nuevaCuenta(entrada.banco), id };
  const unida = mergeIncoming({ ...base, ...entrada, id, api: { ...base.api, ...(entrada.api || {}) } }, previa || base);
  s.cuentas = previa ? s.cuentas.map((c) => (c.id === id ? unida : c)) : [...s.cuentas, unida];
  saveSettings(s);
  res.json(maskSettings(unida));
}));

app.get('/api/catalogo', (req, res) => res.json({ bancos: BANCOS, modos: MODOS, cuentaNueva: nuevaCuenta(), presets: { '0134': DATOS_MANUAL_QA, '0102': DATOS_MANUAL_CALIDAD } }));

// ---------------- Odoo ----------------

app.post('/api/odoo/probar', ruta(async (req, res) => {
  const s = loadSettings();
  const odoo = new OdooClient(s.odoo, { timeoutMs: 20000 });
  const pasos = [];
  const version = await odoo.version();
  pasos.push(`Servidor Odoo ${version.server_version} accesible`);
  await odoo.authenticate();
  pasos.push(`Sesión iniciada en la base "${odoo.db}" (uid ${odoo.uid})`);
  const yo = await odoo.whoAmI();
  const diarios = await odoo.bankJournals();
  pasos.push(`${diarios.length} diario(s) de banco/caja encontrados`);
  res.json({ ok: true, version: version.server_version, db: odoo.db, usuario: yo, diarios, pasos });
}));

app.get('/api/odoo/diarios', ruta(async (req, res) => {
  const odoo = new OdooClient(loadSettings().odoo);
  res.json(await odoo.bankJournals());
}));

// ---------------- Telegram ----------------

app.post('/api/telegram/probar', ruta(async (req, res) => {
  const s = loadSettings();
  const tg = new TelegramClient(s.telegram.token);
  const me = await tg.getMe();
  const envios = [];
  for (const chat of s.telegram.adminChatIds || []) {
    try {
      await tg.sendMessage(chat, '✅ <b>Conciliador Náutica</b>: conexión de prueba correcta.');
      envios.push({ chat, ok: true });
    } catch (err) {
      envios.push({ chat, ok: false, error: err.message });
    }
  }
  res.json({ ok: true, bot: me.username, envios, estado: estadoBot() });
}));

// ---------------- Bancos ----------------

app.post('/api/bancos/:id/probar', ruta(async (req, res) => {
  const cuenta = loadSettings().cuentas.find((c) => c.id === req.params.id);
  if (!cuenta) throw new Error('Cuenta no encontrada; guarda los ajustes primero.');
  res.json(await probarCuenta(cuenta));
}));

app.get('/api/bancos/:id/saldo', ruta(async (req, res) => {
  const cuenta = loadSettings().cuentas.find((c) => c.id === req.params.id);
  if (!cuenta) throw new Error('Cuenta no encontrada.');
  res.json(await consultarSaldo(cuenta));
}));

// ---------------- Automatización diaria ----------------

app.get('/api/automatizacion', ruta((req, res) => res.json(estadoAutomatizacion())));

app.post('/api/automatizacion/ejecutar', ruta(async (req, res) => {
  res.json(await ejecutarSincronizacion({ disparo: 'panel', cuentaId: req.body?.cuentaId || null }));
}));

// ---------------- Cobranza: verificación de pagos ----------------

app.get('/api/cobranza/cuentas', ruta((req, res) => {
  res.json(cuentasVerificables().map((c) => ({ id: c.id, alias: c.alias, banco: c.banco, ambiente: c.api?.ambiente || 'produccion', telefonoDestino: c.api?.telefonoDestino || '' })));
}));

app.post('/api/cobranza/verificar', ruta(async (req, res) => {
  const { cuentaId, ...pago } = req.body || {};
  res.json(await verificarPago({ cuentaId, pago, usuario: 'panel', canal: 'panel' }));
}));

app.get('/api/cobranza/historial', ruta((req, res) => res.json(historialVerificaciones())));

// ---------------- Conciliación ----------------

app.post(
  '/api/conciliacion/analizar',
  express.raw({ type: '*/*', limit: '20mb' }),
  ruta(async (req, res) => {
    const { cuentaId, archivo } = req.query;
    if (!req.body?.length) throw new Error('No llegó ningún archivo.');
    res.json(await analizar(req.body, String(archivo || 'estado_de_cuenta'), String(cuentaId || '')));
  }),
);

app.post('/api/conciliacion/banco', ruta(async (req, res) => {
  const { cuentaId, desde, hasta } = req.body || {};
  res.json(await analizarDesdeBanco(String(cuentaId || ''), desde && hasta ? { desde, hasta } : {}));
}));

app.get('/api/conciliacion/rango/:cuentaId', ruta((req, res) => {
  res.json(rangoPendiente(req.params.cuentaId, todayIn(loadSettings().empresa.zonaHoraria)));
}));

app.get('/api/conciliacion/:id', ruta((req, res) => res.json(obtenerAnalisis(req.params.id))));

app.get('/api/conciliacion/:id/excel/:date', ruta(async (req, res) => {
  const { buffer, nombre } = await excelDe(req.params.id, req.params.date);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(buffer);
}));

app.post('/api/conciliacion/:id/odoo', ruta(async (req, res) => {
  const { fechas = [], forzar = false } = req.body || {};
  res.json(await subirAOdoo(req.params.id, fechas, { forzar: Boolean(forzar), usuario: 'panel' }));
}));

app.post('/api/conciliacion/:id/telegram', ruta(async (req, res) => {
  res.json({ enviados: await enviarATelegram(req.params.id, req.body?.fechas || []) });
}));

// ---------------- Estado / historial ----------------

app.get('/api/estado', ruta((req, res) => {
  const s = loadSettings();
  const todo = loadHistory();
  const hist = todo.filter((h) => h.tipo === 'odoo');
  const verif = todo.filter((h) => h.tipo === 'verificacion');
  res.json({
    odoo: { configurado: Boolean(s.odoo.url && s.odoo.username && s.odoo.secret), url: s.odoo.url, db: s.odoo.db },
    telegram: { configurado: Boolean(s.telegram.token), habilitado: s.telegram.enabled, admins: s.telegram.adminChatIds.length, bot: estadoBot() },
    cuentas: s.cuentas.map((c) => ({
      id: c.id,
      alias: c.alias,
      banco: c.banco,
      modo: c.modo,
      diario: c.diarioOdooNombre,
      capacidades: capacidades(c.banco),
      verificaPagos: capacidades(c.banco).verificarPago && Boolean(c.api?.apiKey || c.api?.clientSecret || c.api?.ambiente === 'calidad'),
      ultimoDia: hist.find((h) => h.tipo === 'odoo' && h.ok && h.cuentaId === c.id)?.dia || null,
    })),
    historial: hist.slice(0, 15),
    automatizacion: estadoAutomatizacion(),
    verificaciones: {
      hoy: verif.filter((v) => v.fecha.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
      confirmadas: verif.filter((v) => v.estado === 'confirmado').length,
      reutilizados: verif.filter((v) => v.estado === 'reutilizado').length,
    },
  });
}));

app.get('/api/historial', ruta((req, res) => res.json(loadHistory().filter((h) => h.tipo === 'odoo'))));

// Primera vez: deja creadas las cuentas BDV y Banesco para que sus campos de API estén a la vista.
(function crearCuentasBase() {
  const s = loadSettings();
  if (s.cuentasBaseCreadas) return;
  const base = [
    { ...nuevaCuenta('0102'), id: 'cta_bdv', alias: 'BDV NAUTICA' },
    { ...nuevaCuenta('0134'), id: 'cta_banesco', alias: 'BANESCO', modo: 'api' },
  ];
  for (const c of base) if (!s.cuentas.some((x) => x.banco === c.banco)) s.cuentas.push(c);
  s.cuentasBaseCreadas = true;
  saveSettings(s);
})();

iniciarProgramador();

app.listen(PORT, HOST, async () => {
  console.log(`\n  🧾 Conciliador Náutica listo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  try {
    const bot = await reiniciarBot();
    if (bot.activo) console.log(`  🤖 Bot de Telegram activo: @${bot.usuario}`);
    else if (bot.error) console.log(`  ⚠️  Bot de Telegram: ${bot.error}`);
  } catch (err) {
    console.log(`  ⚠️  ${err.message}`);
  }
});
