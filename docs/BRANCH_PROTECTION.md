# Branch Protection (Checklist)

Para asegurar la integridad de la rama `main`, se deben configurar las siguientes "Branch protection rules" en GitHub:

## Configuración de Rama `main`

1. **Require a pull request before merging**: Activado.
   - **Require approvals**: Activado (mínimo 1).
   - **Dismiss stale pull request approvals when new commits are pushed**: Recomendado.
2. **Require status checks to pass before merging**: Activado.
   - **Status checks**: Buscar y seleccionar `test` (o el nombre exacto definido en `.github/workflows/ci.yml`).
   - **Require branches to be up to date before merging**: Recomendado.
3. **Require conversation resolution before merging**: Recomendado.
4. **Lock branch**: Desactivado.
5. **Do not allow bypassing the above settings**: Recomendado para todos (incluso admins).

## Cómo activarlo

- Navegar a `Settings` > `Code and automation` > `Branches`.
- Click en `Add branch protection rule`.
- Branch name pattern: `main`.
- Seguir el checklist anterior.
