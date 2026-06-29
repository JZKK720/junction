# Junction

Een VS Code-chatzijbalk die je editor verbindt met lokale AI-coderingsagenten.

`7 backends` · `Chatzijbalk` · `Werkruimte-context` · `Geanimeerde splash` · `MIT-licentie`

![Twee vertrouwde thema's](../media/two_familiar_skins.png)

Junction is een chatpaneel voor VS Code dat verbinding maakt met lokale AI-coderingsagenten op je machine.
Het communiceert met meerdere agentbackends via één uniforme interface — schakel ertussen zonder je workflow te veranderen.

## Ondersteunde Backends

Junction maakt verbinding met een van deze lokale agentruntimes:

- **OpenClaw** — WebSocket-gatewayintegratie met sessie- en modelbeheer
- **Hermes** — Native dashboard-WebSocket- en REST API-ondersteuning
- **Souveraine** — HTTP-serverintegratie met beheerde runtime-spawning
- **MiMoCode** — Automatisch gestarte of vooraf geconfigureerde MiMo-serververbinding
- **Goose** — Datamap- en geheimesleutelconfiguratie
- **OpenCode** — Binaire pad- en config-home-instellingen
- **OpenHands** — Serverstarter en thuismapconfiguratie

## Functies

### Chatzijbalk
Praat met je actieve agent vanuit de secundaire zijbalk van VS Code. Open via Command Palette: `Junction: Open Sidebar`.

### Werkruimte-context
Sleep bestanden naar de chatinvoer, of klik met de rechtermuisknop op een bestand of selectie om het aan de huidige thread toe te voegen.

### Model- en Redeneringskiezer
Selecteer een model en stel de redeneringsinspanning per sessie in vanuit de zijbalkkop.

### Markdown-weergave
Antwoorden van de assistent, toolaanroepkaarten, redeneringsblokken en diffs worden inline weergegeven met syntaxisaccentuering.

### Chatlayouts
Schakel tussen compacte modus (activiteit opgevouwen in accordeons) en tijdlijnmodus (chronologische redeneringsstroom met vaste gebruikersprompts).

### Follow-upmodi
Wacht berichten in voor wanneer de agent klaar is, stuur bij halverwege de beurt, of onderbreek en herleid. Globaal of per bridge instelbaar.

### Automatische Herverbinding
Junction herstelt automatisch de verbinding met de runtime als deze wegvalt. Geen handmatige herstart nodig.

## Thema's

Junction bevat twee ingebouwde lay-outs. **Compacte** modus vouwt activiteit op in samenvattingsaccordeons voor een dichte weergave.
**Tijdlijn**modus toont een chronologische activiteitenbalk met stipindicatoren, redenering-uitvouwing en een oranje accentthema.
Beide lay-outs passen zich aan je VS Code-kleurthema aan.

## Splashscherm en Animaties

Junction opent met een geanimeerd splashscherm met een matrixachtig regeffect achter het woordmerk.
Het splashscherm is volledig aanpasbaar via het animatie-instellingenpaneel in de editor.

### Tekensets
Het regeffect ondersteunt 10 tekensets: Katakana, Matrix Latin, Latijns, Hiragana, CJK, Hangul, Emoji, Binair, Symbolen en Aangepast.
Meng emojidruppels met instelbare zeldzaamheid, of lever je eigen tekenset.

### Regbesturing
- **Richting** — wissel tussen regen die omhoog of omlaag valt
- **Omgekans** — stel een percentage in voor druppels die de tegenovergestelde richting opgaan
- **Zijwaarts stuiteren** — regen stuitert van linker-/rechterranden in plaats van van het scherm te vallen
- **Zwaartekracht, stuiteren, botsing, snelheid** — pas aan hoe de druppels bewegen en interacteren met het woordmerk
- **Hoeveelheid, groottevariatie, kleurvariatie, dekkingsbereik** — bestuur de dichtheid en het uiterlijk van de regen
- **Aangepaste kleur** — kies een kleur en alfa voor de regen en het woordmerk
- **Emoji-mixing** — schakel in en stel zeldzaamheid in als 1/N (1 = alle emoji, 1000000 = één op een miljoen)

### Exitanimaties
Wanneer het splashscherm verdwijnt, verlaat het woordmerk via een van de 9 animatiemodi.
Elke modus heeft zijn eigen set besturingsschuifregelaars die verschijnen wanneer je deze selecteert in de vervolgkeuzelijst.

- **Spiral out** — letters spiraal naar buiten vanuit het midden
- **Spiral in** — letters convergeren in een versmallende spiraal met instelbare straal en lengte
- **Explode** — letters barsten naar buiten met zwaartekracht
- **Explode 2** — op fysica gebaseerde explosie met stuiteren van randen, instelbare kracht, chaos en momentum per as
- **Float away** — letters drijven omhoog met richtingsgebonden kanteling
- **Horizontal flatten** — letters spreiden horizontaal uit en worden samengedrukt tot een 1px-lijn met instelbare wachttijd
- **Explode weak** — een zachtere explosie met minder kracht
- **Starwars crawl** — letters convergeren naar een verdwijnpunt met instelbare doel-Y-positie
- **Explode 3** — het woordmerk versplindert in individuele pixels met momentumbesturing per as
- **Rain push** — letters loskoppelen en de regen duwt ze fysiek van het scherm
- **Random** — kiest elke keer een andere modus

### Animatie-instellingenpaneel
Open de animatie-instellingen via het tandwielpictogram in de chatkop. Het heeft drie tabbladen — Chat, Bobber en Splash.
Het tabblad Splash bevat twee inklapbare accordeons (Uiterlijk en Beweging), de exitmodus-vervolgkeuzelijst met modusspecifieke schuifregelaars, en een live voorbeeldcanvas waarop je kunt klikken om animaties te testen.
Het paneel is volledig sleepbaar en verkleinbaar zonder hoogtelimiet.

## Installatie

### Vanuit bron
```bash
npm install
./compile-and-install.sh
# Dan: Ctrl+Shift+P → Developer: Reload Window
```

### Vereisten
- VS Code 1.120.0 of hoger
- Een draaiende lokale agentruntime (bijv. OpenClaw Gateway, Hermes-dashboard, Souveraine-server)

---

## Credits

Gebaseerd op [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) door Owen-Liuyuxuan (MIT).
De WebSocket/gateway-infrastructuur stamt uit dat project.
De multi-bridge architectuur, modulaire webview-UI, animatie-engine en model-/sessiebeheerders zijn origineel voor Junction.

---

MIT-licentie. © Owen-Liuyuxuan (originele openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
