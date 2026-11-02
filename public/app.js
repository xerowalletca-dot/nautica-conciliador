// Panel del Conciliador Náutica (vanilla JS, sin build).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const bs = (n) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n ?? 0);
const fecha = (iso) => iso.split('-').reverse().join('/');

const state = { ajustes: null, catalogo: null, analisis: null, diarios: null };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
  return data;
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

function toast(msg, kind = 'ok', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

async function conCarga(btn, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${btn.textContent.trim()}`;
  try {
    return await fn();
  } catch (err) {
    toast(`❌ ${esc(err.message)}`, 'bad', 8000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

const bancoNombre = (codigo) => state.catalogo?.bancos.find((b) => b.codigo === codigo)?.nombre || codigo;

// ================= Router =================
const vistas = { panel: cargarPanel, conciliar: cargarConciliar, historial: cargarHistorial, ajustes: cargarAjustes };
function router() {
  const vista = (location.hash || '#panel').slice(1);
  const v = vistas[vista] ? vista : 'panel';
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  vistas[v]().catch((err) => toast(`❌ ${esc(err.message)}`, 'bad'));
}
window.addEventListener('hashchange', router);

// ================= Panel =================
async function cargarPanel() {
  const e = await api('/api/estado');
  const bot = e.telegram.bot;
  const tarjetas = [
    {
      label: 'Odoo',
      dot: e.odoo.configurado ? 'ok' : 'warn',
      value: e.odoo.configurado ? 'Configurado' : 'Pendiente',
      sub: e.odoo.url ? `${e.odoo.url.replace(/^https?:\/\//, '')}${e.odoo.db ? ` · ${e.odoo.db}` : ''}` : 'Ajustes → Odoo',
    },
    {
      label: 'Bot de Telegram',
      dot: bot.activo ? 'ok' : e.telegram.configurado ? 'bad' : 'warn',
      value: bot.activo ? `@${bot.usuario}` : e.telegram.configurado ? (e.telegram.habilitado ? 'Con error' : 'Apagado') : 'Pendiente',
      sub: bot.error ? bot.error : `${e.telegram.admins} chat(s) de administración`,
    },
    {
      label: 'Cuentas bancarias',
      dot: e.cuentas.length ? 'ok' : 'warn',
      value: e.cuentas.length,
      sub: e.cuentas.length ? e.cuentas.map((c) => c.alias).join(' · ') : 'Ajustes → Bancos',
    },
    {
      label: 'Última carga a Odoo',
      dot: e.historial.find((h) => h.tipo === 'odoo' && h.ok) ? 'ok' : '',
      value: (() => {
        const h = e.historial.find((x) => x.tipo === 'odoo' && x.ok);
        return h ? fecha(h.dia) : '—';
      })(),
      sub: e.historial.find((x) => x.tipo === 'odoo' && x.ok)?.cuenta || 'Sin cargas todavía',
    },
  ];
  $('#status-cards').innerHTML = tarjetas
    .map((t) => `<div class="card stat"><div class="label">${esc(t.label)}</div><div class="value"><span class="dot ${t.dot}"></span>${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`)
    .join('');

  $('#panel-cuentas').innerHTML = e.cuentas.length
    ? e.cuentas
        .map(
          (c) => `<div class="list-item"><div class="bank-logo">${esc(c.banco)}</div><div class="grow"><b>${esc(c.alias)}</b><div class="muted small">${esc(bancoNombre(c.banco))} · ${c.modo === 'api' ? 'API' : 'Archivo'} · ${c.diario ? `Diario: ${esc(c.diario)}` : '<span class="negv">sin diario de Odoo</span>'}</div></div><div class="muted small">${c.ultimoDia ? `Último día: <b>${fecha(c.ultimoDia)}</b>` : 'Sin cargas'}</div></div>`,
        )
        .join('')
    : '<div class="empty">No hay cuentas. <a href="#ajustes">Agrega la primera →</a></div>';

  $('#panel-historial').innerHTML = e.historial.length
    ? e.historial
        .slice(0, 8)
        .map(
          (h) => `<div class="list-item"><span class="dot ${h.ok ? 'ok' : 'bad'}"></span><div class="grow"><b>${esc(h.cuenta)}</b> · ${fecha(h.dia)}<div class="muted small">${h.ok ? `${h.lineas} líneas → extracto #${h.statementId}` : esc(h.error)}</div></div><div class="muted small">${new Date(h.fecha).toLocaleString('es-VE')}</div></div>`,
        )
        .join('')
    : '<div class="empty">Aún no hay actividad.</div>';

  if (!state.ajustes) state.ajustes = await api('/api/ajustes');
  $('#regla-etiqueta').textContent = state.ajustes.reglas.etiquetaComision;
  $('#foot-status').innerHTML = `<div><span class="dot ${e.odoo.configurado ? 'ok' : 'warn'}"></span> Odoo</div><div><span class="dot ${bot.activo ? 'ok' : 'warn'}"></span> Telegram</div>`;
}

// ================= Conciliar =================
async function cargarConciliar() {
  state.ajustes = await api('/api/ajustes');
  const sel = $('#sel-cuenta');
  const previo = sel.value;
  const cuentas = state.ajustes.cuentas.filter((c) => c.activa !== false);
  sel.innerHTML = cuentas.length
    ? cuentas.map((c) => `<option value="${esc(c.id)}">${esc(c.alias)} — ${esc(bancoNombre(c.banco))}${c.numero ? ` …${esc(c.numero.slice(-4))}` : ''}</option>`).join('')
    : '<option value="">Primero agrega una cuenta en Ajustes → Bancos</option>';
  if (previo && cuentas.some((c) => c.id === previo)) sel.value = previo;
  if (state.analisis) pintarAnalisis();
}

function initDrop() {
  const drop = $('#drop');
  const input = $('#file');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && subirArchivo(e.dataTransfer.files[0]));
  input.addEventListener('change', () => input.files[0] && subirArchivo(input.files[0]));
}

