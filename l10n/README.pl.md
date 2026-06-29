# Junction

Panel czatu dla VS Code łączący edytor z lokalnymi agentami kodowania AI.

`7 backendów` · `Panel czatu` · `Kontekst workspace'u` · `Animowany splash` · `Licencja MIT`

![Dwa znajome motywy](../media/two_familiar_skins.png)

Junction to panel czatu dla VS Code łączący się z lokalnymi agentami kodowania AI działającymi na twoim komputerze.
Komunikuje się z wieloma backendami agentów przez jeden zunifikowany interfejs — przełączaj się między nimi bez zmiany workflowu.

## Obsługiwane Backendy

Junction łączy się z dowolnym z tych lokalnych runtime'ów agentów:

- **OpenClaw** — Integracja z WebSocket gateway z zarządzaniem sesjami i modelami
- **Hermes** — Natywne wsparcie WebSocket dashboardu i REST API
- **Souveraine** — Integracja z serwerem HTTP z zarządzanym uruchamianiem runtime'u
- **MiMoCode** — Automatycznie uruchamiane lub wstępnie skonfigurowane połączenie z serwerem MiMo
- **Goose** — Konfiguracja katalogu danych i klucza tajnego
- **OpenCode** — Ustawienia ścieżki binarnej i config home
- **OpenHands** — Launcher serwera i konfiguracja katalogu domowego

## Funkcje

### Panel Czatu
Rozmawiaj z aktywnym agentem z panelu bocznego VS Code. Otwórz przez Command Palette: `Junction: Open Sidebar`.

### Kontekst Workspace'u
Przeciągnij i upuść pliki na pole wprowadzania czatu, lub kliknij prawym przyciskiem na plik lub zaznaczenie, aby dodać je do bieżącego wątku.

### Wybór Modelu i Rozumowania
Wybierz model i ustaw poziom rozumowania na sesję z nagłówka panelu bocznego.

### Renderowanie Markdown
Odpowiedzi asystenta, karty wywołań narzędzi, bloki rozumowania i diffy renderowane inline z podświetleniem składni.

### Układy Czatu
Przełączaj między trybem kompaktowym (aktywność zwinięta w akordeony) a trybem osi czasu (chronologiczny przepływ rozumowania z przypiętymi promptami użytkownika).

### Tryby Follow-Up
Kolejkuj wiadomości na moment gdy agent skończy, naprowadzaj w trakcie tury, lub przerywaj i przekierowuj. Konfigurowalne globalnie lub per bridge.

### Automatyczne Ponowne Połączenie
Junction automatycznie łączy się ponownie z runtime'em jeśli połączenie spadnie. Nie wymaga ręcznego restartu.

## Motywy

Junction zawiera dwa wbudowane układy. Tryb **Kompaktowy** zwija aktywność w akordeony podsumowań dla zagęszczonego widoku.
Tryb **Oś czasu** wyświetla chronologiczny pasek aktywności ze wskaźnikami kropkowymi, rozwijaniem rozumowania i pomarańczowym motywem akcentującym.
Oba układy adaptują się do twojego motywu kolorystycznego VS Code.

## Ekran Powitalny i Animacje

Junction otwiera się animowanym ekranem powitalnym z efektem deszczu w stylu matrix za znakiem słownym.
Ekran powitalny jest w pełni konfigurowalny przez panel ustawień animacji w edytorze.

### Zestawy Znaków
Efekt deszczu obsługuje 10 zestawów znaków: Katakana, Matrix Latin, Łacińskie, Hiragana, CJK, Hangul, Emoji, Binarny, Symbole i Niestandardowy.
Mieszaj krople emoji z konfigurowalną rzadkością, lub dostarcz własny zestaw znaków.

### Sterowanie Deszczem
- **Kierunek** — przełącz deszcz spadający w górę lub w dół
- **Szansa odwrócenia** — ustaw procent kropli idących w przeciwnym kierunku
- **Odbicie od krawędzi** — deszcz odbija się od lewej/prawej krawędzi zamiast spadać poza ekran
- **Grawitacja, odbicie, kolizja, prędkość** — dostosuj ruch kropli i ich interakcję ze znakiem słownym
- **Ilość, wariancja rozmiaru, wariancja koloru, zakres nieprzezroczystości** — kontroluj gęstość i wygląd deszczu
- **Niestandardowy kolor** — wybierz kolor i alfa dla deszczu i znaku słownego
- **Mieszanie emoji** — włącz i ustaw rzadkość jako 1/N (1 = same emoji, 1000000 = jeden na milion)

### Animacje Wyjścia
Gdy splash się zamyka, znak słowny wychodzi przez jeden z 9 trybów animacji.
Każdy tryb ma własny zestaw suwaków sterujących, które pojawiają się po wybraniu go z listy rozwijanej.

- **Spiral out** — litery spiralnie oddalają się od środka
- **Spiral in** — litery zbiegają się w zwężającą spiralę z konfigurowalnym promieniem i długością
- **Explode** — litery eksplodują na zewnątrz z grawitacją
- **Explode 2** — fizyczna eksplozja z odbijaniem od krawędzi, konfigurowalna siła, chaos i momentum per oś
- **Float away** — litery unoszą się w górę z nachyleniem zależnym od kierunku
- **Horizontal flatten** — litery rozciągają się poziomo i zgniatają do linii 1px z konfigurowalnym czasem przytrzymania
- **Explode weak** — łagodniejsza eksplozja z mniejszą siłą
- **Starwars crawl** — litery zbiegają do punktu zanikania z konfigurowalną pozycją Y celu
- **Explode 3** — znak słowny rozbija się na pojedyncze piksele z kontrolą momentum per oś
- **Rain push** — litery odłączają się i deszcz fizycznie wypycha je poza ekran
- **Random** — wybiera inny tryb za każdym razem

### Panel Ustawień Animacji
Otwórz ustawienia animacji z ikony zębatki w nagłówku czatu. Ma trzy zakładki — Chat, Bobber i Splash.
Zakładka Splash zawiera dwa zwijane akordeony (Wygląd i Ruch), listę rozwijaną trybu wyjścia z suwakami per tryb, i żywy podgląd na canvasie, w który możesz klikać aby testować animacje.
Panel jest w pełni przeciągalny i skalowalny bez limitu wysokości.

## Instalacja

### Ze źródła
```bash
npm install
./compile-and-install.sh
# Następnie: Ctrl+Shift+P → Developer: Reload Window
```

### Wymagania
- VS Code 1.120.0 lub nowszy
- Działający lokalny runtime agenta (np. OpenClaw Gateway, dashboard Hermes, serwer Souveraine)

---

## Autorzy

Oparty na [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) autorstwa Owen-Liuyuxuan (MIT).
Infrastruktura WebSocket/gateway wywodzi się z tego projektu.
Architektura multi-bridge, modularny interfejs webview, silnik animacji i menedżery modeli/sesji są oryginalne dla Junction.

---

Licencja MIT. © Owen-Liuyuxuan (oryginalny openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
