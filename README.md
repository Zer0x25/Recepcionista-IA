# Recepcionista IA WhatsApp

[![CI](https://github.com/Zer0x25/Recepcionista-IA/actions/workflows/ci.yml/badge.svg)](https://github.com/Zer0x25/Recepcionista-IA/actions/workflows/ci.yml)

Prototype focused on backend-centric architecture.

## Stack

- Node.js
- TypeScript
- Fastify
- Prisma
- PostgreSQL
- Twilio
- Docker

## CI/CD

El proyecto cuenta con un pipeline de Integración Continua mediante GitHub Actions:

- **Cuándo corre**: En cada `push` y `pull_request` a la rama `main`.
- **Qué corre**: Instalación limpia (`npm ci`), aplicación de migraciones de Prisma (`npx prisma migrate deploy`) y ejecución de la suite de tests (`npm test`).
- **Requisitos**: Los tests se ejecutan contra una instancia real de PostgreSQL definida como service container en el workflow.

## Operación

### CI Gatekeeper

- La rama `main` debe estar protegida. Cualquier cambio debe pasar por un Pull Request con el status check de CI exitoso. Ver [BRANCH_PROTECTION.md](docs/BRANCH_PROTECTION.md).

### Ejecución de Tests

- Ejecutar todos los tests: `npm test`
- Ejecutar en modo watch: `npm test -- --watch`

### Desarrollo (Local)

1. Configurar variables de entorno en `.env` (ver [ENVIRONMENTS.md](docs/ENVIRONMENTS.md)).
2. Levantar base de datos: `docker-compose up -d`
3. Ejecutar migraciones: `npx prisma migrate dev`
4. Iniciar servidor: `npm run dev`

## Philosophy

Backend decides truth.
AI assists language.
Architecture before features.

## Current Phase

Sprint 1 – Core técnico y Robustez.
