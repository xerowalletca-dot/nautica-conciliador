// Catálogo de bancos venezolanos (código SUDEBAN) y los campos de API que se configuran en Ajustes.
// Los campos son genéricos: cada banco entrega su documentación y credenciales al aprobar el acceso empresarial.

export const MODOS = {
  archivo: 'Archivo (el estado de cuenta se sube al panel o al bot de Telegram)',
  api: 'API del banco',
};

const CAMPOS_API = [
  { key: 'baseUrl', label: 'URL base de la API', tipo: 'text', placeholder: 'https://api.banco.com/...' },
  { key: 'clientId', label: 'Client ID / Usuario API', tipo: 'text' },
  { key: 'clientSecret', label: 'Client Secret', tipo: 'secret' },
  { key: 'apiKey', label: 'API Key / Token', tipo: 'secret' },
  { key: 'rif', label: 'RIF de la empresa', tipo: 'text', placeholder: 'J-00000000-0' },
];

// Banco de Venezuela: "API Conciliación BDV" (manual MDU-006). Verifica pagos móviles recibidos, uno por uno.
// La API Key se genera en BDVenLínea Empresas; el teléfono destino es el Pago Móvil de la empresa.
const CAMPOS_BDV = [
  {
    key: 'ambiente',
    label: 'Ambiente',
    tipo: 'select',
    opciones: { produccion: 'Producción (bdvconciliacion.banvenez.com)', calidad: 'Calidad / pruebas del banco' },
  },
  { key: 'apiKey', label: 'API Key (BDVenLínea Empresas)', tipo: 'secret' },
  { key: 'telefonoDestino', label: 'Teléfono Pago Móvil de la empresa', tipo: 'text', placeholder: '04121234567' },
  { key: 'rif', label: 'RIF de la empresa', tipo: 'text', placeholder: 'J-00000000-0' },
  { key: 'baseUrl', label: 'URL (opcional, solo si el banco la cambia)', tipo: 'text', placeholder: 'por defecto la del manual' },
];

// Banesco: SSO OAuth 2.0 + APIs "Consulta de Cuenta" (saldos) y "Confirmación de Transacciones" (movimientos y verificación).
const CAMPOS_BANESCO = [
  { key: 'ambiente', label: 'Ambiente', tipo: 'select', opciones: { produccion: 'Producción', calidad: 'Calidad / pruebas (QA)' } },
  { key: 'clientId', label: 'Client ID', tipo: 'text' },
  { key: 'clientSecret', label: 'Client Secret', tipo: 'secret' },
  { key: 'rif', label: 'RIF de la empresa', tipo: 'text', placeholder: 'J-12345678-9' },
  { key: 'usuarioBanesco', label: 'Usuario Banesco Online (empresa)', tipo: 'text' },
  { key: 'password', label: 'Clave OAuth (solo si Banesco la exige)', tipo: 'secret' },
  { key: 'tokenUrl', label: 'URL token SSO', tipo: 'text', placeholder: 'https://sso-…/protocol/openid-connect/token' },
  { key: 'movimientosUrl', label: 'URL API Confirmación de Transacciones', tipo: 'text', placeholder: 'la entrega Banesco con las credenciales' },
  { key: 'saldoUrl', label: 'URL API Consulta de Cuenta (saldos)', tipo: 'text', placeholder: 'https://…/customer/products' },
  { key: 'scope', label: 'Scope (opcional)', tipo: 'text' },
  { key: 'ipPublica', label: 'IP pública registrada en Banesco', tipo: 'text', placeholder: '181.x.x.x' },
];

export const BANCOS = [
  { codigo: '0134', nombre: 'Banesco', comisionPct: 0.3, refLargo: 11 },
  { codigo: '0105', nombre: 'Mercantil', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0102', nombre: 'Banco de Venezuela', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0108', nombre: 'BBVA Provincial', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0191', nombre: 'BNC Nacional de Crédito', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0172', nombre: 'Bancamiga', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0114', nombre: 'Bancaribe', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0115', nombre: 'Banco Exterior', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0104', nombre: 'Venezolano de Crédito', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0174', nombre: 'Banplus', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0151', nombre: 'BFC Banco Fondo Común', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0163', nombre: 'Banco del Tesoro', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0175', nombre: 'Banco Digital de los Trabajadores', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0137', nombre: 'Sofitasa', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0138', nombre: 'Banco Plaza', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0156', nombre: '100% Banco', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0157', nombre: 'DelSur', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0169', nombre: 'R4 Banco Microfinanciero', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0171', nombre: 'Banco Activo', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0128', nombre: 'Banco Caroní', comisionPct: 0.3, refLargo: 0 },
  { codigo: '0177', nombre: 'Banfanb', comisionPct: 0.3, refLargo: 0 },
].map((b) =>
  b.codigo === '0102'
    ? { ...b, camposApi: CAMPOS_BDV, api: { verificarPago: true, movimientos: false, saldo: false, nota: 'API Conciliación BDV: verifica pagos móviles recibidos (no descarga el estado de cuenta).' } }
    : b.codigo === '0134'
      ? { ...b, camposApi: CAMPOS_BANESCO, api: { verificarPago: true, movimientos: true, saldo: true, nota: 'APIs Banesco: extracto diario automático (Confirmación de Transacciones), verificación de pagos y saldos. Requiere el número de cuenta de 20 dígitos y registrar la IP pública en Banesco.' } }
      : { ...b, camposApi: CAMPOS_API, api: { verificarPago: false, movimientos: false, saldo: false, nota: 'Conector pendiente de la documentación del banco.' } },
);

export function bancoPorCodigo(codigo) {
  return BANCOS.find((b) => b.codigo === codigo);
}

/** Valores por defecto de una cuenta nueva. */
export function nuevaCuenta(codigo = '0134') {
  const banco = bancoPorCodigo(codigo) || BANCOS[0];
  return {
    id: `cta_${Math.random().toString(36).slice(2, 10)}`,
    alias: banco.nombre.toUpperCase(),
    banco: banco.codigo,
    numero: '',
    moneda: 'VES',
    diarioOdooId: null,
    diarioOdooNombre: '',
    modo: 'archivo',
    activa: true,
    api: { baseUrl: '', clientId: '', clientSecret: '', apiKey: '', rif: '', ambiente: 'produccion', telefonoDestino: '', usuarioBanesco: '', password: '', tokenUrl: '', movimientosUrl: '', saldoUrl: '', scope: '', ipPublica: '' },
    sincronizar: true, // si el banco tiene API de movimientos: traer el extracto solo cada mañana
    comision: {
      porcentaje: banco.comisionPct, // % que cobra el banco (Banesco Pago Móvil = 0,3 %)
      ratioMaximo: 1, // una línea "hermana" es comisión si pesa ≤ este % de la principal
      palabrasClave: ['COMISION'],
    },
    referenciaLargo: banco.refLargo, // rellena con ceros a la izquierda (Banesco: 11)
  };
}
