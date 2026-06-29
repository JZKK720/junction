# Junction

Postranní panel chatu pro VS Code, který propojuje váš editor s lokálními AI agenty pro programování.

`7 backendů` · `Postranní panel chatu` · `Kontext pracovního prostoru` · `Animovaná úvodní obrazovka` · `MIT licence`

![Dva známé motivy](../media/two_familiar_skins.png)

Junction je chatovací panel pro VS Code, který se připojuje k lokálním AI agentům pro programování běžícím na vašem počítači.
Komunikuje s více backendy agentů přes jednotné rozhraní — přepínejte mezi nimi bez změny pracovního postupu.

## Podporované backendy

Junction se připojuje k libovolné z těchto lokálních běhových prostředí agentů:

- **OpenClaw** — integrace WebSocket gateway s řízením relací a modelů
- **Hermes** — nativní podpora nástěnky WebSocket a REST API
- **Souveraine** — integrace HTTP serveru s řízeným spouštěním běhového prostředí
- **MiMoCode** — automaticky spuštěné nebo předem nakonfigurované připojení k serveru MiMo
- **Goose** — konfigurace adresáře dat a tajného klíče
- **OpenCode** — nastavení cesty k binárnímu souboru a konfiguračního adresáře
- **OpenHands** — spouštěč serveru a konfigurace domovského adresáře

## Funkce

### Postranní panel chatu
Mluvte se svým aktivním agentem ze sekundárního postranního panelu VS Code. Otevřete přes paletu příkazů: `Junction: Open Sidebar`.

### Kontext pracovního prostoru
Přetáhněte soubory do vstupního pole chatu, nebo klikněte pravým tlačítkem na soubor či výběr a přidejte jej do aktuálního vlákna.

### Výběr modelu a úrovně uvažování
Vyberte model a nastavte úsilí uvažování pro relaci z hlavičky postranního panelu.

### Vykreslování Markdown
Odpovědi asistenta, karty volání nástrojů, bloky uvažování a rozdíly se vykreslují inline se zvýrazněním syntaxe.

### Rozložení chatu
Přepínejte mezi kompaktním režimem (aktivita složená do akordeonů) a časovým režimem (chronologický tok uvažování s pevnými výzvami uživatele).

### Režimy následování
Řaďte zprávy do fronty na dokončení agenta, řiďte agenta uprostřed běhu, nebo přerušte a přesměrujte. Konfigurovatelné globálně nebo pro každý můstek.

### Automatické znovupřipojení
Junction se automaticky znovu připojí k běhovému prostředí, pokud připojení spadne. Není potřeba manuální restart.

## Motivy

Junction obsahuje dva vestavěné motivy. **Kompaktní** režim složí aktivitu do souhrnných akordeonů pro hustý zobrazení.
**Časový** režim zobrazuje chronologickou lištu aktivit s tečkovými indikátory, odhalením uvažování a oranžovým akcentním motivem.
Oba motivy se přizpůsobí vašemu barevnému motivu VS Code.

## Úvodní obrazovka a animace

Junction se otevírá s animovanou úvodní obrazovkou s efektem deště ve stylu matice za logem.
Úvodní obrazovka je plně přizpůsobitelná prostřednictvím panelu nastavení animací v editoru.

### Sady znaků
Efekt deště podporuje 10 sad znaků: Katakana, Matrix Latin, Latina, Hiragana, CJK, Hangul, Emoji, Binární, Symboly a Vlastní.
Přidejte emoji kapky s konfigurovatelnou vzácností, nebo dodejte vlastní sadu znaků.

### Ovládání deště
- **Směr** — přepněte déšť padající nahoru nebo dolů
- **Šance na obrácení** — nastavte procento kapek jdoucích opačným směrem
- **Odrážení od okrajů** — déšť se odráží od levých/pravých okrajů místo aby padal z obrazovky
- **Gravitace, odraz, kolize, rychlost** — upravte pohyb kapek a jejich interakci s logem
- **Množství, variace velikosti, variace barvy, rozsah neprůhlednosti** — ovládejte hustotu a vzhled deště
- **Vlastní barva** — vyberte barvu a alfa pro déšť a logo
- **Míchání emoji** — zapněte a nastavte vzácnost jako 1/N (1 = všechny emoji, 1000000 = jedna z milionu)

### Animace výstupu
Když úvodní obrazovka zmizí, logo projde jedním z 9 režimů animace.
Každý režim má vlastní sadu ovládacích posuvníků, které se zobrazí po výběru z rozbalovací nabídky.

- **Spiral out** — písmena se spirálovitě otáčejí ven ze středu
- **Spiral in** — písmena se sbíhají do zužující se spirály s konfigurovatelným poloměrem a délkou
- **Explode** — písmena vybuchují ven s gravitací
- **Explode 2** — fyzikální exploze s odrazem od okrajů, konfigurovatelná síla, chaos a hybnost na osu
- **Float away** — písmena unášejí nahoru se sklonem podle směru
- **Horizontal flatten** — písmena se rozprostřou horizontálně a stlačí do čáry 1px s konfigurovatelnou dobou zadržení
- **Explode weak** — měkčí exploze s menší silou
- **Starwars crawl** — písmena se sbíhají k mizejícímu bodu s konfigurovatelnou cílovou Y pozicí
- **Explode 3** — logo se rozbije na jednotlivé pixely s ovládáním hybnosti na osu
- **Rain push** — písmena se oddělí a déšť je fyzicky vytlačí z obrazovky
- **Random** — pokaždé vybere jiný režim

### Panel nastavení animací
Otevřete nastavení animací z ikony ozubeného kola v záhlaví chatu. Má tři karty — Chat, Bobber a Splash.
Karta Splash obsahuje dva sbalitelné akordeony (Vzhled a Pohyb), rozbalovací nabídku režimu výstupu s posuvníky pro každý režim a živý náhledový plátno, na které můžete kliknout pro testování animací.
Panel je plně přetahovatelný a změnitelný bez omezení výšky.

## Instalace

### Ze zdrojového kódu
```bash
npm install
./compile-and-install.sh
# Poté: Ctrl+Shift+P → Developer: Reload Window
```

### Požadavky
- VS Code 1.120.0 nebo vyšší
- Běžící lokální běhové prostředí agenta (např. OpenClaw Gateway, nástěnka Hermes, server Souveraine)


## Zásluhy

Založeno na [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) od Owen-Liuyuxuan (MIT).
WebSocket/gateway architektura pochází z tohoto projektu.
Více-můstková architektura, modulární webview UI, animační engine a správci modelů/relací jsou původní pro Junction.

---

MIT licence. © Owen-Liuyuxuan (původní openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
