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

- Conectores API de Banesco, Mercantil, etc. (cuando los bancos entreguen la documentación) y carga automática cada mañana.
- Órdenes de pago por Telegram con validación por **cédula/RIF** y comprobante al grupo de administración.
- Canal de cobranza: comprobante del cliente → verificación automática contra el banco.
- Generador del TXT de Todoticket.
- Concepto del pago (“para qué es”) cruzado con el extracto.
