# Junction

Ein VS-Code-Chatseitenleiste, die Ihren Editor mit lokalen KI-Coding-Agenten verbindet.

`7 Backends` · `Chatseitenleiste` · `Arbeitsbereichskontext` · `Animierter Startbildschirm` · `MIT-Lizenz`

![Zwei vertraute Themes](../media/two_familiar_skins.png)

Junction ist ein Chat-Panel für VS Code, das sich mit lokalen KI-Coding-Agenten auf Ihrem Rechner verbindet.
Es spricht über eine einheitliche Oberfläche mit mehreren Agent-Backends — wechseln Sie zwischen ihnen, ohne Ihren Workflow zu ändern.

## Unterstützte Backends

Junction verbindet sich mit jeder dieser lokalen Agent-Laufzeitumgebungen:

- **OpenClaw** — WebSocket-Gateway-Integration mit Sitzungs- und Modellverwaltung
- **Hermes** — Native Dashboard-WebSocket- und REST-API-Unterstützung
- **Souveraine** — HTTP-Server-Integration mit verwaltetem Laufzeit-Spawning
- **MiMoCode** — Automatisch gestartete oder vorkonfigurierte MiMo-Serververbindung
- **Goose** — Datenverzeichnis- und Geheimer-Schlüssel-Konfiguration
- **OpenCode** — Binärpfad- und Konfigurationsverzeichnis-Einstellungen
- **OpenHands** — Server-Starter und Home-Verzeichnis-Konfiguration

## Funktionen

### Chatseitenleiste
Sprechen Sie mit Ihrem aktiven Agent über VS Codes sekundäre Seitenleiste. Öffnen Sie über die Befehlspalette: `Junction: Open Sidebar`.

### Arbeitsbereichskontext
Ziehen Sie Dateien per Drag-and-Drop in das Chat-Eingabefeld, oder klicken Sie mit der rechten Maustaste auf eine Datei oder Auswahl, um sie zum aktuellen Gespräch hinzuzufügen.

### Modell- und Reasoning-Auswahl
Wählen Sie ein Modell und stellen Sie die Reasoning-Anstrengung pro Sitzung über die Seitenleisten-Kopfzeile ein.

### Markdown-Rendering
Assistentenantworten, Tool-Aufrufkarten, Reasoning-Blöcke und Diffs werden inline mit Syntaxhervorhebung gerendert.

### Chat-Layouts
Wechseln Sie zwischen dem Kompaktmodus (Aktivität in Akkordeons gefaltet) und dem Zeitachsenmodus (chronologischer Reasoning-Fluss mit feststehenden Benutzer-Eingabeaufforderungen).

### Folge-Modi
Reihen Sie Nachrichten für die Fertigstellung des Agents in die Warteschlange ein, steuern Sie ihn mid-turn, oder unterbrechen Sie und leiten Sie um. Global oder pro Bridge konfigurierbar.

### Automatische Wiederverbindung
Junction verbindet sich automatisch wieder mit der Laufzeitumgebung, wenn die Verbindung abbricht. Kein manueller Neustart nötig.

## Themes

Junction enthält zwei integrierte Layouts. Der **Kompaktmodus** faltet Aktivität in Zusammenfassungs-Akkordeons für eine dichte Ansicht.
Der **Zeitachsenmodus** zeigt eine chronologische Aktivitätsleiste mit Punkte-Indikatoren, Reasoning-Einblendung und einem orangefarbenen Akzent-Theme.
Beide Layouts passen sich an Ihr VS-Code-Farb-Theme an.

## Startbildschirm und Animationen

Junction öffnet sich mit einem animierten Startbildschirm mit einem Matrix-Regeneffekt hinter dem Schriftzug.
Der Startbildschirm ist über das Animationseinstellungs-Panel im Editor vollständig anpassbar.

