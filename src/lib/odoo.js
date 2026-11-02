// Cliente JSON-RPC para la API externa de Odoo (funciona con contraseña o con API Key).
// Documentación: https://www.odoo.com/documentation/17.0/developer/reference/external_api.html

export function normalizeOdooUrl(url) {
  if (!url) return '';
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}`;
}

/** En odoo.sh / odoo.com la base de datos suele llamarse igual que el subdominio. */
export function guessDbFromUrl(url) {
  try {
    const host = new URL(normalizeOdooUrl(url)).hostname;
    if (/\.odoo\.com$/i.test(host)) return host.split('.')[0];
  } catch {
    /* ignorar */
  }
  return '';
}

export class OdooError extends Error {}

export class OdooClient {
  constructor({ url, db, username, secret }, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
    this.base = normalizeOdooUrl(url);
    this.db = db || guessDbFromUrl(url);
    this.username = username;
    this.secret = secret;
    this.uid = null;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async rpc(service, method, args) {
    if (!this.base) throw new OdooError('Falta la URL de Odoo en Ajustes.');
    let res;
    try {
      res = await this.fetch(`${this.base}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new OdooError(`No se pudo conectar con ${this.base}: ${err.cause?.code || err.message}`);
    }
    if (!res.ok) throw new OdooError(`Odoo respondió HTTP ${res.status} en ${this.base}/jsonrpc`);
    const body = await res.json();
    if (body.error) {
      const msg = body.error.data?.message || body.error.message || 'Error desconocido';
      throw new OdooError(`Odoo: ${msg}`);
    }
    return body.result;
  }

  version() {
    return this.rpc('common', 'version', []);
  }

  async listDatabases() {
    try {
      return await this.rpc('db', 'list', []);
    } catch {
      return null; // odoo.sh suele tener el listado deshabilitado
    }
  }

  async authenticate() {
    if (!this.db) throw new OdooError('Falta el nombre de la base de datos de Odoo.');
    if (!this.username || !this.secret) throw new OdooError('Faltan usuario o clave/API Key de Odoo.');
    const uid = await this.rpc('common', 'authenticate', [this.db, this.username, this.secret, {}]);
    if (!uid) throw new OdooError('Usuario o clave de Odoo incorrectos (o la base de datos no es la correcta).');
    this.uid = uid;
    return uid;
  }

  async call(model, method, args = [], kwargs = {}) {
    if (!this.uid) await this.authenticate();
    return this.rpc('object', 'execute_kw', [this.db, this.uid, this.secret, model, method, args, kwargs]);
  }

  async whoAmI() {
    const [user] = await this.call('res.users', 'read', [[this.uid]], { fields: ['name', 'login', 'company_id', 'company_ids'] });
    return user;
  }

  bankJournals() {
    return this.call('account.journal', 'search_read', [[['type', 'in', ['bank', 'cash']]]], {
      fields: ['id', 'name', 'code', 'type', 'currency_id', 'bank_acc_number', 'company_id'],
      order: 'name',
    });
  }

  /** Líneas ya existentes en el diario para esas fechas (para evitar duplicados). */
  existingLines(journalId, dates) {
    return this.call(
      'account.bank.statement.line',
      'search_read',
      [[['journal_id', '=', journalId], ['date', 'in', dates]]],
      { fields: ['id', 'date', 'payment_ref', 'ref', 'amount'] },
    );
  }

  /**
   * Crea un extracto (account.bank.statement) con sus líneas en una sola transacción.
   * lines: [{ date:'YYYY-MM-DD', etiqueta, referencia, importe, narration }]
   */
  async createStatement({ journalId, name, lines, balanceEnd }) {
    const vals = {
      name,
      line_ids: lines.map((l) => [
        0,
        0,
        {
          journal_id: journalId,
          date: l.date,
          payment_ref: l.etiqueta || false,
          ref: l.referencia || false,
          amount: l.importe,
          narration: l.narration || false,
        },
      ]),
    };
    if (typeof balanceEnd === 'number') vals.balance_end_real = balanceEnd;
    const id = await this.call('account.bank.statement', 'create', [vals]);
    return Array.isArray(id) ? id[0] : id;
  }
}
