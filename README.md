# 🧾 Conciliador Náutica

Automatiza la carga diaria de los estados de cuenta bancarios a **Odoo**, con un panel web y un bot de **Telegram** para administración.

> Proyecto independiente: no comparte código con el resto del repositorio. Se puede mover tal cual a su propio repositorio.

## Qué hace hoy (Fase 1)

1. **Lee el estado de cuenta** del banco (Excel `.xlsx`, CSV o TXT). Encuentra solo los encabezados aunque el banco ponga títulos arriba y entiende montos venezolanos (`1.234.567,89`), columnas Débito/Crédito y referencias con ceros a la izquierda.
2. **Aplica las reglas de administración:**
   - **Un archivo / un extracto por día.**
   - **El día en curso no se sube**: lo de hoy (o lo fechado al próximo día hábil, como hacen Banesco y Mercantil con el fin de semana) espera a que el día cierre.
   - **Comisiones** → Etiqueta `COMISIÓN BANCARIA`. Se detectan por palabra clave o porque comparten la referencia con un débito mayor y pesan ~0,3 % (Banesco Pago Móvil).
   - **Plantilla Odoo:** `Fecha (dd/mm/yyyy) | Etiqueta | Referencia (texto) | Importe (débitos con -) | Narration`.
   - **Cuadre de saldos** cuando el banco trae la columna de saldo.
3. **Genera el Excel por día**, idéntico al que suben hoy a mano. Validado contra el archivo real de Banesco del 20/10/2026: 32/32 filas sin diferencias.
4. **Carga a Odoo por API**: crea el `account.bank.statement` con sus líneas en el diario correcto, **sin duplicar** (revisa el historial y las líneas que ya existen en Odoo).
5. **Bot de Telegram**: se le manda el estado de cuenta y devuelve un Excel por día más un botón **“Subir a Odoo”**. Solo responde a los chats autorizados.
6. **Ajustes**: Odoo, cuentas bancarias (con su diario de Odoo y sus credenciales API), Telegram y reglas. Todo **cifrado con AES-256-GCM** en `data/`.

## Verificación de pagos móviles — API Conciliación BDV

Menú **Verificar pago** (o comando `/pago` en Telegram). Se ingresan los datos del comprobante del cliente y el **Banco de Venezuela** responde si el pago llegó:

- ✅ **Confirmado** (código 1000 y el monto coincide)
- ❌ **No encontrado** (código 1010 u otro)
- 🚨 **Comprobante ya usado**: el mismo pago (banco + referencia + fecha) ya se aceptó antes. Se bloquea sin consultar al banco.

Configuración en **Ajustes → Bancos → Banco de Venezuela**: ambiente, **API Key** (se genera en BDVenLínea Empresas) y el **teléfono Pago Móvil de la empresa**. Si hay varias empresas o cuentas, crea una cuenta por cada API Key.

> Esta API **no** descarga el estado de cuenta: el extracto diario del BDV sigue por archivo.

Telegram (chats de administración o el chat de cobranza):

```
/pago V12345678 04141234567 123456 10/11/2026 1250,00 0102 [CUENTA]
```

## Banesco — APIs empresariales

Con las APIs **Confirmación de Transacciones** y **Consulta de Cuenta**:

| Función | Cómo se usa |
|---|---|
| **Extracto diario automático** | Cada mañana (hora configurable) trae del banco los días cerrados pendientes (el martes: sábado, domingo y lunes), arma un Excel por día con las comisiones marcadas y lo manda a Telegram con botón *Subir a Odoo* (o lo sube solo si se activa). También: botón **⇣ Traer movimientos** en *Conciliar extracto*. |
| **Saldos en línea** | Tarjeta *Saldos en línea* del panel o `/saldo` en Telegram. |
| **Verificar pagos** | *Verificar pago* o `/pago`: por referencia completa (Banesco→Banesco), últimos 6 dígitos + teléfono (pago móvil) o últimos 6 + cuenta (transferencia). |

Configuración en **Ajustes → Bancos → Banesco** (modo **API del banco**): Client ID/Secret, RIF, usuario Banesco Online, URLs (token SSO, Confirmación de Transacciones, Consulta de Cuenta), **número de cuenta de 20 dígitos** e **IP pública** (Banesco exige registrarla). El extracto automático se enciende en **Ajustes → Reglas**.

> Las descripciones que trae la API (`concept` + RIF/cédula de la contraparte) pueden diferir del texto del estado de cuenta descargado: revisar las reglas de conciliación automática de Odoo con los primeros extractos.

## Consultas por Telegram

```
/saldo [cuenta]                       saldos en línea
/movimientos [cuenta] [fecha] [hasta] movimientos (por defecto hoy)
/extracto [cuenta] [fecha]            Excel para Odoo desde el banco + botón "Subir a Odoo"
/sincronizar                          ejecuta ya el proceso de la mañana
/pago CÉDULA TELÉFONO REF FECHA MONTO BANCO [cuenta]   verificar un pago (BDV o Banesco)
```

También entiende frases como *"saldo banesco"* o *"movimientos de ayer"*. Mandar un archivo al bot sigue funcionando para los bancos sin API.

## Instalación

Requiere **Node.js 20 o superior**.

```bash
npm install
cp .env.example .env     # opcional: puerto, clave maestra, usuario/clave del panel
npm start
```

Abrir **http://localhost:3900**. En Windows basta con doble clic en `INICIAR.bat`.

## Puesta en marcha

1. **Ajustes → Odoo**: URL, usuario y clave (o API Key). En odoo.com / odoo.sh la base de datos se detecta sola. Pulsa **Probar conexión**: aparecen los diarios de banco.
2. **Ajustes → Bancos**: agrega cada cuenta (ej. Banesco), elige su **diario de Odoo** con “Cargar de Odoo” y guarda.
3. **Ajustes → Telegram** (opcional): token de @BotFather, IDs de los chats de administración (escríbele `/id` al bot) y enciende el bot.
4. **Conciliar extracto**: arrastra el estado de cuenta → revisa → **Subir a Odoo**.

## Estructura

```
src/
  server.js                 API REST + panel
  conciliador/
    parser.js               lectura de XLSX/CSV/TXT y detección de columnas
    reglas.js               reglas de negocio (días, hoy, comisiones, saldos)
    excel.js                plantilla de Odoo
    servicio.js             flujo completo (panel y bot)
  lib/
    odoo.js                 cliente JSON-RPC de Odoo
    telegram.js             cliente Bot API
    store.js                ajustes cifrados + historial
  bancos/
    catalogo.js             bancos venezolanos y campos de API
    conectores.js           interfaz para las APIs bancarias (pendientes de cada banco)
  telegram/bot.js           bot de administración
public/                     panel web (sin build)
test/                       pruebas (npm test)
```

## Seguridad

- `data/` (ajustes cifrados, historial y la clave maestra `data/.secret`) **no se sube a git**. Si se pierde `data/.secret` (o `APP_SECRET`), hay que volver a cargar las claves.
- El panel escucha solo en `127.0.0.1`. Para abrirlo en la red local usa `HOST=0.0.0.0` **y** define `ADMIN_PASSWORD`.
- Para producción: un usuario de Odoo exclusivo para el bot, con API Key y permisos de contabilidad.

## Próximas fases

- Conectores API de Mercantil y otros bancos (cuando entreguen la documentación).
- Órdenes de pago por Telegram con validación por **cédula/RIF** y comprobante al grupo de administración.
- Lectura automática (OCR) de la foto del comprobante en el canal de cobranza.
- Generador del TXT de Todoticket.
- Concepto del pago (“para qué es”) cruzado con el extracto.
