<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <b>Español</b> · <a href="README.pt-BR.md">Português (BR)</a></p>

<p align="center">
  <b>El chat sigue siendo Claude. Solo Code pasa a GPT.</b><br>
  El ajuste propio de Claude Desktop para usar otros modelos cambia <b>toda la app</b>, y con ella se van el chat,
  Remote Control desde el teléfono y los conectores.<br>ClaudeRipple no desactiva nada: mantienes la sesión iniciada en tu
  suscripción de Claude mientras GPT, DeepSeek, Kimi, Grok<br>o cualquiera de más de 400 modelos responden en la
  <b>pestaña Code</b>. Y también Claude dentro de la <b>app de Codex</b> y de <b>Codex CLI</b>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clauderipple"><img alt="npm" src="https://img.shields.io/npm/v/clauderipple?label=npm"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-orange">
  <a href="LICENSE"><img alt="GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-arm64%20%7C%20x64-0078D4">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-x64%20(systemd)-FCC624">
  <img alt="Node" src="https://img.shields.io/badge/node-24%2B-success">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/docs-English-blue"></a>
</p>

<p align="center">
  <img src="docs/media/tour.png" width="880" alt="Recorrido por la configuración de ClaudeRipple: estado, asignación de modelos, proveedores, clientes, registro de solicitudes">
</p>

<table align="center">
  <tr>
    <td align="center" width="34%"><img src="docs/media/picker-zoom.png" width="300" alt="Nombres reales en el selector de Claude Desktop"><br><sub>Modelos GPT con su nombre real en el selector de Claude Desktop</sub></td>
    <td align="center" width="66%"><img src="docs/media/luna-answer.png" alt="GPT-5.6 Luna respondiendo en la pestaña Code de Claude Desktop"><br><sub>GPT-5.6 Luna respondiendo en la pestaña Code, con el esfuerzo que elegiste</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/media/subagents.png" alt="Subagentes con GPT-5.6 Terra y Sol, identificados en el panel de tareas en segundo plano"><br><sub>Subagentes con GPT-5.6 Terra y Sol, identificados en el panel de tareas en segundo plano</sub></td>
  </tr>
</table>

---

## 1P, no 3P: la diferencia por la que existe este proyecto

Claude Desktop ya incluye una forma oficial de usar otros modelos: el ajuste de **gateway
de inferencia**, lo que la app llama modo de terceros o **3P**. Activarlo no es una
elección por sesión. Al arrancar, cambia **toda la app** a otro modo de despliegue, y
ese modo es otro producto:

- La ventana deja de cargar `claude.ai` y carga en su lugar un paquete local. Las
  llamadas a `/api/` y `/v1/` de claude.ai responden `custom_3p_not_available` 503.
- El "chat" ya no es el chat de claude.ai. Es una sesión de agente local de Claude Code.
- Remote Control y las sesiones laterales se desactivan por completo
  (`shouldEnableSessionsBridge()` devuelve false).
- Los conectores de claude.ai de la propia Anthropic, Claude Design, la continuidad en
  dispositivos móviles y la búsqueda en el chat desaparecen con él.

