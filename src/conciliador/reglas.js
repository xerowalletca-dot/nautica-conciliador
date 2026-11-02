// Reglas de negocio de la conciliación diaria (definidas por administración):
//  1. Un archivo / extracto por día.
//  2. Nunca se sube el día en curso: lo de hoy se sube mañana.
//  3. Fines de semana: Banesco y Mercantil fechan sábado y domingo con el día hábil siguiente,
//     así que basta con agrupar por la fecha que trae el banco y subir solo días ya cerrados.
//  4. Fecha dd/mm/yyyy · Etiqueta (descripción o vacía) · Referencia (texto) · Importe (débitos con "-") · Narration (descripción).
//  5. Las comisiones llevan Etiqueta "COMISIÓN BANCARIA" (Odoo las concilia automáticamente).

import { norm } from './parser.js';

/** Fecha de hoy (YYYY-MM-DD) en la zona horaria de la empresa. */
export function todayIn(timeZone = 'America/Caracas', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function ddmmyyyy(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Marca comisiones. Devuelve un Map(indice -> motivo).
 *  a) La descripción contiene una palabra clave (COMISION...).
 *  b) Mismo día y misma referencia que un débito mayor, y pesa ≤ ratioMaximo % de él
 *     (ej. Banesco Pago Móvil: -127.754,63 y -383,26 con la misma referencia = 0,3 %).
 */
export function detectarComisiones(movs, comision = {}) {
  const palabras = (comision.palabrasClave || ['COMISION']).map(norm).filter(Boolean);
  const ratioMax = (comision.ratioMaximo ?? 1) / 100;
  const pct = (comision.porcentaje ?? 0.3) / 100;
  const out = new Map();

  movs.forEach((m, i) => {
    const d = norm(m.description);
    if (m.amount < 0 && palabras.some((p) => (p.endsWith('.') ? d.includes(p) : new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(d)))) {
      out.set(i, 'La descripción indica comisión');
    }
  });

  const grupos = new Map();
  movs.forEach((m, i) => {
    if (m.amount >= 0 || !m.ref || /^0+$/.test(m.ref)) return;
    const k = `${m.date}|${m.ref}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(i);
  });
  for (const idxs of grupos.values()) {
    if (idxs.length < 2) continue;
    const principal = idxs.reduce((a, b) => (Math.abs(movs[b].amount) > Math.abs(movs[a].amount) ? b : a));
    const base = Math.abs(movs[principal].amount);
    for (const i of idxs) {
      if (i === principal || out.has(i)) continue;
      const monto = Math.abs(movs[i].amount);
      if (monto <= base * ratioMax) {
        const esperado = r2(base * pct);
        const exacto = Math.abs(esperado - monto) <= 0.02;
        out.set(i, exacto
          ? `Misma referencia que un débito de ${base.toFixed(2)} y es exactamente el ${(pct * 100).toFixed(2)} %`
          : `Misma referencia que un débito de ${base.toFixed(2)} (${((monto / base) * 100).toFixed(3)} %)`);
      }
    }
  }
  return out;
}

/** Verifica que saldo anterior + importe = saldo de la fila (si el banco trae columna de saldo). */
function verificarSaldos(movs) {
  const conSaldo = movs.filter((m) => typeof m.balance === 'number');
  if (conSaldo.length < 2) return { disponible: false, errores: [] };
  // Los bancos ordenan ascendente o descendente: probamos ambos sentidos y nos quedamos con el que cuadra.
  const probar = (lista) => {
    const errores = [];
    for (let i = 1; i < lista.length; i++) {
      const esperado = r2(lista[i - 1].balance + lista[i].amount);
      if (Math.abs(esperado - lista[i].balance) > 0.01) errores.push({ fila: lista[i].fila, esperado, real: lista[i].balance });
    }
    return errores;
  };
  const asc = probar(conSaldo);
  const desc = probar([...conSaldo].reverse());
  return asc.length <= desc.length
    ? { disponible: true, orden: 'ascendente', errores: asc, saldoFinal: conSaldo.at(-1).balance, saldoInicial: r2(conSaldo[0].balance - conSaldo[0].amount) }
    : { disponible: true, orden: 'descendente', errores: desc, saldoFinal: conSaldo[0].balance, saldoInicial: r2(conSaldo.at(-1).balance - conSaldo.at(-1).amount) };
}

/**
 * Convierte movimientos en días listos para Odoo.
 * @returns {{ dias, hoy, advertencias }}
 */
export function construirDias(movs, { cuenta = {}, reglas = {}, hoy } = {}) {
  const etiquetaComision = reglas.etiquetaComision || 'COMISIÓN BANCARIA';
  const modoEtiqueta = reglas.modoEtiqueta || 'copiar';
  const excluirHoy = reglas.excluirHoy !== false;
  const comisiones = detectarComisiones(movs, cuenta.comision);
  const advertencias = [];

  // Duplicados exactos dentro del mismo archivo
  const vistos = new Map();
  movs.forEach((m) => {
    const k = `${m.date}|${m.ref}|${m.amount}|${m.description}`;
    if (vistos.has(k) && m.ref && !/^0+$/.test(m.ref)) {
      advertencias.push(`Posible movimiento repetido: filas ${vistos.get(k)} y ${m.fila} (ref ${m.ref}, ${m.amount}).`);
    } else vistos.set(k, m.fila);
  });

  const porDia = new Map();
  movs.forEach((m, i) => {
    const esComision = comisiones.has(i);
    const linea = {
      date: m.date,
      fecha: ddmmyyyy(m.date),
      etiqueta: esComision ? etiquetaComision : modoEtiqueta === 'copiar' ? m.description : '',
      referencia: m.ref,
      importe: m.amount,
      narration: m.description,
      comision: esComision,
      motivoComision: comisiones.get(i) || null,
      fila: m.fila,
      balance: m.balance,
    };
    if (!porDia.has(m.date)) porDia.set(m.date, []);
    porDia.get(m.date).push(linea);
  });

  const dias = [...porDia.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, lineas]) => {
      const creditos = r2(lineas.filter((l) => l.importe > 0).reduce((s, l) => s + l.importe, 0));
      const debitos = r2(lineas.filter((l) => l.importe < 0).reduce((s, l) => s + l.importe, 0));
      let estado = 'listo';
      let motivo = '';
      if (hoy && excluirHoy && date >= hoy) {
        estado = 'esperar';
        motivo = date === hoy ? 'Es el día en curso: se sube mañana, cuando el día cierre.' : 'Fecha futura (el banco ya la fechó al próximo día hábil): se sube cuando ese día cierre.';
      }
      const saldos = verificarSaldos(lineas.map((l) => ({ amount: l.importe, balance: l.balance, fila: l.fila })));
      if (saldos.disponible && saldos.errores.length) {
        advertencias.push(`${ddmmyyyy(date)}: ${saldos.errores.length} fila(s) no cuadran con la columna de saldo del banco.`);
      }
      return {
        date,
        fecha: ddmmyyyy(date),
        estado,
        motivo,
        lineas: lineas.map(({ balance, ...l }) => l),
        totales: { movimientos: lineas.length, creditos, debitos, neto: r2(creditos + debitos), comisiones: lineas.filter((l) => l.comision).length },
        saldos,
      };
    });

  return { dias, hoy, advertencias };
}
