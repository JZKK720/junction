# Junction

En VS Code-chatpanel som kopplar din editor till lokala AI-kodningsagenter.

`7 backends` · `Chatpanel` · `Arbetsytekontext` · `Animerad splash` · `MIT-licens`

![Två bekanta teman](../media/two_familiar_skins.png)

Junction är en chattpanel för VS Code som ansluter till lokala AI-kodningsagenter som körs på din maskin.
Den kommunicerar med flera agentbackends genom ett enhetligt gränssnitt — växla mellan dem utan att ändra ditt arbetsflöde.

## Bakändesystem som Stöds

Junction ansluter till någon av dessa lokala agentkörningsmiljöer:

- **OpenClaw** — WebSocket-gatewayintegration med sessions- och modellhantering
- **Hermes** — Inbyggt stöd för dashboard-WebSocket och REST API
- **Souveraine** — HTTP-serverintegration med hanterad runtime-spawning
- **MiMoCode** — Auto-startad eller förkonfigurerad MiMo-serveranslutning
- **Goose** — Datakatalog- och hemlig nyckelkonfiguration
- **OpenCode** — Sökväg till binärfil och config home-inställningar
- **OpenHands** — Serverstartare och hemkatalogkonfiguration

## Funktioner

### Chattpanel
Prata med din aktiva agent från VS Codes sekundära sidopanel. Öppna via Command Palette: `Junction: Open Sidebar`.

### Arbetsytekontext
Dra och släpp filer i chattinmatningen, eller högerklicka på en fil eller markering för att lägga till den i den aktuella tråden.

### Modell- och Resoneringsväljare
Välj en modell och ställ in resoneringsansträngning per session från sidopanelens rubrik.

### Markdown-rendering
Assistentsvar, verktygsanropskort, resonemangsblock och diffar renderas inline med syntaxmarkering.

### Chattlayouter
Växla mellan kompakt läge (aktivitet viktig i dragspel) och tidslinjeläge (kronologiskt resonemangsflöde med fasta användarpromptar).

### Uppföljningslägen
Köa meddelanden för när agenten är klar, styr mitt i vändan, eller avbryt och omdirigera. Konfigurerbart globalt eller per bro.

### Automatisk Återanslutning
Junction återansluter till runtime automatiskt om anslutningen tappas. Ingen manuell omstart behövs.

## Teman

Junction inkluderar två inbyggda layouter. **Kompakt** läge viker aktivitet i sammandragsdragspel för en tät vy.
**Tidslinje**-läge visar en kronologisk aktivitetsrad med prickindikatorer, resonemangsutvidgning och ett orange accenttema.
Båda layouterna anpassar sig till ditt VS Code-färgtema.

## Splashskärm och Animationer

Junction öppnas med en animerad splashskärm med ett matrix-liknande regneffekt bakom logotypen.
Splashskärmen är helt anpassningsbar genom inställningspanelen för animationer i redigeraren.

### Teckenuppsättningar
Regneffekten stöder 10 teckenuppsättningar: Katakana, Matrix Latin, Latinska, Hiragana, CJK, Hangul, Emoji, Binära, Symboler och Anpassad.
Blanda in emoji-droppar med konfigurerbar sällsynthet, eller tillhandahåll din egen teckenuppsättning.

### Regkontroller
- **Riktning** — växla mellan reg som faller uppåt eller nedåt
- **Omvändningschans** — ange en procentandel för droppar som går i motsatt riktning
- **Kantstuds** — reg studsar från vänster-/högerkanter istället för att falla av skärmen
- **Gravitation, studs, kollision, hastighet** — justera hur dropparna rör sig och interagerar med logotypen
- **Mängd, storleksvarians, färgvarians, opacitetsintervall** — kontrollera regnets densitet och utseende
- **Anpassad färg** — välj en färg och alfa för regnet och logotypen
- **Emoji-mixning** — aktivera och ställ in sällsynthet som 1/N (1 = alla emoji, 1000000 = en på en miljon)

### Avslutsanimationer
När splashen stängs av, lämnar logotypen genom ett av 9 animationslägen.
Varje läge har sin egen uppsättning reglage som visas när du väljer det från rullgardinsmenyn.

- **Spiral out** — bokstäver spiralar utåt från mitten
- **Spiral in** — bokstäver konvergerar i en avsmalnande spiral med konfigurerbar radie och längd
- **Explode** — bokstäver exploderar utåt med gravitation
- **Explode 2** — fysikbaserad explosion med studs från kanter, konfigurerbar kraft, kaos och moment per axel
- **Float away** — bokstäver flyter uppåt med riktningsbaserad lutning
- **Horizontal flatten** — bokstäver sprids horisontellt och krossas till en 1px-linje med konfigurerbar hålltid
- **Explode weak** — en mjukare explosion med mindre kraft
- **Starwars crawl** — bokstäver konvergerar mot en försvinningspunkt med konfigurerbar mål-Y-position
- **Explode 3** — logotypen splittras i enskilda pixlar med momentkontroll per axel
- **Rain push** — bokstäver kopplas loss och regnet fysiskt knuffar ut dem från skärmen
- **Random** — väljer ett annat läge varje gång

### Inställningspanel för Animationer
Öppna animationsinställningarna från kugghjulsikonen i chattrubriken. Den har tre flikar — Chat, Bobber och Splash.
Splash-fliken innehåller ihopfällbara dragspel (Utseende och Rörelse), rullgardinsmenyn för avslutsläge med lägesspecifika reglage, och en liveförhandsvisningscanvas du kan klicka på för att testa animationer.
Panelen är helt dragbar och storleksändbar utan höjdbegränsning.

## Installation

### Från källkod
```bash
npm install
./compile-and-install.sh
# Sedan: Ctrl+Shift+P → Developer: Reload Window
```

### Krav
- VS Code 1.120.0 eller högre
- En lokal agentkörningsmiljö som körs (t.ex. OpenClaw Gateway, Hermes-dashboard, Souveraine-server)

---

## Erkännanden

Baserad på [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) av Owen-Liuyuxuan (MIT).
WebSocket/gateway-infrastrukturen härstammar från det projektet.
Multi-bridge-arkitekturen, den modulära webview-gränssnittet, animationsmotorn och modell-/sessionshanterarna är originalverk för Junction.

---

MIT-licens. © Owen-Liuyuxuan (original openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