async function subirArchivo(file) {
  const cuentaId = $('#sel-cuenta').value;
  if (!cuentaId) return toast('Primero configura una cuenta en Ajustes → Bancos.', 'warn');
  $('#resultado').innerHTML = '<div class="card"><span class="spinner"></span> Leyendo el estado de cuenta…</div>';
  try {
    state.analisis = await api(`/api/conciliacion/analizar?cuentaId=${encodeURIComponent(cuentaId)}&archivo=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    pintarAnalisis();
  } catch (err) {
    $('#resultado').innerHTML = `<div class="alert bad">❌ ${esc(err.message)}</div>`;
  } finally {
    $('#file').value = '';
  }
}

const ETIQUETAS = {
  listo: '<span class="tag ok">LISTO</span>',
  esperar: '<span class="tag warn">ESPERAR</span>',
  subido: '<span class="tag info">YA EN ODOO</span>',
};

function pintarAnalisis() {
  const a = state.analisis;
  const listos = a.dias.filter((d) => d.estado === 'listo');
  const totalMov = a.dias.reduce((s, d) => s + d.totales.movimientos, 0);
  const cols = Object.entries(a.columnas).map(([k, v]) => `<code>${esc(k)}: ${esc(v)}</code>`).join(' ');
  $('#resultado').innerHTML = `
    <div class="card">
      <div class="summary">
        <div>
          <h3 style="margin:0">${esc(a.cuenta.alias)} · ${esc(a.archivo)}</h3>
          <div class="muted small">${totalMov} movimientos en ${a.dias.length} día(s) · hoy es ${fecha(a.hoy)} · hoja "${esc(a.hoja)}", encabezado en fila ${a.filaEncabezado}</div>
          <div class="small" style="margin-top:6px">${cols}</div>
        </div>
        <div class="row gap">
          <button class="btn" id="btn-tg-todos" ${listos.length ? '' : 'disabled'}>✈ Enviar a Telegram</button>
          <button class="btn primary" id="btn-odoo-todos" ${listos.length ? '' : 'disabled'}>⇪ Subir ${listos.length} día(s) a Odoo</button>
        </div>
      </div>
      ${a.advertencias.length ? `<div class="alert warn"><b>⚠ ${a.advertencias.length} advertencia(s)</b><ul>${a.advertencias.slice(0, 20).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div id="dias">${a.dias.map(pintarDia).join('')}</div>
    </div>`;

  $('#btn-odoo-todos')?.addEventListener('click', (e) => subirOdoo(e.currentTarget, listos.map((d) => d.date)));
  $('#btn-tg-todos')?.addEventListener('click', (e) =>
    conCarga(e.currentTarget, async () => {
      const r = await api(`/api/conciliacion/${a.id}/telegram`, json('POST', { fechas: listos.map((d) => d.date) }));
      toast(`✈ Enviado a Telegram: ${r.enviados.map(esc).join(', ')}`);
    }),
  );
  $$('.day-head').forEach((h) => h.addEventListener('click', (e) => { if (!e.target.closest('.actions')) h.parentElement.classList.toggle('open'); }));
  $$('[data-subir]').forEach((b) => b.addEventListener('click', (e) => subirOdoo(e.currentTarget, [b.dataset.subir], b.dataset.forzar === '1')));
}

function pintarDia(d) {
  const a = state.analisis;
  const filas = d.lineas
    .map(
      (l) => `<tr class="${l.comision ? 'comision' : ''}" ${l.motivoComision ? `title="${esc(l.motivoComision)}"` : ''}>
        <td>${esc(l.fecha)}</td>
        <td class="wrap">${l.comision ? '<span class="tag warn">COMISIÓN</span> ' : ''}${esc(l.etiqueta)}</td>
        <td><code>${esc(l.referencia)}</code></td>
        <td class="num ${l.importe < 0 ? 'neg' : ''}">${bs(l.importe)}</td>
        <td class="wrap">${esc(l.narration)}</td>
      </tr>`,
    )
    .join('');
  const saldo = d.saldos?.disponible
    ? d.saldos.errores.length
      ? `<span class="tag bad">SALDO NO CUADRA (${d.saldos.errores.length})</span>`
      : `<span class="tag ok">SALDO CUADRA</span>`
    : '';
  const botonOdoo =
    d.estado === 'listo'
      ? `<button class="btn sm primary" data-subir="${d.date}">⇪ Odoo</button>`
      : d.estado === 'subido'
        ? `<button class="btn sm ghost" data-subir="${d.date}" data-forzar="1" title="Volver a subir aunque ya exista">↻ Forzar</button>`
        : '';
  return `<div class="day ${a.dias.length === 1 ? 'open' : ''}">
    <div class="day-head">
      <div class="date">${d.fecha}</div>
      ${ETIQUETAS[d.estado] || ''} ${saldo}
      <div class="kpis">
        <span>Mov <b>${d.totales.movimientos}</b></span>
        <span>Créditos <b class="pos">${bs(d.totales.creditos)}</b></span>
        <span>Débitos <b class="negv">${bs(d.totales.debitos)}</b></span>
        <span>Neto <b>${bs(d.totales.neto)}</b></span>
        ${d.totales.comisiones ? `<span>Comisiones <b>${d.totales.comisiones}</b></span>` : ''}
      </div>
      <div class="actions">
        <a class="btn sm" href="/api/conciliacion/${a.id}/excel/${d.date}">⤓ Excel</a>
        ${botonOdoo}
      </div>
    </div>
    ${d.motivo ? `<div class="motivo">${esc(d.motivo)}</div>` : ''}
    <div class="day-body"><div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Etiqueta</th><th>Referencia</th><th style="text-align:right">Importe</th><th>Narration</th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div></div>
  </div>`;
}

async function subirOdoo(btn, fechas, forzar = false) {
  if (forzar && !confirm('Este día ya se cargó a Odoo. ¿Seguro que quieres subirlo otra vez? Puede duplicar líneas.')) return;
  await conCarga(btn, async () => {
    const r = await api(`/api/conciliacion/${state.analisis.id}/odoo`, json('POST', { fechas, forzar }));
    for (const x of r) toast(`${x.ok ? '✅' : '❌'} ${fecha(x.date)}: ${esc(x.mensaje)}`, x.ok ? 'ok' : 'bad', 9000);
    state.analisis = await api(`/api/conciliacion/${state.analisis.id}`);
    pintarAnalisis();
  });
}

// ================= Historial =================
async function cargarHistorial() {
  const h = await api('/api/historial');
  $('#tabla-historial').innerHTML = h.length
    ? `<div class="table-wrap"><table><thead><tr><th>Cuándo</th><th>Cuenta</th><th>Día</th><th>Resultado</th><th>Líneas</th><th style="text-align:right">Neto</th><th>Archivo</th><th>Usuario</th></tr></thead><tbody>${h
        .map(
          (x) => `<tr><td>${new Date(x.fecha).toLocaleString('es-VE')}</td><td>${esc(x.cuenta)}</td><td>${fecha(x.dia)}</td>
            <td>${x.ok ? `<span class="tag ok">EXTRACTO #${esc(x.statementId)}</span>` : `<span class="tag bad" title="${esc(x.error)}">ERROR</span> <span class="muted small">${esc(x.error).slice(0, 80)}</span>`}</td>
            <td>${x.lineas ?? ''}</td><td class="num">${x.totales ? bs(x.totales.neto) : ''}</td><td>${esc(x.archivo)}</td><td>${esc(x.usuario)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<div class="empty">Todavía no se ha cargado nada a Odoo.</div>';
}

// ================= Ajustes =================
async function cargarAjustes() {
  state.ajustes = await api('/api/ajustes');
  const s = state.ajustes;
  $('#odoo-url').value = s.odoo.url;
  $('#odoo-db').value = s.odoo.db;
  $('#odoo-username').value = s.odoo.username;
  $('#odoo-secret').value = '';
  $('#odoo-secret').placeholder = s.odoo.secretGuardado ? 'Guardada — deja vacío para mantenerla' : '';
  $('#odoo-secret-hint').textContent = s.odoo.secretGuardado ? `🔒 Clave guardada (${s.odoo.secretPista})` : '';
  $('#tg-token').value = '';
  $('#tg-token').placeholder = s.telegram.tokenGuardado ? 'Guardado — deja vacío para mantenerlo' : '123456:ABC…';
  $('#tg-token-hint').textContent = s.telegram.tokenGuardado ? `🔒 Token guardado (${s.telegram.tokenPista})` : '';
  $('#tg-admins').value = (s.telegram.adminChatIds || []).join(', ');
  $('#tg-cobranza').value = s.telegram.cobranzaChatId || '';
  $('#tg-enabled').checked = Boolean(s.telegram.enabled);
  $('#r-etiqueta').value = s.reglas.etiquetaComision;
  $('#r-modo').value = s.reglas.modoEtiqueta;
  $('#r-tz').value = s.empresa.zonaHoraria;
  $('#r-hoy').checked = s.reglas.excluirHoy !== false;
  pintarCuentas();
}

function opcionesDiario(c) {
  const lista = state.diarios || (c.diarioOdooId ? [{ id: c.diarioOdooId, name: c.diarioOdooNombre }] : []);
  return `<option value="">— Sin asignar —</option>${lista
    .map((d) => `<option value="${d.id}" ${Number(c.diarioOdooId) === d.id ? 'selected' : ''}>${esc(d.name)}${d.code ? ` (${esc(d.code)})` : ''}${d.bank_acc_number ? ` · ${esc(d.bank_acc_number)}` : ''}</option>`)
    .join('')}`;
}

function pintarCuentas() {
  const cuentas = state.ajustes.cuentas;
  const bancos = state.catalogo.bancos;
  $('#lista-cuentas').innerHTML = cuentas.length
    ? cuentas
        .map(
          (c, i) => `<div class="cuenta" data-i="${i}">
      <div class="cuenta-head">
        <div class="bank-logo">${esc(c.banco)}</div>
        <div class="grow"><b>${esc(c.alias || 'Nueva cuenta')}</b><div class="muted small">${esc(bancoNombre(c.banco))} · ${c.modo === 'api' ? 'API' : 'Archivo'}</div></div>
        <label class="switch"><input type="checkbox" data-k="activa" ${c.activa !== false ? 'checked' : ''}/><span class="slider"></span><span class="small">Activa</span></label>
        <button class="btn sm" data-probar="${esc(c.id)}">⚡ Probar</button>
        <button class="btn sm danger" data-borrar="${i}">Eliminar</button>
      </div>
      <div class="cuenta-body">
        <div class="grid form">
          <label class="field"><span>Banco</span><select data-k="banco">${bancos.map((b) => `<option value="${b.codigo}" ${b.codigo === c.banco ? 'selected' : ''}>${b.codigo} · ${esc(b.nombre)}</option>`).join('')}</select></label>
          <label class="field"><span>Alias (nombre del archivo)</span><input data-k="alias" value="${esc(c.alias)}" /></label>
          <label class="field"><span>Número de cuenta</span><input data-k="numero" value="${esc(c.numero)}" placeholder="0134-…" /></label>
          <label class="field"><span>Moneda</span><select data-k="moneda">${['VES', 'USD', 'EUR'].map((m) => `<option ${m === c.moneda ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
          <label class="field span2"><span>Diario de banco en Odoo</span>
            <div class="row gap"><select data-k="diarioOdooId" class="grow">${opcionesDiario(c)}</select><button class="btn sm" data-diarios>↻ Cargar de Odoo</button></div>
          </label>
          <label class="field"><span>Modo de obtención</span><select data-k="modo">${Object.entries(state.catalogo.modos).map(([k, v]) => `<option value="${k}" ${k === c.modo ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
          <label class="field"><span>Largo de referencia (ceros a la izq.)</span><input type="number" min="0" max="30" data-k="referenciaLargo" value="${esc(c.referenciaLargo ?? 0)}" /></label>
        </div>
        <fieldset>
          <legend>Detección de comisiones</legend>
          <div class="grid form">
            <label class="field"><span>Porcentaje del banco (%)</span><input type="number" step="0.01" data-k="comision.porcentaje" value="${esc(c.comision?.porcentaje)}" /></label>
            <label class="field"><span>Máximo respecto al pago (%)</span><input type="number" step="0.1" data-k="comision.ratioMaximo" value="${esc(c.comision?.ratioMaximo)}" /></label>
            <label class="field span2"><span>Palabras clave en la descripción</span><input data-k="comision.palabrasClave" value="${esc((c.comision?.palabrasClave || []).join(', '))}" /></label>
          </div>
        </fieldset>
        <fieldset ${c.modo === 'api' ? '' : 'style="opacity:.6"'}>
          <legend>Credenciales API del banco</legend>
          <div class="grid form">
            ${(bancos.find((b) => b.codigo === c.banco)?.camposApi || [])
              .map((f) => {
                const guardado = c.api?.[`${f.key}Guardado`];
                return `<label class="field"><span>${esc(f.label)}</span><input data-k="api.${f.key}" ${f.tipo === 'secret' ? 'type="password" autocomplete="new-password"' : ''} value="${f.tipo === 'secret' ? '' : esc(c.api?.[f.key])}" placeholder="${f.tipo === 'secret' && guardado ? `Guardado ${esc(c.api[`${f.key}Pista`])}` : esc(f.placeholder || '')}" /></label>`;
              })
              .join('')}
          </div>
        </fieldset>
      </div>
    </div>`,
        )
        .join('')
    : '<div class="card empty">No hay cuentas configuradas. Agrega la primera (por ejemplo Banesco).</div>';

  $$('#lista-cuentas .cuenta').forEach((el) => {
    const c = cuentas[Number(el.dataset.i)];
    $$('[data-k]', el).forEach((inp) =>
      inp.addEventListener('change', () => {
        const val = inp.type === 'checkbox' ? inp.checked : inp.value;
        asignar(c, inp.dataset.k, val);
        if (inp.dataset.k === 'banco' || inp.dataset.k === 'modo') pintarCuentas();
      }),
    );
  });
  $$('[data-borrar]').forEach((b) =>
    b.addEventListener('click', () => {
      const c = cuentas[Number(b.dataset.borrar)];
      if (confirm(`¿Eliminar la cuenta ${c.alias}? (se aplica al guardar)`)) {
        cuentas.splice(Number(b.dataset.borrar), 1);
        pintarCuentas();
      }
    }),
  );
  $$('[data-probar]').forEach((b) =>
    b.addEventListener('click', () =>
      conCarga(b, async () => {
        const r = await api(`/api/bancos/${b.dataset.probar}/probar`, json('POST'));
        toast(`${r.ok ? '✅' : '⚠️'} ${esc(r.mensaje)}`, r.ok ? 'ok' : 'warn', 9000);
      }),
    ),
  );
  $$('[data-diarios]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      conCarga(b, async () => {
        state.diarios = await api('/api/odoo/diarios');
        toast(`✅ ${state.diarios.length} diario(s) cargados de Odoo`);
        pintarCuentas();
      });
    }),
  );
}

function asignar(obj, ruta, val) {
  const partes = ruta.split('.');
  const ult = partes.pop();
  const destino = partes.reduce((o, p) => (o[p] ??= {}), obj);
  if (ult === 'palabrasClave') val = val.split(',').map((x) => x.trim()).filter(Boolean);
  else if (['porcentaje', 'ratioMaximo', 'referenciaLargo'].includes(ult)) val = Number(val);
  else if (ult === 'diarioOdooId') {
    val = val ? Number(val) : null;
    const d = (state.diarios || []).find((x) => x.id === val);
    obj.diarioOdooNombre = d ? d.name : val ? obj.diarioOdooNombre : '';
  }
  destino[ult] = val;
}

function recogerAjustes() {
  const s = structuredClone(state.ajustes);
  s.odoo.url = $('#odoo-url').value.trim();
  s.odoo.db = $('#odoo-db').value.trim();
  s.odoo.username = $('#odoo-username').value.trim();
  s.odoo.secret = $('#odoo-secret').value;
  s.telegram.token = $('#tg-token').value.trim();
  s.telegram.adminChatIds = $('#tg-admins').value.split(',').map((x) => x.trim()).filter(Boolean);
  s.telegram.cobranzaChatId = $('#tg-cobranza').value.trim();
  s.telegram.enabled = $('#tg-enabled').checked;
  s.reglas.etiquetaComision = $('#r-etiqueta').value.trim() || 'COMISIÓN BANCARIA';
  s.reglas.modoEtiqueta = $('#r-modo').value;
  s.reglas.excluirHoy = $('#r-hoy').checked;
  s.empresa.zonaHoraria = $('#r-tz').value.trim() || 'America/Caracas';
  return s;
}

async function guardar() {
  state.ajustes = await api('/api/ajustes', json('PUT', recogerAjustes()));
  await cargarAjustes();
  toast('💾 Ajustes guardados y cifrados');
}

function initAjustes() {
  $$('#tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
    }),
  );
  $('#btn-guardar').addEventListener('click', (e) => conCarga(e.currentTarget, guardar));
  $('#btn-add-cuenta').addEventListener('click', () => {
    const nueva = structuredClone(state.catalogo.cuentaNueva);
    nueva.id = `cta_${Math.random().toString(36).slice(2, 10)}`;
    state.ajustes.cuentas.push(nueva);
    pintarCuentas();
    toast('Cuenta agregada: completa los datos y pulsa "Guardar cambios".', 'warn');
  });
  $('#btn-probar-odoo').addEventListener('click', (e) =>
    conCarga(e.currentTarget, async () => {
      await guardar();
      $('#odoo-result').innerHTML = '<div class="alert"><span class="spinner"></span> Conectando con Odoo…</div>';
      try {
        const r = await api('/api/odoo/probar', json('POST'));
        state.diarios = r.diarios;
        $('#odoo-result').innerHTML = `<div class="alert ok"><b>✅ Conectado como ${esc(r.usuario.name)}</b> (${esc(r.usuario.login)}) · Odoo ${esc(r.version)} · base <code>${esc(r.db)}</code>
          <ul class="steps">${r.pasos.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
          ${r.diarios.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>ID</th><th>Diario</th><th>Código</th><th>Tipo</th><th>Cuenta bancaria</th></tr></thead><tbody>${r.diarios.map((d) => `<tr><td>${d.id}</td><td>${esc(d.name)}</td><td>${esc(d.code)}</td><td>${esc(d.type)}</td><td>${esc(d.bank_acc_number || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        </div>`;
      } catch (err) {
        $('#odoo-result').innerHTML = `<div class="alert bad">❌ ${esc(err.message)}</div>`;
      }
    }),
  );
  $('#btn-probar-tg').addEventListener('click', (e) =>
    conCarga(e.currentTarget, async () => {
      await guardar();
      try {
        const r = await api('/api/telegram/probar', json('POST'));
        $('#tg-result').innerHTML = `<div class="alert ok"><b>✅ Bot @${esc(r.bot)}</b> ${r.estado.activo ? 'escuchando mensajes' : '(apagado: actívalo con el interruptor)'}<ul>${r.envios.map((x) => `<li>Chat ${esc(x.chat)}: ${x.ok ? 'mensaje enviado' : `❌ ${esc(x.error)}`}</li>`).join('') || '<li>Agrega al menos un chat de administración.</li>'}</ul></div>`;
      } catch (err) {
        $('#tg-result').innerHTML = `<div class="alert bad">❌ ${esc(err.message)}</div>`;
      }
    }),
  );
}

// ================= Inicio =================
(async function init() {
  state.catalogo = await api('/api/catalogo');
  initDrop();
  initAjustes();
  router();
})();
