# Entornos y Variables de Configuración

Este documento detalla las variables de entorno requeridas para la operación del sistema en diferentes etapas.

## Variables Requeridas

| Variable                 | Descripción                                                | Ejemplo                                    | Requerido          |
| :----------------------- | :--------------------------------------------------------- | :----------------------------------------- | :----------------- |
| `DATABASE_URL`           | URL de conexión a PostgreSQL                               | `postgresql://user:pass@localhost:5432/db` | Sí                 |
| `PORT`                   | Puerto en el que escucha el servidor                       | `3000`                                     | No (default: 3000) |
| `TWILIO_AUTH_TOKEN`      | Token de autenticación de Twilio para validar firmas       | `pk_live_...`                              | Sí                 |
| `NODE_ENV`               | Entorno de ejecución (`development`, `test`, `production`) | `production`                               | Sí                 |
| `ADMIN_API_KEY`          | Llave para acceder a los endpoints `/admin/*`              | `sk_admin_...`                             | Sí                 |
| `ALLOW_INSECURE_WEBHOOK` | Bypass de validación de firma de Twilio                    | `true`/`false`                             | No                 |

## Reglas de Seguridad

### [IMPORTANT] Validación de Webhooks

La variable `ALLOW_INSECURE_WEBHOOK` permite saltarse la validación de la firma `X-Twilio-Signature`.

- **DEV/TEST**: Puede establecerse en `true` para facilitar pruebas locales sin túneles (ngrok).
- **PROD**: **DEBE** ser `false` o estar ausente. El sistema ignorará `true` si `NODE_ENV=production` no está configurado (ver implementación en `verifyTwilioSignature`).

## Ejemplos Mínimos

### Desarrollo Local (`.env`)

```env
DATABASE_URL="postgresql://user:password@localhost:5433/recepcionista_ia?schema=public"
PORT=3000
TWILIO_AUTH_TOKEN="local_debug_token"
NODE_ENV="development"
ALLOW_INSECURE_WEBHOOK="true"
ADMIN_API_KEY="dev_admin_key"
```

### Producción (CI/CD Config)

```env
DATABASE_URL="postgresql://user:secret@db-host:5432/prod_db"
TWILIO_AUTH_TOKEN="actual_twilio_token"
NODE_ENV="production"
ADMIN_API_KEY="highly_secure_random_string"
```
