# dsh-llm-provider-audit

Habilidad de [DeepSeek Harness](https://github.com/deepseek-ai) que audita los proveedores LLM de un perfil, los prueba contra las APIs reales y elimina lo que no puede funcionar.

Nació de un caso concreto: un perfil con 7 proveedores y 335 entradas de modelo donde sólo una fracción respondía. Errores que resolvió:

| Síntoma | Causa real |
|---|---|
| `400 json_parse_error` en **todos** los modelos de un proveedor | El proveedor estaba con `api: openai-responses` contra un endpoint que sólo habla `/chat/completions` |
| `403 Forbidden` en 159 de 160 modelos | La clave estaba restringida a un solo modelo ("Allowed Models") |
| `402 Insufficient Balance` | Clave válida, cuenta sin saldo |
| `404 model_not_found` en `z-ai/glm-5.3-free` | Ese id no existe: el nombre se inventó |
| `503` / `429` intermitentes | Saturación o cuota del proveedor, **no** configuración |

## Instalación

DSH descubre habilidades de usuario en `~/.dsh/skills/<nombre>/SKILL.md`.

**Un comando:**

```powershell
git clone https://github.com/VictoriaCloud360/dsh-llm-provider-audit "$env:USERPROFILE\.dsh\skills\dsh-llm-provider-audit"
```

```bash
git clone https://github.com/VictoriaCloud360/dsh-llm-provider-audit ~/.dsh/skills/dsh-llm-provider-audit
```

**O con el instalador del repo** (clona y comprueba):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

```bash
sh install.sh
```

Después: **reiniciar DeepSeek Harness**. Queda disponible en todos los perfiles y proyectos de ese equipo, en sesiones nuevas.

## Uso

En una sesión nueva:

> auditá los proveedores LLM de mi perfil y borrá los modelos que no existan

El agente carga la habilidad y ejecuta:

```powershell
node scripts/audit.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --json plan.json  # sólo lectura
node scripts/apply.mjs --profile "$env:USERPROFILE\.dsh\profiles\desktop" --plan plan.json  # aplica, con backup
```

Salida de ejemplo:

```
provider      listing   configured available chat    verdict
openrouter    200       5          438       200     OK
google        200       4          50        200     OK
tokenrouter   200       160        160       200     OK
a1            200       2          2         200     OK

No problems found.
```

## Reglas de decisión que aplica

| Situación | Acción |
|---|---|
| Model id que la API no ofrece | **Borra sin preguntar** (nunca puede funcionar) |
| Proveedor roto: sin clave, 401, 402, 403, inalcanzable | **Pregunta antes de borrar** |
| 429 / 503 / timeout | **No borra**: es cuota o saturación |
| `provider:`/`model:` apuntando a algo inexistente | Reporta y corrige con confirmación |

## Estructura

| Archivo | Rol |
|---|---|
| `SKILL.md` | Instrucciones y reglas que lee el agente |
| `scripts/audit.mjs` | Sólo lectura: compara `/models` real con lo configurado, prueba un chat por proveedor, escribe `plan.json` |
| `scripts/apply.mjs` | Borra con backup, re-valida la estructura y protege los proveedores referenciados |
| `install.ps1` / `install.sh` | Instalación y actualización |

Sin dependencias npm: sólo módulos internos de Node ≥ 18 (el que trae DSH sirve).

## Qué NO hace

- No toca credenciales: `~/.dsh/.credentials.yaml` queda intacto. Sólo modifica `cordis.patch.yml`.
- No imprime claves: muestra un fingerprint (`sk-1…abcd`).
- No borra proveedores por cuota o saturación.
- No inventa modelos: si la API no lo lista, lo reporta.

## Por qué el otro equipo no ve lo mismo

Los perfiles de DSH viven en disco, en cada equipo: `~/.dsh/profiles/<perfil>/cordis.patch.yml`, con sesiones y credenciales locales. Estar logueado con la misma cuenta no sincroniza esa configuración. Esta habilidad replica el *resultado* — una lista de proveedores verificada — de forma reproducible en cada máquina.

## Licencia

MIT — ver [LICENSE](LICENSE).
