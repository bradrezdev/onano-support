# WhatsApp CRM

CRM de WhatsApp multi-usuario: gestiona contactos, conversaciones, asignación a agentes, pipeline de leads, etiquetas y notas. Backend en Node.js + Fastify, base de datos en Supabase (Postgres + Auth + Realtime + Storage), envío de mensajes vía Twilio, frontend en Vue 3 + Vite + Tailwind.

## Stack

- **Backend**: Node 18+, TypeScript, Fastify, Twilio SDK, Supabase JS, Zod
- **Frontend**: Vue 3, Vite, Tailwind v3, Pinia, vue-router, Supabase JS
- **DB**: Supabase Postgres con Auth, Realtime y Storage
- **Mensajería**: Twilio WhatsApp (webhooks + REST)
- **Package manager**: pnpm con workspaces

## Estructura

```
.
├── apps/
│   ├── api/      # Fastify backend
│   └── web/      # Vue 3 + Vite frontend
├── supabase/
│   └── migrations/   # SQL migrations para Supabase
├── scripts/         # utilidades (seeds, bootstrap admin)
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## Setup inicial

### 1. Supabase

1. Crear proyecto en https://supabase.com
2. Ir a **Settings → API** y copiar `URL` + `anon public` + `service_role` (esta última solo para el backend)
3. Abrir **SQL Editor** y ejecutar las migrations en orden desde `supabase/migrations/`:
   - `20251016000000_init.sql`
   - `20251016000001_rls.sql`
   - `20251016000002_triggers.sql`
   - `20251016000003_storage.sql`
4. Crear primer usuario vía signup en la app, luego promoverlo a admin en SQL:
   ```sql
   update profiles set role = 'admin' where id = '<uuid>';
   ```

### 2. Twilio

1. Crear cuenta en https://console.twilio.com
2. **Developement → Messaging → Try WhatsApp → Sandbox**
3. Configurar webhook en el sandbox:
   - "WHEN A MESSAGE COMES IN" → `https://<tu-tunnel>/api/webhooks/twilio` (POST)
   - "STATUS CALLBACK URL" → `https://<tu-tunnel>/api/webhooks/twilio/status` (POST)
4. Anotar `ACCOUNT_SID`, `AUTH_TOKEN` y el número sandbox (`+14155238886`).

### 3. Local

```bash
cd whatsapp-CRM
pnpm install

# Crear .env a partir de los ejemplos
cp .env.example apps/api/.env       # rellenar con valores Supabase + Twilio + WEBHOOK_BASE_URL
cp apps/web/.env.example apps/web/.env   # rellenar con VITE_SUPABASE_URL + ANON_KEY

# Arrancar api (:4000) y web (:5173) en paralelo
pnpm dev

# En otra terminal, exponer el webhook público con ngrok
ngrok http 4000
# Copia la URL https://xxxx.ngrok-free.app a WEBHOOK_BASE_URL y a la config del sandbox de Twilio
```

## Scripts útiles

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Arranca api y web en paralelo |
| `pnpm dev:api` | Solo el backend (Fastify en :4000) |
| `pnpm dev:web` | Solo el frontend (Vite en :5173) |
| `pnpm build` | Build de producción de ambas apps |
| `pnpm typecheck` | Verifica tipos en todo el monorepo |
| `pnpm clean` | Borra `dist/`, `node_modules/`, `.vite/` |

## Variables de entorno

### `apps/api/.env`

```
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:5173

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_NUMBER=

WEBHOOK_BASE_URL=     # p.ej. https://xxxx.ngrok-free.app
```

### `apps/web/.env`

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_API_BASE_URL=http://localhost:4000
```

## Privacidad y datos

- El código de este repositorio es propio. No incluye código propietario de forjabots ni de ningún otro producto comercial.
- Las credenciales de Twilio se guardan en la tabla `profiles` (en MVP sin cifrar; cifrado vía `pgsodium` queda para una fase posterior).
- Los medios compartidos por WhatsApp se almacenan en el bucket privado `whatsapp-media` de Supabase Storage y se sirven mediante URLs firmadas de 1 h.

## Licencia

Privado.