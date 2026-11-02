import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseAmount, parseDate, parseRef, parseStatement, detectColumns } from '../src/conciliador/parser.js';
import { construirDias, detectarComisiones, todayIn } from '../src/conciliador/reglas.js';
import { excelDelDia, nombreArchivo } from '../src/conciliador/excel.js';

test('montos en formato venezolano e internacional', () => {
  assert.equal(parseAmount('1.234.567,89'), 1234567.89);
  assert.equal(parseAmount('-127.754,63'), -127754.63);
  assert.equal(parseAmount('(383,26)'), -383.26);
  assert.equal(parseAmount('383,26-'), -383.26);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('4464.04'), 4464.04);
  assert.equal(parseAmount('1.500'), 1500);
  assert.equal(parseAmount('Bs. 2.400.000,00'), 2400000);
  assert.equal(parseAmount(-42635107.88), -42635107.88);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
});

test('fechas siempre día/mes', () => {
  assert.equal(parseDate('20/10/2026'), '2026-10-20');
  assert.equal(parseDate('05-01-26'), '2026-01-05');
  assert.equal(parseDate('2026-10-20'), '2026-10-20');
  assert.equal(parseDate(new Date(Date.UTC(2026, 9, 20))), '2026-10-20');
  assert.equal(parseDate(46315), '2026-10-20'); // serial de Excel
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('SALDO INICIAL'), null);
});

test('referencias conservan / recuperan ceros a la izquierda', () => {
  assert.equal(parseRef('00024655439'), '00024655439');
  assert.equal(parseRef(24655439, 11), '00024655439');
  assert.equal(parseRef("'0500386", 0), '0500386');
});

test('detecta columnas aunque los encabezados varíen', () => {
  const m = detectColumns(['Fecha', 'Nro. Referencia', 'Descripción', 'Débito', 'Crédito', 'Saldo']);
  assert.deepEqual(m, { date: 0, ref: 1, description: 2, debit: 3, credit: 4, balance: 5 });
  const odoo = detectColumns(['Fecha', 'Etiqueta', 'Referencia', 'Importe', 'Narration']);
  assert.equal(odoo.description, 4);
});

test('comisión Banesco Pago Móvil: misma referencia y 0,3 %', () => {
  const movs = [
    { date: '2026-10-20', ref: '62931833923', description: 'Banesco Pago Movil', amount: -127754.63 },
    { date: '2026-10-20', ref: '62931833923', description: 'Banesco Pago Movil', amount: -383.26 },
    { date: '2026-10-20', ref: '00000000000', description: 'PRINCIPAL PYMNT 001', amount: -42635107.88 },
    { date: '2026-10-20', ref: '00000000000', description: 'INTEREST PYMNT LN001', amount: -378978.73 },
    { date: '2026-10-20', ref: '777', description: 'COMISION MANTENIMIENTO', amount: -50 },
  ];
  const c = detectarComisiones(movs, { porcentaje: 0.3, ratioMaximo: 1, palabrasClave: ['COMISION'] });
  assert.deepEqual([...c.keys()].sort(), [1, 4]);
  assert.match(c.get(1), /exactamente el 0.30 %/);
});

const base = [
  { date: '2026-10-20', ref: '00024655439', description: 'PPV J000000001 0108', amount: 4464.04, fila: 2 },
  { date: '2026-10-20', ref: '62931833923', description: 'Banesco Pago Movil', amount: -127754.63, fila: 3 },
  { date: '2026-10-20', ref: '62931833923', description: 'Banesco Pago Movil', amount: -383.26, fila: 4 },
  { date: '2026-10-21', ref: '11111111111', description: 'TRF CR INM 0105 J000000002 PRUEBA', amount: 1000, fila: 5 },
  { date: '2026-10-22', ref: '22222222222', description: 'MOVIMIENTO DE HOY', amount: -10, fila: 6 },
];
const cuenta = { comision: { porcentaje: 0.3, ratioMaximo: 1, palabrasClave: ['COMISION'] } };

test('un archivo por día y el día en curso queda en espera', () => {
  const { dias } = construirDias(base, { cuenta, reglas: {}, hoy: '2026-10-22' });
  assert.deepEqual(dias.map((d) => [d.fecha, d.estado]), [
    ['20/10/2026', 'listo'],
    ['21/10/2026', 'listo'],
    ['22/10/2026', 'esperar'],
  ]);
  const d20 = dias[0];
  assert.deepEqual(d20.totales, { movimientos: 3, creditos: 4464.04, debitos: -128137.89, neto: -123673.85, comisiones: 1 });
});

test('etiqueta: copia la descripción y marca COMISIÓN BANCARIA (como el archivo real)', () => {
  const { dias } = construirDias(base, { cuenta, reglas: { modoEtiqueta: 'copiar' }, hoy: '2026-10-22' });
  const [a, b, c] = dias[0].lineas;
  assert.equal(a.etiqueta, 'PPV J000000001 0108');
  assert.equal(b.etiqueta, 'Banesco Pago Movil');
  assert.equal(c.etiqueta, 'COMISIÓN BANCARIA');
  assert.equal(c.narration, 'Banesco Pago Movil');
  assert.equal(c.referencia, '62931833923');
});

