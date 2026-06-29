# Junction

Un panel lateral de chat para VS Code que conecta tu editor con agentes de código locales.

`7 backends` · `Panel de chat` · `Contexto del espacio de trabajo` · `Splash animado` · `Licencia MIT`

![Dos temas familiares](../media/two_familiar_skins.png)

Junction es un panel de chat para VS Code que se conecta a agentes de código impulsados por IA que se ejecutan en tu máquina.
Se comunica con múltiples backends de agentes a través de una interfaz unificada — cámbialos sin alterar tu flujo de trabajo.

## Backends compatibles

Junction se conecta a cualquiera de estos tiempos de ejecución de agentes locales:

- **OpenClaw** — integración WebSocket gateway con gestión de sesiones y modelos
- **Hermes** — soporte nativo de WebSocket y REST API del dashboard
- **Souveraine** — integración de servidor HTTP con spawning de runtime administrado
- **MiMoCode** — conexión auto-iniciada o preconfigurada al servidor MiMo
- **Goose** — configuración de directorio de datos y clave secreta
- **OpenCode** — ruta del binario y ajustes de directorio de configuración
- **OpenHands** — lanzador de servidor y configuración de directorio home

## Funcionalidades

### Panel de chat
Conversa con tu agente activo desde la barra lateral secundaria de VS Code. Ábrelo desde la Paleta de Comandos: `Junction: Open Sidebar`.

### Contexto del espacio de trabajo
Arrastra y suelta archivos en el campo de entrada del chat, o haz clic derecho en un archivo o selección para añadirlo al hilo actual.

### Selector de modelo y razonamiento
Selecciona un modelo y ajusta el esfuerzo de razonamiento por sesión desde el encabezado del panel lateral.

### Renderizado de Markdown
Las respuestas del asistente, las tarjetas de llamadas a herramientas, los bloques de razonamiento y los diffs se renderizan en línea con resaltado de sintaxis.

### Diseños de chat
Alterna entre el modo compacto (la actividad se pliega en acordeones) y el modo línea de tiempo (flujo cronológico de razonamiento con prompts de usuario fijos).

### Modos de seguimiento
Pon mensajes en cola para cuando el agente termine, guía en medio del turno, o interrumpe y redirige. Configurable globalmente o por cada bridge.

### Reconexión automática
Junction se reconecta al runtime automáticamente si la conexión se cae. No necesitas reiniciar manualmente.

## Temas

Junction incluye dos diseños integrados. El modo **Compacto** pliega la actividad en acordeones de resumen para una vista densa.
El modo **Línea de tiempo** muestra un carril de actividad cronológico con indicadores punto, despliegue de razonamiento y un tema con acento naranja.
Ambos diseños se adaptan al tema de color de tu VS Code.

## Pantalla de inicio y animaciones

Junction se abre con una pantalla de inicio animada que presenta un efecto de lluvia estilo matrix detrás del logotipo.
La pantalla de inicio es totalmente personalizable a través del panel de ajustes de animación integrado en el editor.

### Juegos de caracteres
El efecto de lluvia soporta 10 juegos de caracteres: Katakana, Matrix Latin, Latin, Hiragana, CJK, Hangul, Emoji, Binary, Symbols y Custom.
Mezcla gotas de emoji con una rareza configurable, o proporciona tu propio conjunto de caracteres.

### Controles de lluvia
- **Dirección** — alterna si la lluvia cae hacia arriba o hacia abajo
- **Probabilidad de reversa** — establece un porcentaje para que las gotas vayan en la dirección opuesta
- **Rebote en bordes** — la lluvia rebota en los bordes izquierdo/derecho en vez de salir de la pantalla
- **Gravedad, rebote, colisión, velocidad** — ajusta cómo se mueven las gotas e interactúan con el logotipo
- **Cantidad, varianza de tamaño, varianza de color, rango de opacidad** — controla la densidad y apariencia de la lluvia
- **Color personalizado** — elige un color y transparencia para la lluvia y el logotipo
- **Mezcla de emojis** — activa y establece la rareza como 1/N (1 = todo emojis, 1000000 = uno en un millón)

### Animaciones de salida
Cuando la pantalla de inicio se cierra, el logotipo sale a través de uno de 9 modos de animación.
Cada modo tiene su propio conjunto de controles deslizantes que aparecen al seleccionarlo del menú desplegable.

- **Espiral hacia afuera** — las letras se espiralan hacia afuera desde el centro
- **Espiral hacia adentro** — las letras convergen en una espiral que se estrecha con radio y longitud configurables
- **Explotar** — las letras estallan hacia afuera con gravedad
- **Explotar 2** — explosión basada en física con rebote en bordes, fuerza, caos y momento por eje configurables
- **Flotar** — las letras se elevan con inclinación basada en dirección
- **Aplastamiento horizontal** — las letras se extienden horizontalmente y se comprimen en una línea de 1px con tiempo de retención configurable
- **Explotar suave** — una explosión más suave con menos fuerza
- **Avance estilo Star Wars** — las letras convergen a un punto de fuga con posición Y objetivo configurable
- **Explotar 3** — el logotipo se fragmenta en píxeles individuales con control de momento por eje
- **Empuje de lluvia** — las letras se desprenden y la lluvia las empuja físicamente fuera de la pantalla
- **Aleatorio** — elige un modo diferente cada vez

### Panel de ajustes de animación
Abre los ajustes de animación desde el ícono de engranaje en el encabezado del chat. Tiene tres pestañas: Chat, Bobber y Splash.
La pestaña Splash contiene dos acordeones colapsables (Apariencia y Movimiento), el menú desplegable del modo de salida con controles por modo, y un lienzo de vista previa en vivo donde puedes hacer clic para probar animaciones.
El panel es totalmente arrastrable y redimensionable sin límite de altura.

## Instalación

### Desde el código fuente
```bash
npm install
./compile-and-install.sh
# Luego: Ctrl+Shift+P → Developer: Reload Window
```

### Requisitos
- VS Code 1.120.0 o superior
- Un runtime de agente local en ejecución (por ejemplo, OpenClaw Gateway, dashboard de Hermes, servidor de Souveraine)

---

> Hay huevos de Pascua. No están documentados aquí. Ese es el punto.

## Créditos

Basado en [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) de Owen-Liuyuxuan (MIT).
La infraestructura de WebSocket/gateway proviene de ese proyecto.
La arquitectura multi-bridge, la UI modular del webview, el motor de animación y los gestores de modelo/sesión son originales de Junction.

---

Licencia MIT. © Owen-Liuyuxuan (openclaw_vscode original), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