No hay término medio. "El chat en Claude y Code en el gateway" es imposible para
cualquiera, porque el modo 1P no enruta absolutamente nada a través del gateway. (Todo
esto se ha extraído del propio paquete de la app; consulta [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2).

**ClaudeRipple nunca toca ese ajuste.** La app mantiene la sesión iniciada en tu
suscripción de Claude en modo 1P, y otro modelo responde en la pestaña Code y en sus
subagentes, con su nombre real en el selector de modelos y con el esfuerzo de
razonamiento que elegiste. No cambias tu cuenta de Claude por una de GPT. Conservas
las dos, en una sola app.

Quedarse en 1P tiene tres consecuencias, y ninguna herramienta basada en el gateway puede ofrecer ninguna de ellas:

- **Programa desde el teléfono, con GPT.** Remote Control está desactivado en 3P. Aquí
  está activado, así que puedes elegir un modelo, enviar una tarea desde el teléfono y
  ver cómo llegan los commits.
- **Conectores activos mientras trabaja otro modelo.** 3P sustituye las llamadas a
  claude.ai por stubs, y con ellas caen los conectores de la propia Anthropic. Lee un
  documento de Google Drive y deja que GPT escriba el código.
- **Sesiones en la nube y laterales.** Desaparecen en 3P. Aquí siguen intactas.

Si pagas Claude, 3P no es una opción: tira a la basura la mitad de la suscripción
que estás pagando. Esta es la única forma de conservarla y, aun así, elegir el
modelo.

## Preguntas frecuentes

### ¿Puedo usar GPT en la app Claude Desktop?

Sí, en la **pestaña Code** y sus subagentes. Instala ClaudeRipple, inicia sesión con una
suscripción ChatGPT Plus o Pro, y GPT (GPT-6 Sol, Luna, Astra, GPT-5.6 Terra y el resto)
aparece con su nombre real en el selector de modelos, con el esfuerzo de razonamiento
que elijas. La app en sí no se modifica ni se cambia a ningún otro modo. La pestaña
general de **chat** sigue siendo Claude: ninguna herramienta puede redirigirla sin pasar
toda la app al modo gateway (consulta [1P, no 3P](#1p-no-3p-la-diferencia-por-la-que-existe-este-proyecto)).

### ¿Cómo uso GPT en Claude Code?

La misma instalación sirve para la CLI `claude` en la terminal. ClaudeRipple es un proxy local
que Claude Code usa mediante dos líneas en `~/.claude/settings.json`, así que tus
skills, hooks, servidores MCP, `CLAUDE.md` y subagentes siguen funcionando mientras
responde otro modelo.

### ¿Tengo que activar el ajuste de "inferencia de terceros" (gateway) de Claude Desktop?

No, y no deberías. Ese ajuste pasa toda la app al modo 3P, que deja de cargar
claude.ai, sustituye el chat por una sesión de agente local y desactiva Remote Control.
ClaudeRipple nunca lo toca.

### ¿Perderé el chat de claude.ai, Remote Control o mis conectores?

No. La app mantiene la sesión iniciada en tu suscripción de Claude, así que el chat,
Remote Control desde el teléfono, las sesiones en la nube y los conectores de la propia
Anthropic siguen funcionando. Ese es precisamente el sentido de quedarse en 1P.

### ¿Puedo seguir usando el propio Claude?

Sí. La asignación de modelos funciona por nombre de modelo: deja un nombre asignado a
Claude y responderá Claude. La mayoría de la gente asigna uno o dos nombres a GPT y deja
el resto como está.

### ¿Necesito una clave de API de OpenAI?

No. Sirve cualquier plan de ChatGPT que incluya Codex: Plus, Pro y Business, y Enterprise o
Edu si el administrador del espacio de trabajo ha activado Codex. Inicias sesión desde la
app y no interviene ninguna clave de API. Se aplican los límites de uso del plan; cuando se
agotan, se siguen usando los créditos de Codex que hayas comprado. Las claves de API son
para los demás proveedores (DeepSeek, Kimi, GLM, OpenRouter y cualquier otro con un
endpoint compatible con Anthropic u OpenAI).

### ¿Qué modelos puedo usar?

GPT con una suscripción de ChatGPT, y DeepSeek, Kimi, GLM, Grok, Qwen y más de 400
modelos más a través de OpenRouter o de una clave de API directa. Los modelos de Claude
siguen funcionando como siempre.

### ¿Funciona en Windows?

Sí, en Windows y macOS, arm64 y x64. La instalación, el panel, el reinicio y la
desinstalación se han medido en Windows 11 arm64; el runtime x64 se ha medido con
emulación. Linux también funciona donde haya una sesión de usuario de systemd: la
instalación, una solicitud de la pestaña Code a través del router, un reinicio en mitad
de una respuesta en streaming y la desinstalación se han medido en Ubuntu 24.04 x64 con
Claude Desktop 2.2553.13, igual que el modo selector: los modelos de `cli.extraModels`
aparecen en el selector de la pestaña Code junto a los de Claude.

### ¿Se envía mi código a algún otro sitio?

No. El proxy se ejecuta en tu propio equipo. Las solicitudes van al proveedor que
configuraste y a ningún otro sitio, y las credenciales se quedan en tu directorio
personal. Consulta [Privacidad](#privacidad).

### ¿Me suspenderán la cuenta de Claude? ¿Va en contra de los términos de Anthropic?

Lo que ClaudeRipple hace con Claude es poco y verificable: una solicitud que se queda en
Claude sale de tu equipo byte a byte tal como la envió Claude Code, y una solicitud
redirigida a GPT o a otro proveedor nunca llega a Anthropic. Funciona mediante los ajustes
de proxy y certificados que Claude Code documenta para redes corporativas (`HTTPS_PROXY`,
`NODE_EXTRA_CA_CERTS` — [Enterprise network configuration](https://code.claude.com/docs/en/corporate-proxy)),
no parcheando la app. Los casos de cuentas suspendidas que se han reportado se refieren a
la dirección contraria: el inicio de sesión de una suscripción de Claude usado desde
**otro** programa. ClaudeRipple tiene una función opcional de ese tipo: Claude dentro de
Codex usando el inicio de sesión de tu suscripción. Ese uso está sujeto a los términos de
Anthropic; con una clave de API de Anthropic, la cuestión no se plantea. Rotar varias
suscripciones de Claude también es decisión tuya conforme a esos términos. Solo Anthropic
puede decir cómo trata una cuenta, así que nada de lo que se dice aquí es una promesa.

### ¿Y Gemini con una cuenta de Google?

Una clave de API de AI Studio es la vía que Google admite, y la segura. El inicio de
sesión con cuenta de Google (Antigravity) es distinto: los [términos de Antigravity](https://antigravity.google/terms)
de Google (sección 6) y las [preguntas frecuentes de Gemini CLI](https://geminicli.com/docs/resources/faq/)
califican de incumplimiento usar esas credenciales desde otro programa. En febrero de 2026,
Google suspendió cuentas usadas de esta forma (la suspensión también les cortó el acceso a
Gemini CLI y a Code Assist) y [afirmó](https://github.com/google-gemini/gemini-cli/discussions/20632)
que, ante una segunda infracción, la suspensión es permanente. ClaudeRipple ofrece este
inicio de sesión porque otros lo hacen y hubo quien lo pidió, muestra esta advertencia
antes de empezar y no hace nada para ocultar el tráfico. Si decides usarlo, hazlo con una
cuenta secundaria.

### ¿Puedo usar varias cuentas de ChatGPT?

Sí. Cada `clauderipple login` (o **+ Añadir cuenta de ChatGPT** en el panel) añade una.
Cuando una cuenta alcanza su límite de uso, la misma solicitud pasa a la siguiente cuenta y
la agotada descansa hasta que se restablece su ventana; una conversación se mantiene en la
cuenta que respondió, para conservar su caché de prompts. Esto se aplica a la pestaña Code
de Claude Desktop, a Claude Code y a GPT en la app y la CLI de Codex.

### ¿Puedo usar Claude dentro de Codex?

Sí. `clauderipple codex on` añade ClaudeRipple como proveedor, y los modelos de Claude
aparecen con su propio nombre en la lista de modelos de la app y la CLI de Codex.
Responden a través de tu inicio de sesión de Claude Code o de una clave de API de
Anthropic. Consulta [App de Codex y Codex CLI](#app-de-codex-y-codex-cli).

### ¿Puede generar imágenes?

Sí, con una suscripción de ChatGPT y sin clave de API:
`clauderipple image "a red paper boat" -o boat.png --aspect square`. `--ref FILE` añade
una imagen de referencia y `--transparent`, un fondo transparente. Cada imagen tarda unos
30 segundos, y la suscripción elige la resolución y la calidad. A los subagentes que
genera ClaudeRipple se les indica esa misma llamada, así que también pueden crear
imágenes. Consulta [Claude Code](#claude-code-terminal-remote-control-subagentes).

### ¿GPT rinde peor dentro de Claude Code?

El prompt del sistema y las descripciones de herramientas de Claude Code están escritos
para Claude, así que otro modelo lee instrucciones pensadas para otro, y puede comportarse
de forma algo distinta que en su propio cliente. ClaudeRipple le dice a cada modelo su
propio nombre y esfuerzo, adapta los esquemas de herramientas que un proveedor rechazaría
y te permite añadir instrucciones por proveedor. Una configuración habitual es Claude
como modelo principal con GPT o DeepSeek como subagentes.

### ¿En qué se diferencia de CC Switch, opencodex o claude-code-router?

Consulta la [tabla comparativa](#una-herramienta-en-lugar-de-cuatro). En resumen:
ClaudeRipple llega a la pestaña Code de Claude **Desktop** mientras la app mantiene la
sesión iniciada en Claude, y muestra otros modelos en su selector con su nombre real.
CC Switch también llega a la app de escritorio, pero activando su modo gateway (3P).

### ¿Es gratis?

Sí. ClaudeRipple es de código abierto con licencia GPL-3.0. Solo pagas las suscripciones o
claves de API que ya usas.

## Una herramienta en lugar de cuatro

Hay herramientas similares que permiten que la CLI de Claude Code o Codex CLI usen otros
modelos, pero o bien no pueden llegar a la **app de escritorio** de Claude, o solo llegan
a través de su modo gateway (3P), y en cuanto cambias de modelo pierdes la parte de la
suscripción de Claude (chat de claude.ai, Remote Control, sesiones en la nube).
ClaudeRipple cubre la app de escritorio, la terminal y Codex desde una sola app de la
barra de menús, usa ambas suscripciones a la vez y mantiene intacto el harness de
Claude Code: tus skills, hooks, servidores MCP, `CLAUDE.md`, subagentes y conectores de
claude.ai siguen funcionando mientras otro modelo hace el trabajo de pensar.

| | ClaudeRipple | CC Switch (revisado el 2026-09-24) | opencodex / openclaude (revisado el 2026-09-16) | claude-code-router | Modo gateway (3P) de Claude Desktop |
|---|---|---|---|---|---|
| Pestaña Code de Claude **Desktop** **sin** modo gateway (3P) | ✅ | ❌ ² | ❌ ¹ | ❌ | ❌ por definición |
| Conserva el chat de claude.ai, Remote Control, las sesiones en la nube y los conectores | ✅ | ❌ | ❌ | ❌ | ❌ |
| Suscripciones de Claude y GPT a la vez | ✅ | ❌ un proveedor cada vez | ❌ todo o nada | ❌ | ❌ |
| Nombres reales de los modelos en el selector de Desktop | ✅ | ❌ nombres de rol `claude-*` ² | ❌ | ❌ | parcial |
| Varias cuentas de ChatGPT, con cambio cuando una se agota (Desktop y Codex) | ✅ | ❌ cambio manual ³ | ✅ | ❌ | ❌ |
| CLI `claude` en la terminal | ✅ | ✅ | ✅ | ✅ | ✅ |
| **App** de Codex y Codex CLI → Claude | ✅ | ✅ | ✅ | ❌ | ❌ |
| Caché de prompts en proveedores con traducción de protocolo | **94–99 %** medido | sin medir | sin medir | variable | no aplica |
| Subagentes identificados por su modelo real en el panel de tareas | ✅ | ❌ | ❌ | ❌ | ❌ |
| Interfaz gráfica de configuración, sin necesidad de terminal | ✅ | ✅ | ❌ | ❌ | ❌ |
| App firmada y notarizada con su propio runtime | ✅ | ✅ | ❌ | ❌ | – |

¹ El README de opencodex mostraba Claude Desktop en una demo, pero no publicaba pasos de
configuración para ello, ni en el repositorio ni en su sitio de documentación (revisado el
2026-09-16). En ese momento, la única vía pública para llegar a la app de escritorio era el
ajuste oficial del gateway: la última columna.

² CC Switch llega a Claude Desktop escribiendo el perfil de terceros de la app
(`Claude-3p/claude_desktop_config.json`, `"inferenceProvider": "gateway"`), que es la
última columna. A través de su gateway local, el selector solo muestra los nombres de rol
`claude-sonnet-*`, `claude-opus-*` y `claude-haiku-*` ([su manual](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.6-claude-desktop.md)).
CC Switch gestiona más herramientas de las que cubre esta tabla (Gemini CLI, OpenCode y
otras) y sincroniza los servidores MCP y las skills entre ellas.

³ Cada cuenta de ChatGPT está vinculada a su propia tarjeta de proveedor, y las tarjetas
oficiales de ChatGPT quedan fuera de la cola de failover (notas de la versión v3.20.0).

El propio ajuste de "inferencia de terceros" de la app de escritorio cambia toda la app a
otro modo: pierdes el chat de claude.ai, Remote Control y las sesiones en la nube. Las
herramientas que sustituyen `ANTHROPIC_BASE_URL` nunca llegan a la app de escritorio, y
las que sí llegan escriben ese mismo ajuste. ClaudeRipple, en cambio, es un
pequeño proxy HTTPS en el que solo confía el proceso de Claude Code: las solicitudes de
los modelos que asignas van a tu proveedor, y todo lo demás va a Anthropic byte a byte.

## Qué obtienes

- **Cualquier modelo en Claude Desktop y Claude Code.** GPT-6 Sol / Luna / Astra y
  GPT-5.6 Terra / Sol / Luna con tu suscripción ChatGPT Plus/Pro (los modelos nuevos
  aparecen el mismo día en que OpenAI los ofrece), Google Gemini, o DeepSeek, Kimi, GLM,
  MiniMax, Qwen, Grok, Mistral, Groq, Together, Fireworks, OpenRouter (más de 400
  modelos) y Ollama / LM Studio en local. Con su nombre real en el selector, o asignados
  a un nombre de Claude.
- **Claude en la app de Codex y en Codex CLI.** Un endpoint local compatible con OpenAI
  que Codex trata como un proveedor; los modelos de Claude aparecen en la propia lista de
  modelos de Codex. Usa tu inicio de sesión actual de Claude Code o una clave de API de
  Anthropic.
- **Varias cuentas de Claude sin romper la caché de prompts.** Activa la rotación de
  cuentas en un proveedor nativo de Claude, añade suscripciones desde el panel y cada
  conversación se mantiene en la cuenta que respondió. Antes de que empiece la respuesta,
  un rechazo por cuota o por autenticación pasa ese turno a la siguiente cuenta. Esta ruta
  nativa de Claude Desktop/Code es independiente de la entrada traducida de Codex, que
  elige un inicio de sesión disponible y no rota cuentas.
- **Varias cuentas de ChatGPT.** Cada `clauderipple login` (o **+ Añadir cuenta de ChatGPT**
  en el panel) añade una. Cuando una cuenta alcanza su límite, la siguiente toma el relevo
  en la misma solicitud y la agotada descansa hasta que se restablece su ventana; una
  conversación se mantiene en la cuenta que respondió, para conservar su caché. Esto
  cubre la pestaña Code de Claude Desktop y los subagentes **y GPT en la app y la CLI de
  Codex**: Codex conserva su propio inicio de sesión y pasa a la siguiente cuenta sin
  cerrar sesión.
- **El harness completo de Claude Code, intacto.** Skills, hooks, MCP, `CLAUDE.md`,
  subagentes, modo plan, Remote Control en tu teléfono: no se desactiva nada.
- **Correcto por construcción.** Se conserva la caché de prompts (puntos de corte de caché de
  Anthropic y prefijos estables de OpenAI), se gestionan los hilos del lado del servidor
  de Claude Code, las llamadas a herramientas y las imágenes se transmiten en ambos
  sentidos, el esfuerzo de razonamiento se limita a los niveles que admite cada modelo y
  se eliminan los campos exclusivos de Anthropic para los proveedores compatibles.
- **Un registro de solicitudes de verdad.** Quién preguntó, qué modelo respondió, tokens
  de entrada / en caché / de salida, latencia y estado, por solicitud, con un resumen de
  la última hora.
- **Etiquetas de subagentes.** El panel de tareas en segundo plano muestra
  `Terra·high · Review` en lugar de un genérico "Agent".
- **La ruta, donde escribes.** Un mod de Claude Code añade una línea encima del prompt:
  adónde fue tu última solicitud, su esfuerzo, el acierto de caché y el tiempo. `Log` (o
  `/ripple-log`) abre el registro de solicitudes en un panel lateral, con colores según el
  proveedor y el resultado; `×` (o `/ripple-bar`) oculta la línea. El mismo mod mantiene a
  un worker en su propio modelo cuando la llamada a Agent indica otro, y lee su marcador
  `[[ripple: name@level]]` esté donde esté en el prompt. Un solo interruptor en la
  pantalla Clientes, o `clauderipple mod on`.
- **Imágenes con tu suscripción de ChatGPT.** `clauderipple image "<prompt>"`, con
  imágenes de referencia y fondos transparentes. A los subagentes se les explica cómo
  hacerlo, así que un worker de GPT o DeepSeek puede crear una imagen y verla sin una
  herramienta de imágenes.
- **Workers ligeros, si los quieres.** Un solo interruptor da a los subagentes generados
  solo las herramientas que usa un worker, en lugar de todos los servidores MCP y plugins
  de la sesión: la primera solicitud de un worker bajó de 33k a 9k tokens.
- **Hecho para quien no quiere usar la terminal.** Ajustes predefinidos de proveedores con
  prueba de conexión y descubrimiento de modelos en un clic, asignación de modelos con
  menús desplegables, guardado automático e interfaz en coreano e inglés. Una app de la
  barra de menús que trae su propio runtime y se configura sola en el primer arranque.
  Firmada y notarizada.

<p align="center">
  <img src="docs/media/mapping.png" width="880" alt="Asignación de modelos: qué modelo responde por cada nombre de Claude, con esfuerzo de razonamiento por modelo">
</p>

## Instalación

**macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

**Windows** (PowerShell)

```powershell
irm https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.ps1 | iex
```

**Linux** (una sesión de escritorio con systemd)

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

El router se ejecuta como servicio de systemd por usuario: `systemctl --user status clauderipple`,
y `journalctl --user -u clauderipple` para ver lo que ha registrado. El modo selector confía en
la CA local a través de la base de datos NSS que lee Chromium (`~/.pki/nssdb`, solo para tu
usuario, sin sudo), para lo que hace falta `certutil`: ejecuta `sudo apt install libnss3-tools`
(Fedora: `sudo dnf install nss-tools`) antes de `clauderipple picker on`.

Esos son todos los requisitos previos. El script usa el Node 24+ que ya tengas y, si no
tienes ninguno, descarga la compilación oficial en `~/.clauderipple/runtime` y la verifica
con la suma de comprobación que publica nodejs.org. Después configura ClaudeRipple: un
certificado local, dos líneas en `~/.claude/settings.json` y un router en segundo plano
que se inicia con tu equipo. Sin permisos de administrador y sin contraseña.

Si ya tienes Node instalado, puedes saltarte el script:

```sh
npm install -g clauderipple
clauderipple install
```

Luego abre el panel y añade un proveedor:

```sh
clauderipple ui
```

**Proveedores** → añade ChatGPT o pega una clave de API → **Asignación de modelos**.

**La app de la barra de menús / bandeja** es opcional. Muestra el estado del router y abre
el panel con un clic:

```sh
clauderipple tray
```

Funciona con Electron, que ocupa unos 270 MB y por eso no se instala por defecto.
`clauderipple tray --install` lo descarga una sola vez; todo lo demás funciona sin él.

**Actualización.** La bandeja ofrece la nueva versión cuando la hay (**Buscar actualizaciones…**), o bien:

```sh
clauderipple update
```

Actualiza de la misma forma en que instalaste (otra vez con el script de instalación, o con
npm) y reinicia el router con la nueva versión. El Electron de la bandeja se conserva entre
actualizaciones.

Opcional, para ver los nombres reales en el selector de Desktop:
**Clientes → Claude Desktop → Selector de modelos → Activar el selector**, y después cierra
Claude Desktop por completo y vuelve a abrirlo. Para confiar en el certificado local solo
para tu usuario, macOS te pide tu contraseña de inicio de sesión y
Windows muestra un cuadro de confirmación con la huella digital; Linux lo añade a tu base de
datos NSS sin preguntar. ClaudeRipple nunca ve ninguna contraseña, y ninguna plataforma
necesita permisos de administrador.

> **Cerrar la ventana de Claude Desktop no basta.** La app sigue en ejecución y, al volver
> a abrirla, se reutiliza sin leer el nuevo ajuste. Sal de ella por completo (macOS: ⌘Q;
> Windows: el icono de la bandeja o el Administrador de tareas; Linux: Ctrl+Q o el icono de
> la bandeja, hasta que `pgrep -f claude-desktop` no imprima nada) o el selector no cambiará,
> sin ningún aviso.

<details>
<summary>Desde el código fuente (Node 24)</summary>

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install   # certs, settings.json env, supervisor (launchd / Task Scheduler), end-to-end probe
node packages/cli/src/index.ts ui        # open the local GUI in your browser
```

`uninstall` lo revierte todo y restaura `~/.claude/settings.json` desde una copia de seguridad.
Otros comandos: `status`, `start`, `stop`, `restart`, `logs -f`, `login`, `logout`,
`claude-login`, `claude-logout`, `picker on|off`, `agent-title on|off`, `mod on|off`,
`codex on|off`, `update`, `image "<prompt>"`.
</details>

## Clientes

### Claude Desktop

Funciona nada más instalarlo. Asigna modelos en **Asignación de modelos** (se guarda
automáticamente) o activa el **modo selector** para ver los modelos de los proveedores por
su nombre en el propio selector de la app. El esfuerzo elegido en la app se transmite; los
niveles no admitidos se ajustan al más cercano.

### Claude Code (terminal, Remote Control, subagentes)

El mismo router, la misma asignación. `/model gpt-5.6-terra` lista los modelos que añadiste.
Los subagentes siguen el enrutamiento; un marcador `[[gpt: sol@xhigh]]` en el prompt de un
subagente sustituye el modelo para esa llamada, y el panel de tareas muestra el nombre real
del modelo.

**No tienes que construir un harness de agentes para esto.** Asigna un modelo redirigido al
slot de subagentes y todos los subagentes se ejecutarán en él, sin archivo de agente ni
nada más:

```jsonc
// Settings → CLI models, or "cli": { "models": { … } } in the config
{ "subagent": "gpt-5.6-terra" }   // → CLAUDE_CODE_SUBAGENT_MODEL
```

**Cada modelo que marques es también un subagente con nombre.** El router escribe
`~/.claude/agents/<name>.md` para cada modelo que ofrece exactamente un proveedor
(`gpt-5.6-terra` → `gpt-5-6-terra`, `deepseek-v4.1-flash` → `deepseek-v4-1-flash`),
así que para "que lo haga DeepSeek" basta con marcar el modelo: la herramienta Agent
lo lista, `subagent_type: "deepseek-v4-1-flash"` lo ejecuta y el panel de tareas
muestra su nombre. Desmarca el modelo y su archivo desaparece. El router solo toca
los archivos que escribió él (registrados en `generated-agents.json`); un archivo de
agente que hayas escrito tú con el mismo nombre tiene prioridad y no se toca, así que
unas instrucciones personalizadas siguen siendo simplemente el archivo de agente de
Claude Code, con un `model:` que el router conozca:

```markdown
---
name: reviewer
description: Independent review on GPT-5.6 Sol.
model: gpt-5.6-sol@medium
---
You are the reviewer for this session. Verify the change yourself and report
the conclusion only.
```

El esfuerzo por llamada va en la **primera línea** del prompt del subagente:
`[[ripple: gpt-5-6-terra@high]]`; ahí sirve cualquier nombre de agente o ID de modelo. Un
marcador en cualquier otro lugar es texto normal y se ignora (un resumen de compactación
que cite uno no debe redirigir la sesión). Un modelo que el router no sabe ubicar se
rechaza indicando su nombre (`400 ClaudeRipple: no provider declares "…"`) en lugar de
enviarse para que falle en algún sitio donde el error se entienda peor; los modelos
nativos de Claude siempre pasan. Configura `"cli": { "agentFiles": false }` para
desactivar la generación.

Por defecto, un worker generado hereda todas las herramientas de la sesión, así que cada
servidor MCP y cada plugin acompañan cada solicitud del worker. `"cli": {
"limitWorkerTools": true }` (o **Herramientas de los workers** en el panel) le da solo
las herramientas de lectura, edición, ejecución, búsqueda y skills, lo que redujo la
primera solicitud de un worker de unos 33k a 9k tokens. Un worker así no tiene
herramientas de navegador ni de simulador. Un worker que las necesite debe ir en un
archivo de agente propio, que nunca se toca.

Con un proveedor de ChatGPT configurado, las imágenes salen de la misma suscripción:

```bash
clauderipple image "a red paper boat, flat illustration" -o boat.png --aspect square
```

`--transparent`, `--format png|jpeg|webp` y `--ref FILE` (una imagen de referencia; se
puede repetir) son opcionales. Cada imagen tarda unos 30 segundos. El backend de la
suscripción elige por sí mismo la resolución y la calidad, así que la forma se pide con
palabras (`--aspect`). El comando es un cliente de `POST /api/image` en el puerto de
administración, que responde con los bytes de la imagen. A los workers generados se les
indica la forma `curl` de esa llamada, así que un worker que solo tenga Bash puede crear
una imagen y volver a leerla.

Claude Code ejecuta `WebSearch` como una solicitud aparte a un modelo pequeño. Para que
una configuración redirigida a ChatGPT no gaste cuota de Anthropic en esa solicitud,
elige el mismo proveedor de ChatGPT como backend de búsqueda en `config.json`:

```jsonc
{ "webSearch": { "provider": "chatgpt", "model": "gpt-5.6-terra" } }
```

Es opcional. Sin el ajuste `webSearch`, la ruta de búsqueda actual de Claude Code no
cambia.

### App de Codex y Codex CLI

```bash
clauderipple codex on     # adds a "clauderipple" provider to ~/.codex/config.toml (backup first)
codex --profile clauderipple -m claude-sonnet-5
```

`codex on` también apunta el proveedor OpenAI integrado de Codex a ClaudeRipple (`openai_base_url`).
Codex conserva su inicio de sesión de ChatGPT; sus solicitudes GPT siguen llegando a ChatGPT sin
cambios, salvo que la cuenta se elige entre las añadidas a ClaudeRipple, así que, con varias
añadidas, Codex también pasa de una cuenta agotada a la siguiente. Si no hay ninguna añadida, o
todas están en su límite, se usa el inicio de sesión propio de Codex. Un `openai_base_url` que
hayas configurado tú no se toca. `clauderipple codex off` lo deshace.

Los modelos de Claude aparecen con su nombre en la lista de modelos de Codex (ClaudeRipple
escribe un catálogo de modelos junto al de Codex). Se accede a Claude mediante tu inicio de
sesión de Claude Code (detectado en la sesión de Desktop en ejecución, en el inicio de sesión
de la terminal o en un inicio de sesión propio de ClaudeRipple:
**Proveedores → Claude (Anthropic) → + Añadir cuenta de Claude** abre el navegador, sin
necesidad de terminal; equivale a
`clauderipple claude-login`) o mediante una clave de API de Anthropic. Reutilizar el inicio
de sesión de una suscripción está sujeto a los términos de Anthropic. Cualquier proveedor
compatible con Anthropic que hayas configurado está disponible de la misma forma.

<p align="center">
  <img src="docs/media/add-provider.png" width="880" alt="Añadir proveedor: suscripción de ChatGPT, ajustes predefinidos, proveedores compatibles con OpenAI">
</p>

## Proveedores

| Proveedor | Tipo | Autenticación | Lista de modelos | Notas |
|---|---|---|---|---|
| Suscripción de ChatGPT | Backend de Codex | varios inicios de sesión, con cambio cuando uno se agota (también reutiliza el de Codex) | leída de tu suscripción (GPT-6 Sol, Luna, Astra, GPT-5.6 …) | esfuerzo low…max (Luna: ultra), caché de prompts 94–99 % |
| Google Gemini | API de Gemini | clave de API de AI Studio o inicio de sesión con cuenta de Google (Antigravity, consulta las preguntas frecuentes) | descubierta | traducido (Messages ⇄ generateContent), las firmas de pensamiento se conservan entre turnos |
| Suscripción de Grok | proxy de chat de la CLI de Grok | el inicio de sesión de la CLI de Grok (`grok login`), renovado por la CLI | leída de tu suscripción (Grok 4.7, 4.7 Fast, 4.6, 4.5) | traducido (Chat Completions), esfuerzo low…xhigh; canal propio de la CLI, no una API publicada ([§4e](docs/ARCHITECTURE.md#4e-grok-providers-implemented-2026-10-08)) |
| OpenRouter | Compatible con Anthropic | clave de API | más de 400, descubierta | compatibilidad de esfuerzo por modelo leída de la API |
| DeepSeek, Kimi, Z.ai GLM, MiniMax, Qwen (intl / cn) | Compatible con Anthropic | clave de API | predefinida | verificado con la documentación del proveedor |
| xAI Grok, Mistral, Groq, Together, Fireworks | Compatible con OpenAI | clave de API | descubierta | traducido (Chat Completions / Responses) |
| Ollama, LM Studio | Compatible con OpenAI, local | ninguna | descubierta | |
| Anthropic | nativo | inicio(s) de sesión de Claude o clave de API | modelos de Claude | rotación opcional de cuentas con afinidad por conversación para Claude Desktop/Code; Codex elige un inicio de sesión |
| Cualquier otro | personalizado | a tu elección | descubierta | cualquier endpoint compatible con Anthropic u OpenAI |

Se eliminan de las solicitudes a proveedores compatibles los campos exclusivos de Anthropic
(hilos del lado del servidor, herramientas diferidas, gestión del contexto, vinculaciones de
pensamiento) y el esfuerzo se limita a los niveles que admite cada modelo, para que los
proveedores no rechacen con un error 400 el formato de las solicitudes de Claude Code.

## Cómo funciona

```
Claude Desktop / claude CLI ──HTTPS_PROXY──▶ ClaudeRipple ──▶ api.anthropic.com   (unchanged)
                                               │
                        mapped model ──────────┼──▶ chatgpt.com/backend-api (Responses ⇄ Messages)
                                               ├──▶ Anthropic-compatible vendors (+ compat layer)
                                               ├──▶ OpenAI-compatible vendors (Messages ⇄ Chat/Responses)
                                               └──▶ Google Gemini (Messages ⇄ generateContent)
Codex app / CLI ──/v1/responses──▶ ClaudeRipple ingress ──▶ Claude (your login or API key) / vendors
```

- La CLI de Claude Code lee `HTTPS_PROXY` y `NODE_EXTRA_CA_CERTS` de
  `~/.claude/settings.json` (la vía de proxy corporativo que documenta Anthropic). Solo ese
  proceso confía en la CA local de ClaudeRipple; el llavero del sistema operativo no se toca
  salvo que actives el modo selector.
- El modo selector enruta a través del proxy el propio tráfico de claude.ai de la app y
  añade tus modelos a la lista del selector que la app obtiene al arrancar. Se vuelve a
  desactivar con un clic.
- Al reiniciarse, el router deja terminar las llamadas en curso; ante fallos repetidos del
  upstream se cierra solo para que launchd lo reinicie; rota los registros y nunca descarta una
  solicitud en silencio.

Detalles con fuentes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Privacidad

Todo se ejecuta en 127.0.0.1. Las claves de API se guardan en `~/.clauderipple/config.json`
y las autorizaciones OAuth de Claude añadidas, en `~/.clauderipple/claude-accounts.json`
(ambos con permisos 0600). Las API de administración y los registros no exponen ni tokens ni
ID de cuentas upstream. Los únicos destinos de red son los proveedores que configures. No hay
telemetría.

## Estado: alfa

El autor lo usa a diario, pero es un proyecto joven. Cuenta con algunas asperezas:

- **La compatibilidad con Windows es nueva (2026-09-14).** La instalación, la configuración,
  el router, el inicio de sesión, el selector y una llamada real a GPT están verificados en
  hardware x64; la recuperación tras fallos, en arm64. La ventana todavía tiene la barra de
  título estándar de Windows. Las compilaciones para Windows no están firmadas; consulta la
  nota en Instalación.
- **La compatibilidad con Linux es nueva (2026-09-24)**, aportada con mediciones en Ubuntu
  24.04 x64 (instalación, una solicitud de la pestaña Code, reinicio en mitad del streaming,
  modo selector, desinstalación). Requiere una sesión de usuario de systemd; otras
  distribuciones y arm64 no se han probado.
- ChatGPT, OpenRouter y Claude en Codex están verificados con cuentas reales; los demás
  ajustes predefinidos siguen la documentación oficial de los proveedores.
- Un modelo añadido al selector se puede usar a partir de la siguiente sesión.
- Claude Code y Codex cambian a menudo sus protocolos de comunicación; una actualización del
  cliente puede romper una traducción hasta que ClaudeRipple se ponga al día. Se agradecen
  los informes de errores y los registros.

## Sin afiliación

ClaudeRipple es un proyecto independiente de código abierto. No está afiliado a Anthropic ni
a OpenAI, ni cuenta con su respaldo ni con su patrocinio. Claude y Claude Code son marcas
comerciales de Anthropic, PBC. ChatGPT y Codex son marcas comerciales de OpenAI.

## Licencia

Copyright (c) 2026 pbj. GPL-3.0: consulta [LICENSE](LICENSE). Úsalo libremente; si distribuyes
una versión modificada, incluye su código fuente con la misma licencia.