test('etiqueta: modo vacío (como el prompt)', () => {
  const { dias } = construirDias(base, { cuenta, reglas: { modoEtiqueta: 'vacia' }, hoy: '2026-10-22' });
  assert.deepEqual(dias[0].lineas.map((l) => l.etiqueta), ['', '', 'COMISIÓN BANCARIA']);
});

test('fecha futura (fin de semana fechado al lunes) también espera', () => {
  const { dias } = construirDias([{ date: '2026-10-26', ref: '1', description: 'x', amount: 5 }], { cuenta, reglas: {}, hoy: '2026-10-25' });
  assert.equal(dias[0].estado, 'esperar');
  assert.match(dias[0].motivo, /Fecha futura/);
});

test('excluirHoy=false permite subir el día en curso', () => {
  const { dias } = construirDias(base, { cuenta, reglas: { excluirHoy: false }, hoy: '2026-10-22' });
  assert.equal(dias.at(-1).estado, 'listo');
});

test('todayIn usa la hora de Caracas', () => {
  // 2026-10-21 02:00 UTC = 2026-10-20 22:00 en Caracas (UTC-4)
  assert.equal(todayIn('America/Caracas', new Date('2026-10-21T02:00:00Z')), '2026-10-20');
});

async function estadoDeCuentaSintetico() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Movimientos');
  ws.addRow(['BANESCO BANCO UNIVERSAL']);
  ws.addRow(['Estado de cuenta - Cuenta corriente 0134-XXXX']);
  ws.addRow([]);
  ws.addRow(['Fecha', 'Referencia', 'Descripción', 'Débito', 'Crédito', 'Saldo']);
  ws.addRow(['', '', 'SALDO INICIAL', '', '', '1.000.000,00']);
  ws.addRow(['20/10/2026', 24655439, 'PPV J000000001 0108', '', '4.464,04', '1.004.464,04']);
  ws.addRow(['20/10/2026', '62931833923', 'Banesco Pago Movil', '127.754,63', '', '876.709,41']);
  ws.addRow(['20/10/2026', '62931833923', 'Banesco Pago Movil', '383,26', '', '876.326,15']);
  ws.addRow(['21/10/2026', '11111111111', 'TRF CR INM 0105 J000000002 PRUEBA', '', '1.000,00', '877.326,15']);
  ws.addRow(['', '', 'TOTALES', '128.137,89', '5.464,04', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('lee un estado de cuenta con títulos, Débito/Crédito y saldo', async () => {
  const r = await parseStatement(await estadoDeCuentaSintetico(), 'banesco.xlsx', { referenciaLargo: 11 });
  assert.equal(r.filaEncabezado, 4);
  assert.equal(r.movimientos.length, 4);
  assert.deepEqual(r.movimientos[0], { date: '2026-10-20', ref: '00024655439', description: 'PPV J000000001 0108', amount: 4464.04, balance: 1004464.04, fila: 6 });
  assert.equal(r.movimientos[2].amount, -383.26);
  const { dias } = construirDias(r.movimientos, { cuenta, reglas: {}, hoy: '2026-11-02' });
  assert.equal(dias[0].saldos.disponible, true);
  assert.deepEqual(dias[0].saldos.errores, []);
  assert.equal(dias[0].saldos.saldoFinal, 876326.15);
});

test('lee CSV con punto y coma', async () => {
  const csv = 'Fecha;Referencia;Concepto;Monto\n20/10/2026;0001;PAGO X;-1.500,00\n20/10/2026;0002;ABONO Y;2.000,50\n';
  const r = await parseStatement(Buffer.from(csv), 'mov.csv');
  assert.deepEqual(r.movimientos.map((m) => [m.ref, m.amount]), [['0001', -1500], ['0002', 2000.5]]);
});

test('rechaza .xls y PDF con mensaje claro', async () => {
  await assert.rejects(parseStatement(Buffer.from('x'), 'a.xls'), /guárdalo como .xlsx/);
  await assert.rejects(parseStatement(Buffer.from('x'), 'a.pdf'), /PDF/);
});

test('el Excel de salida respeta la plantilla de Odoo', async () => {
  const { dias } = construirDias(base, { cuenta, reglas: {}, hoy: '2026-10-22' });
  const buf = await excelDelDia(dias[0]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Hoja1');
  assert.deepEqual(ws.getRow(1).values.slice(1), ['Fecha', 'Etiqueta', 'Referencia', 'Importe', 'Narration']);
  const r2 = ws.getRow(2);
  assert.equal(r2.getCell(1).numFmt, 'dd/mm/yyyy');
  assert.equal(parseDate(r2.getCell(1).value), '2026-10-20');
  assert.equal(r2.getCell(3).value, '00024655439');
  assert.equal(typeof r2.getCell(3).value, 'string');
  assert.equal(ws.getRow(4).getCell(2).value, 'COMISIÓN BANCARIA');
  assert.equal(ws.getRow(4).getCell(4).value, -383.26);
  assert.equal(nombreArchivo('Banesco Principal', '2026-10-20'), 'BANESCO_PRINCIPAL_20-10-2026.xlsx');
});
