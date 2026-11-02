// Conectores bancarios. Cada banco implementa la misma interfaz:
//   probar(cuenta)                          -> { ok, mensaje }
//   obtenerMovimientos(cuenta, desde, hasta) -> [{ date, ref, description, amount, balance }]
//
// Mientras los bancos no entreguen documentación y credenciales, el modo "archivo" es el que opera.
// Cuando llegue la API de un banco, se agrega aquí su implementación sin tocar el resto del sistema.

import { bancoPorCodigo } from './catalogo.js';

const implementaciones = {
  // '0134': banescoApi,   // ← se registra cuando Banesco entregue su documentación
  // '0105': mercantilApi,
};

export function conectorDisponible(codigo) {
  return Boolean(implementaciones[codigo]);
}

export async function probarCuenta(cuenta) {
  const banco = bancoPorCodigo(cuenta.banco);
  const nombre = banco?.nombre || cuenta.banco;
  if (cuenta.modo !== 'api') {
    return { ok: true, mensaje: `${nombre}: modo archivo. Sube el estado de cuenta al panel o mándalo al bot de Telegram.` };
  }
  const impl = implementaciones[cuenta.banco];
  if (!impl) {
    const faltan = ['baseUrl', 'clientId'].filter((k) => !cuenta.api?.[k]);
    return {
      ok: false,
      mensaje:
        `${nombre}: el conector API aún no está programado porque falta la documentación del banco.` +
        (faltan.length ? ` Además faltan: ${faltan.join(', ')}.` : ' Credenciales guardadas; listas para cuando llegue el conector.'),
    };
  }
  return impl.probar(cuenta);
}

export async function obtenerMovimientos(cuenta, desde, hasta) {
  const impl = implementaciones[cuenta.banco];
  if (cuenta.modo !== 'api' || !impl) {
    throw new Error('Esta cuenta no tiene conector API activo; usa el modo archivo.');
  }
  return impl.obtenerMovimientos(cuenta, desde, hasta);
}
