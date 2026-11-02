// Genera el Excel diario con la plantilla exacta que administración sube a Odoo:
// Fecha | Etiqueta | Referencia | Importe | Narration
import ExcelJS from 'exceljs';

export const COLUMNAS = ['Fecha', 'Etiqueta', 'Referencia', 'Importe', 'Narration'];

export function nombreArchivo(alias, date) {
  const [y, m, d] = date.split('-');
  const limpio = String(alias || 'BANCO').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${limpio}_${d}-${m}-${y}.xlsx`;
}

/** @param dia  objeto de construirDias(): { date, lineas:[{ date, etiqueta, referencia, importe, narration }] } */
export async function excelDelDia(dia) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Náutica Conciliador';
  const ws = wb.addWorksheet('Hoja1');
  ws.columns = [
    { header: 'Fecha', key: 'fecha', width: 12, style: { numFmt: 'dd/mm/yyyy' } },
    { header: 'Etiqueta', key: 'etiqueta', width: 46 },
    { header: 'Referencia', key: 'referencia', width: 14, style: { numFmt: '@' } },
    { header: 'Importe', key: 'importe', width: 16, style: { numFmt: '#,##0.00_);[Red](#,##0.00)' } },
    { header: 'Narration', key: 'narration', width: 46 },
  ];
  for (const l of dia.lineas) {
    const [y, m, d] = l.date.split('-').map(Number);
    ws.addRow({
      fecha: new Date(Date.UTC(y, m - 1, d)),
      etiqueta: l.etiqueta || null,
      referencia: String(l.referencia ?? ''), // texto: conserva los ceros a la izquierda
      importe: l.importe,
      narration: l.narration,
    });
  }
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
