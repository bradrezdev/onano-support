# Diagnóstico: qué pasó con la base del proyecto anterior

Este documento es el **registro de lo observado** y, sobre todo, de **lo que todavía no se sabe**. No afirma una causa: la causa sigue abierta hasta contrastarla con los respaldos o los eventos del proveedor.

Fecha del registro: **2026-10-26** es la fecha que aparece en `public.schema_migrations.applied_at` (ventana 2026-10-20 → 2026-10-26, 21 migraciones). Ese es el **momento en que se aplicó el esquema por última vez**, no el momento de la pérdida.

## Lo que se observó

| Momento | Observación | Dónde |
|---|---|---|
| 2026-10-26 (según el ledger) | 21 migraciones aplicadas; `applied_at` de la última = 2026-10-26 | `public.schema_migrations` (proyecto anterior, solo lectura) |
| 2026-11-27, ~21:40 UTC | `public` **vacío** durante un probe | proyecto anterior |
| 2026-11-27, ~23:00 UTC | `public` volvió a mostrar **25 tablas** | proyecto anterior |

Contenido de la copia consultada (copia privada `crm_legacy_copy`, obtenida del proyecto ya restaurado):

| Elemento | Cantidad |
|---|---|
| Tablas en `public` | 25 |
| Migraciones registradas | 21 |
| Cuentas de Auth / perfiles | 2 / 2 (0 huérfanos) |
| Clientes (`contacts`) | 3 |
| Tickets (`tickets`) | 3 (con 3 asignaciones) |
| **Conversaciones (`conversations`)** | **0** |
| **Mensajes (`messages`)** | **0** |
| Objetos en Storage (`whatsapp-media`) | **0** (1 bucket vacío) |

**La copia consultada contiene cero chats y cero mensajes.** El historial de conversaciones no está: no hay chats que cotejar, no hay mensajes que recuperar y no hay ni un adjunto que se pueda abrir. La comprobación de «una muestra de adjuntos se pueda abrir» queda **vacía**, no aprobada.

## Lo que NO se sabe (y por qué no se afirma)

| Pregunta | Estado | Qué la resolvería |
|---|---|---|
| ¿Qué vació `public`? | **Desconocido** | Eventos del proveedor, bitácora de la plataforma, servicios de terceros con acceso a la base |
| ¿Cuál fue el punto de restauración? | **Desconocido** | Registro de PITR del proveedor (fecha y hora exactas) |
| ¿Qué había antes de esa fecha? | **Desconocido** | Los respaldos: no hay acceso al panel de respaldos desde este entorno → estado «**respaldos pendientes de verificar**» |
| ¿Quién lo hizo? | **Desconocido** | Auditoría de accesos al proyecto y a la base |

Lo que la evidencia **sí** permite decir, y lo que no:

- La restauración por PITR es una **hipótesis compatible** con lo observado (el ledger conserva 21 migraciones con `applied_at` de 2026-10-26 y el esquema volvió sin que este proyecto escribiera nada). **No está confirmada**: sin los eventos del proveedor no se puede distinguir una restauración de un mecanismo equivalente.
- Que el probe de las 21:40 UTC viera `public` vacío **no prueba una eliminación**: encaja igual con una ventana de restauración en curso.
- El proyecto anterior **no se le escribe nunca** desde este entorno. Sus credenciales viven en `apps/api/.env.legacy` y `apps/web/.env.legacy`, y renombrar esos archivos solo cambia la configuración local: no toca la base.

## Cómo se conserva lo recuperable

- Copia privada separada: contenedor `crm_legacy_copy`, volumen `crm_legacy_copy_data`. Contiene lo inventariado arriba.
- El **esquema que protege la base vive fuera de la base**: `supabase/migrations/*.sql` en el repo. `public.schema_migrations` es solo contabilidad de lo ya aplicado; si el ledger y el repo discrepan, **el repo manda**.
- Respaldo del entorno de desarrollo: `scripts/dev/backup-and-verify-restore.sh` (volcado fuera de la base) y `apps/api/scripts/restore-rehearsal.ts` (ensayo estricto de restauración en **otra** instancia de Supabase, con cuenta, chat y archivo sintéticos: si la restauración falla o falta una muestra, el ensayo **falla**; registra destino, actor, fecha, commit y migraciones **fuera de la base**).

## Qué falta para cerrar el diagnóstico

1. Acceso al **panel de respaldos** del proyecto anterior (o a sus metadatos vía `SUPABASE_ACCESS_TOKEN`): listar respaldos y sus fechas.
2. **Eventos del proveedor**: registro de PITR (fecha, hora y base de destino) y bitácora de accesos administrativos.
3. Cotejar el PITR con el ledger: si el punto de restauración coincide con 2026-10-26, la hipótesis se confirma; si no, se abre de nuevo.

Hasta entonces, el estado oficial del historial es: **«CRM reconstruido con historial pendiente de recuperación»**.