### Zeichensätze
Der Regeneffekt unterstützt 10 Zeichensätze: Katakana, Matrix-Latein, Latein, Hiragana, CJK, Hangul, Emoji, Binär, Symbole und Benutzerdefiniert.
Mischen Sie Emoji-Tropfen mit konfigurierbarer Seltenheit, oder liefern Sie Ihren eigenen Zeichensatz.

### Regen-Steuerung
- **Richtung** — Regen fällt nach oben oder unten umschalten
- **Umkehrwahrscheinlichkeit** — Prozentsatz für Tropfen in die entgegengesetzte Richtung einstellen
- **Seiten abprallen** — Regen prallt von links/rechts Kanten ab, anstatt vom Bildschirm zu fallen
- **Gravitation, Abprallen, Kollision, Geschwindigkeit** — Anpassen, wie sich die Tropfen bewegen und mit dem Schriftzug interagieren
- **Mengengröße, Größenvarianz, Farbvarianz, Deckkraftbereich** — Dichte und Aussehen des Regens steuern
- **Benutzerdefinierte Farbe** — Farbe und Alpha für Regen und Schriftzug wählen
- **Emoji-Mischung** — einschalten und Seltenheit als 1/N einstellen (1 = nur Emoji, 1000000 = eins in einer Million)

### Exit-Animationen
Wenn der Startbildschirm ausgeblendet wird, verlässt der Schriftzug über einen von 9 Animationsmodi.
Jeder Modus hat eigene Schieberegler, die einblenden, wenn Sie ihn aus dem Dropdown auswählen.

- **Spiral out** — Buchstaben spiralen vom Zentrum nach außen
- **Spiral in** — Buchstaben konvergieren in eine sich verengende Spirale mit konfigurierbarem Radius und Länge
- **Explode** — Buchstaben platzen mit Gravitation nach außen
- **Explode 2** — Physikbasierte Explosion mit Abprallen an Kanten, konfigurierbare Kraft, Chaos und Achsmomentum
- **Float away** — Buchstaben treiben mit richtungsbasierter Neigung nach oben
- **Horizontal flatten** — Buchstaben breiten sich horizontal aus und werden zu einer 1px-Linie gequetscht mit konfigurierbarer Haltezeit
- **Explode weak** — eine weichere Explosion mit weniger Kraft
- **Starwars crawl** — Buchstaben konvergieren zu einem Fluchtpunkt mit konfigurierbarer Ziel-Y-Position
- **Explode 3** — der Schriftzug zersplittert in einzelne Pixel mit Achsmomentum-Steuerung
- **Rain push** — Buchstaben lösen sich ab und der Regen schiebt sie physisch vom Bildschirm
- **Random** — wählt jedes Mal einen anderen Modus

### Animationseinstellungs-Panel
Öffnen Sie die Animationseinstellungen über das Zahnrad-Symbol in der Chat-Kopfzeile. Es hat drei Registerkarten — Chat, Bobber und Splash.
Die Registerkarte Splash enthält zwei einklappbare Akkordeons (Erscheinungsbild und Bewegung), das Exit-Modus-Dropdown mit Modus-spezifischen Schieberegeln und eine Live-Vorschau-Leinwand, auf die Sie klicken können, um Animationen zu testen.
Das Panel ist vollständig verschiebbar und in der Größe veränderbar ohne Höhenbegrenzung.

## Installation

### Aus dem Quellcode
```bash
npm install
./compile-and-install.sh
# Dann: Ctrl+Shift+P → Developer: Reload Window
```

### Anforderungen
- VS Code 1.120.0 oder höher
- Eine laufende lokale Agent-Laufzeitumgebung (z.B. OpenClaw Gateway, Hermes-Dashboard, Souveraine-Server)


## Danksagungen

Basiert auf [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) von Owen-Liuyuxuan (MIT).
Die WebSocket/Gateway-Architektur geht auf dieses Projekt zurück.
Die Multi-Bridge-Architektur, die modulare Webview-Oberfläche, die Animations-Engine und die Modell-/Sitzungsmanager sind original von Junction.

---

MIT-Lizenz. © Owen-Liuyuxuan (originäres openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
