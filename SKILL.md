---
name: dsh-llm-provider-audit
description: Use when LLM calls inside DeepSeek Harness fail with 400/401/402/403/404/429, "API key is invalid", "json_parse_error", "Model not found", "Insufficient Balance", "invalid request", or when the user asks to audit, clean up or consolidate the LLM providers and models of a DSH profile ("tengo 1000 modelos y sólo uno funciona", "quiero usar sólo los gratis", "por qué falla esta API si tengo saldo"). Audits every configured provider against its real API, deletes model ids that the provider does not offer, and asks the user before removing a whole provider.
---

# DSH LLM provider audit

Audita el perfil activo de DeepSeek Harness, verifica cada proveedor contra su API real y elimina lo que no puede funcionar. Nunca adivina: compara la lista de modelos configurada con la que la API devuelve, y hace una llamada real de prueba por proveedor.

## Regla de decisión (obligatoria)

| Situación | Acción |
|---|---|
| Model id configurado que la API **no ofrece** (no aparece en `/models`, o chat devuelve 404) | **Borrar sin preguntar** — es un error de entrada, nunca puede funcionar |
| Proveedor entero roto: `NO_KEY`, 401, 402, 403, inalcanzable | **Preguntar antes de borrar** — el usuario puede querer recargar saldo, arreglar la clave o levantar el servidor |
| 429 / 503 / timeout | **No borrar** salvo que el usuario lo pida: es cuota o saturación, no configuración |
| Referencia `provider:`/`model:` apuntando a algo inexistente | **Reportar y corregir** con confirmación (afecta el modelo por defecto de cada sesión nueva) |

Nunca borres credenciales (`~/.dsh/.credentials.yaml`). Las claves se quedan; sólo se toca `cordis.patch.yml`.

## Requisitos

- El perfil objetivo: `--profile <dir>` o la variable `DSH_PROFILE_DIR`. En Desktop suele ser `~/.dsh/profiles/desktop`.
- Un `node` ≥ 18 (el que trae DSH sirve: `~/.dsh/dsh-runtimes/*/dependencies/node/bin/node.exe`).
- Ninguna dependencia npm: los scripts usan sólo módulos internos de Node.

## Paso 1 — auditar (sólo lectura)

Los scripts viven junto a este archivo, en `scripts/`.

```powershell
node scripts/audit.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --json plan.json
```

```bash
node scripts/audit.mjs --profile "$HOME/.dsh/profiles/desktop" --json plan.json
```

Salida: una tabla `provider / listing / configured / available / chat / verdict` y tres listas:

- `invalid model ids` → borrables directamente
- `providers that cannot work` → **preguntar**
- `broken references` → reportar

`verdict` es `OK`, `PARTIAL` (tiene ids muertos) o `BROKEN` (no puede llamar a la API).

## Paso 2 — borrar lo probado como inexistente

```powershell
node scripts/apply.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --plan plan.json --dry-run
node scripts/apply.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --plan plan.json
```

`apply.mjs` escribe un backup `<cordis.patch.yml>.bak-<epoch>` antes de tocar nada, re-valida la estructura después (proveedores con `displayName`, `apiKeyEnv` y al menos un modelo) y se niega a borrar un proveedor que esté referenciado por un `provider:`/`defaultProvider:` del propio archivo.

Para borrados puntuales:

```powershell
node scripts/apply.mjs --profile <dir> --remove-models "token:z-ai/glm-5.3-free,google:gemini-3.5-flash"
node scripts/apply.mjs --profile <dir> --remove-providers "cliproxy,token"
```

## Paso 3 — preguntar por los proveedores rotos

Presentá los `BROKEN` con su código real y su motivo, y ofrecé: borrar el proveedor, o dejarlo (con la consecuencia concreta). No decidas por el usuario cuando borrar quita una capacidad que puede recuperar.

## Paso 4 — reiniciar y verificar

El patch layer se lee al arrancar: **hay que reiniciar DeepSeek Harness**. Después, volver a correr `audit.mjs`: todo debe quedar `OK` y sin listas de problemas.

## Interpretación de errores

| Código | Significado real |
|---|---|
| `401` | Clave inválida para ese host. En un proxy local (`127.0.0.1`) suele ser que el proxy espera otra clave, no que falte configuración |
| `402` | Clave válida, **cuenta sin saldo**. Ninguna llamada va a funcionar hasta recargar |
| `403` | Clave válida pero **sin permiso para ese modelo** — típico de claves con "Allowed Models" restringido. El síntoma engañoso es `/models` devolviendo pocos modelos |
| `404` / `model_not_found` | El model id no existe en ese proveedor. Nombre inventado o de otro proveedor |
| `400 json_parse_error` / `invalid request` | El payload no tiene el formato que el endpoint espera. Ver "Trampas conocidas" |
| `429` | Cuota agotada (RPM/RPD del tier) |
| `503` | Saturación del proveedor. Reintentar; no es un error de configuración |

## Trampas conocidas

1. **`api: openai-responses` contra un endpoint que sólo habla `/chat/completions`** (TokenRouter, OpenRouter y la mayoría de agregadores) produce `400 json_parse_error` en **todos** los modelos, con cualquier clave correcta. La solución es `api: openai-completions`, no cambiar la clave ni el modelo.
2. **`displayName` no significa nada**: es una etiqueta libre del usuario. La identidad del proveedor es la clave interna (`token`, `tokenrouter`, `a1`, …) y es la que aparece como prefijo en los logs (`tokenrouter/nvidia/...:free`).
3. **Varios proveedores pueden apuntar al mismo `baseURL` con claves distintas** y tener permisos distintos. Auditalos por separado; no asumas que son duplicados.
4. **Los sufijos `:free` / `-free` no se pueden inventar**: si la API no lo lista, el modelo no existe (p. ej. `z-ai/glm-5.3-free` no existe aunque su versión paga sí).
5. **`/models` es la fuente de verdad** de qué ids existen para esa clave. Es la forma barata de auditar 160 modelos sin gastar tokens.
6. Un catálogo grande en el archivo no implica acceso: la clave puede estar limitada a un modelo y responder 403 en el resto.

## Seguridad

- Nunca imprimas el valor de una clave: el script sólo muestra un fingerprint (`sk-1…abcd`).
- No escribas credenciales en el repositorio, en el plan JSON ni en el chat.
- Todo cambio deja backup; para revertir, copiar el `.bak-<epoch>` sobre `cordis.patch.yml`.
