// Lectura de estados de cuenta (XLSX, CSV o TXT) con detección automática de columnas.
// Devuelve movimientos normalizados: { date:'YYYY-MM-DD', ref, description, amount, balance, fila }

import ExcelJS from 'exceljs';

export function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Orden = prioridad. La primera coincidencia gana.
const ROLES = {
  date: [/^fecha$/, /^fecha (de )?(operacion|transaccion|movimiento)/, /^fecha/, /^date$/],
  ref: [/^referencia$/, /^ref\.?$/, /^(nro|num|numero|n°|no)\.? ?(de )?ref/, /referencia/, /^documento$/, /^(nro|num|numero)\.? ?(de )?doc/, /^reference$/],
  description: [/^descripcion$/, /^concepto$/, /^narration$/, /descripcion/, /concepto/, /^detalle/, /^movimiento$/, /^etiqueta$/],
  amount: [/^importe$/, /^monto$/, /^monto (bs|ves)/, /^importe/, /^amount$/],
  debit: [/^debitos?$/, /^cargos?$/, /^debe$/, /^retiros?$/, /^egresos?$/, /debito/, /cargo/],
  credit: [/^creditos?$/, /^abonos?$/, /^haber$/, /^depositos?$/, /^ingresos?$/, /credito/, /abono/],
  balance: [/^saldo$/, /^saldo (disponible|contable|final)/, /^balance$/, /saldo/],
  type: [/^tipo$/, /^tipo (de )?mov/, /^d\/c$/, /^signo$/],
};

export function detectColumns(headerCells) {
  const headers = headerCells.map(norm);
  const used = new Set();
  const map = {};
  for (const [role, patterns] of Object.entries(ROLES)) {
    outer: for (const re of patterns) {
      for (let i = 0; i < headers.length; i++) {
        if (!used.has(i) && headers[i] && re.test(headers[i])) {
          map[role] = i;
          used.add(i);
          break outer;
        }
      }
    }
  }
  return map;
}

function isHeaderRow(cells) {
  const m = detectColumns(cells);
  return m.date !== undefined && m.description !== undefined && (m.amount !== undefined || (m.debit !== undefined && m.credit !== undefined));
}

/** Convierte montos "1.234.567,89", "-1,234.56", "(383,26)", "383,26-", "Bs. 1.500" a número. */
export function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object' && 'result' in v) return parseAmount(v.result); // fórmula de Excel
  let s = String(v).trim().replace(/bs\.?s?|ves|\s/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    s = (s.match(/,/g).length === 1 && decimals !== 3) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0) {
    // "1.500" y "1.500.000" son miles (formato venezolano); "4464.04" es decimal.
    const decimals = s.length - lastDot - 1;
    if (s.match(/\./g).length > 1 || decimals === 3) s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Fechas: Date de Excel, serial de Excel, "dd/mm/yyyy", "dd-mm-yy", "yyyy-mm-dd". Siempre día/mes (Venezuela). */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === 'object' && 'result' in v) return parseDate(v.result);
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  return null;
}

function valid(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? iso(y, m, d) : null;
}

export function parseRef(v, largo = 0) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'result' in v) v = v.result;
  let s = typeof v === 'number' ? String(Math.trunc(v)) : String(v).trim();
  s = s.replace(/^'+/, '');
  if (largo > 0 && /^\d+$/.test(s) && s.length < largo) s = s.padStart(largo, '0');
  return s;
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
  }
  return String(v);
}

// ---------------- Lectores ----------------

async function rowsFromXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals = row.values.slice(1).map((v) => (v && typeof v === 'object' && 'richText' in v ? cellText(v) : v));
      rows[n - 1] = vals;
    });
    sheets.push({ name: ws.name, rows: Array.from(rows, (r) => r || []) });
  });
  return sheets;
}

function splitDelimited(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === delim && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function rowsFromText(buffer) {
  let text = buffer.toString('utf8');
  if (text.includes('�')) text = buffer.toString('latin1');
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const sample = lines.slice(0, 40).join('\n');
  const delims = [';', '\t', '|', ','];
  const delim = delims.map((d) => [d, (sample.match(new RegExp(d === '|' ? '\\|' : d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  return [{ name: 'texto', rows: lines.map((l) => (l.trim() ? splitDelimited(l, delim) : [])) }];
}

/**
 * Lee el archivo y devuelve { movimientos, columnas, hoja, filaEncabezado, advertencias }.
 * opciones.referenciaLargo: rellena referencias numéricas con ceros a la izquierda.
 */
export async function parseStatement(buffer, filename = '', opciones = {}) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'xls') {
    throw new Error('El formato .xls (Excel 97-2003) no está soportado todavía: ábrelo en Excel y guárdalo como .xlsx o .csv.');
  }
  if (ext === 'pdf') throw new Error('Los estados de cuenta en PDF aún no están soportados: descarga la versión Excel/TXT del banco.');
  const isZip = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const sheets = isZip || ext === 'xlsx' ? await rowsFromXlsx(buffer) : rowsFromText(buffer);

  for (const sheet of sheets) {
    const limit = Math.min(sheet.rows.length, 40);
    for (let h = 0; h < limit; h++) {
      const header = (sheet.rows[h] || []).map(cellText);
      if (!isHeaderRow(header)) continue;
      const cols = detectColumns(header);
      const movimientos = [];
      const advertencias = [];
      for (let r = h + 1; r < sheet.rows.length; r++) {
        const row = sheet.rows[r] || [];
        if (!row.some((c) => c !== null && c !== undefined && String(cellText(c)).trim() !== '')) continue;
        const date = parseDate(row[cols.date]);
        const description = cellText(row[cols.description]).replace(/\s+/g, ' ').trim();
        let amount = null;
        if (cols.amount !== undefined) {
          amount = parseAmount(row[cols.amount]);
          const tipo = cols.type !== undefined ? norm(cellText(row[cols.type])) : '';
          if (amount !== null && amount > 0 && /^(d|db|deb|debito|cargo|-)$/.test(tipo)) amount = -amount;
        }
        if (amount === null && (cols.debit !== undefined || cols.credit !== undefined)) {
          const deb = cols.debit !== undefined ? parseAmount(row[cols.debit]) : null;
          const cre = cols.credit !== undefined ? parseAmount(row[cols.credit]) : null;
          if (deb) amount = -Math.abs(deb);
          else if (cre) amount = Math.abs(cre);
          else if (deb === 0 || cre === 0) amount = 0;
        }
        if (!date) {
          // Filas de totales, saldo inicial, pie de página, etc.
          if (description || amount) advertencias.push(`Fila ${r + 1} ignorada (sin fecha válida): "${description || cellText(row[cols.date])}"`);
          continue;
        }
        if (amount === null) {
          advertencias.push(`Fila ${r + 1} ignorada (monto ilegible): "${description}"`);
          continue;
        }
        if (amount === 0) continue;
        movimientos.push({
          date,
          ref: parseRef(cols.ref !== undefined ? row[cols.ref] : '', opciones.referenciaLargo || 0),
          description,
          amount: Math.round(amount * 100) / 100,
          balance: cols.balance !== undefined ? parseAmount(row[cols.balance]) : null,
          fila: r + 1,
        });
      }
      const columnas = Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, header[i]]));
      return { movimientos, columnas, hoja: sheet.name, filaEncabezado: h + 1, advertencias };
    }
  }
  throw new Error(
    'No encontré la fila de encabezados. El archivo debe tener columnas de Fecha, Descripción/Concepto y Monto (o Débito y Crédito).',
  );
}
