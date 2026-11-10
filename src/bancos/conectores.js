// Conectores bancarios. Cada banco puede ofrecer:
//   probar(cuenta)                              -> { ok, mensaje }
//   normalizarPago / consultarPago(cuenta, pago) -> verificación de un pago recibido (BDV, Banesco)
//   obtenerMovimientos(cuenta, desde, hasta)    -> movimientos para el extracto diario (Banesco)
//   consultarSaldo(cuenta)                      -> saldos (Banesco)
//
// Cuando llegue la documentación de otro banco (ej. Mercantil), se agrega aquí sin tocar el resto del sistema.

import { bancoPorCodigo } from './catalogo.js';
import * as bdv from './bdv.js';
import * as banesco from './banesco.js';

const implementaciones = {
  '0102': bdv, // API Conciliación BDV
  '0134': banesco, // Confirmación de Transacciones + Consulta de Cuenta
};

export function capacidades(codigo) {
  const impl = implementaciones[codigo];
  return {
    verificarPago: Boolean(impl?.consultarPago),
    movimientos: Boolean(impl?.obtenerMovimientos),
    saldo: Boolean(impl?.consultarSaldo),
  };
}

export async function probarCuenta(cuenta) {
  const banco = bancoPorCodigo(cuenta.banco);
  const nombre = banco?.nombre || cuenta.banco;
  const impl = implementaciones[cuenta.banco];
  const partes = [];
  if (impl?.probar) {
    const r = await impl.probar(cuenta);
    partes.push(r);
  }
  if (!impl?.obtenerMovimientos) {
    partes.push({ ok: true, mensaje: `Extracto diario de ${nombre}: modo archivo (sube el estado de cuenta al panel o al bot).` });
  }
  return { ok: partes.every((p) => p.ok), mensaje: partes.map((p) => p.mensaje).join(' · ') };
}

export function conectorDe(cuenta) {
  return implementaciones[cuenta.banco] || null;
}

export async function consultarSaldo(cuenta) {
  const impl = implementaciones[cuenta.banco];
  if (!impl?.consultarSaldo) throw new Error(`${bancoPorCodigo(cuenta.banco)?.nombre || cuenta.banco} no ofrece consulta de saldo por API.`);
  return impl.consultarSaldo(cuenta);
}

export async function obtenerMovimientos(cuenta, desde, hasta) {
  const impl = implementaciones[cuenta.banco];
  if (!impl?.obtenerMovimientos) {
    throw new Error(`${bancoPorCodigo(cuenta.banco)?.nombre || cuenta.banco} no ofrece descarga de movimientos por API todavía; usa el modo archivo.`);
  }
  return impl.obtenerMovimientos(cuenta, desde, hasta);
}
