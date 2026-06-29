# Junction

VS Code csevegési oldalsáv, amely összeköti a szerkesztődet a helyi AI kódoló ágensekkel.

`7 backend` · `Csevegési oldalsáv` · `Munkaterület-kontextus` · `Animált nyitókép` · `MIT licenc`

![Két ismerős téma](../media/two_familiar_skins.png)

A Junction egy csevegőpanel a VS Code-hoz, amely a gépeden futó helyi AI kódoló ágensekhez csatlakozik.
Egy egységes felületen keresztül kommunikál több ágens backenddel — válts köztük anélkül, hogy megváltoztatnád a munkafolyamatodat.

## Támogatott backendek

A Junction bármelyikéhez csatlakozik ezek közül a helyi ágens futtatókörnyezetek közül:

- **OpenClaw** — WebSocket gateway integráció munkamenet- és modellkezeléssel
- **Hermes** — natív műszerfal WebSocket és REST API támogatás
- **Souveraine** — HTTP szerver integráció kezelt futtatókörnyezet-indítással
- **MiMoCode** — automatikusan indított vagy előre konfigurált MiMo szerver kapcsolat
- **Goose** — adatkönyvtár és titkos kulcs konfiguráció
- **OpenCode** — bináris elérési út és konfigurációs könyvtár beállítások
- **OpenHands** — szerverindító és home könyvtár konfiguráció

## Funkciók

### Csevegési oldalsáv
Beszélj az aktív ágensseddel a VS Code másodlagos oldalsávjáról. Nyisd meg a Parancspalettáról: `Junction: Open Sidebar`.

### Munkaterület-kontextus
Húzd és dobd a fájlokat a csevegési mezőbe, vagy kattints jobb gombbal egy fájlra vagy kijelölésre, hogy hozzáadd az aktuális szálhoz.

### Modell- és gondolkodásválasztó
Válassz modellt és állítsd be a gondolkodási erőfeszítést munkamenetenként az oldalsáv fejlécéből.

### Markdown megjelenítés
Az asszisztens válaszai, az eszközhívás-kártyák, a gondolkodási blokkok és a diff-ek beágyazottan jelennek meg szintaxiskiemeléssel.

### Csevegési elrendezések
Válts a kompakt mód (tevékenység összecsukva akkordeonokba) és az idővonal mód (időrendi gondolkodási folyamat ragadós felhasználói promptokkal) között.

### Követési módok
Üzeneteket állíthatsz sorba arra az időre, amikor az ágens végez, irányíthatod a forduló közepén, vagy megszakíthatod és átirányíthatod. Globálisan vagy bridge-enként konfigurálható.

### Automatikus újracsatlakozás
A Junction automatikusan újracsatlakozik a futtatókörnyezethez, ha a kapcsolat megszakad. Nincs szükség kézi újraindításra.

## Témák

A Junction két beépített elrendezést tartalmaz. A **Kompakt** mód a tevékenységet összefoglaló akkordeonokba hajtja a sűrű nézet érdekében.
Az **Idővonal** mód időrendi tevékenységi sávot mutat pontjelzőkkel, gondolkodás-feltárással és narancs kiemelésű témával.
Mindkét elrendezés alkalmazkodik a VS Code színtémádhoz.

## Nyitóképernyő és animációk

A Junction egy animált nyitóképernyővel nyílik, amelyen matrix-stílusú esőeffektus jelenik meg a logó mögött.
A nyitóképernyő teljesen testreszabható a szerkesztőbe épített animációs beállítások panelen keresztül.

### Karakterkészletek
Az esőeffektus 10 karakterkészletet támogat: Katakana, Matrix Latin, Latin, Hiragana, CJK, Hangul, Emoji, Binary, Symbols és Custom.
Keverj emoji-cseppeket konfigurálható ritkasággal, vagy adj meg saját karakterkészletet.

### Esővezérlők
- **Irány** — váltás az eső felfelé vagy lefelé esése között
- **Fordított esély** — állítsd be a százalékot, hogy a cseppek az ellenkező irányba menjenek
- **Szélről pattanás** — az eső a bal/jobb szélekről pattan le ahelyett, hogy leesne a képernyőről
- **Gravitáció, pattanás, ütközés, sebesség** — állítsd be, hogyan mozognak a cseppek és hogyan lépnek kölcsönhatásba a logóval
- **Mennyiség, méretvariancia, színvariancia, átláthatósági tartomány** — szabályozd az eső sűrűségét és kinézetét
- **Egyéni szín** — válassz színt és alfát az esőnek és a logónak
- **Emoji keverés** — kapcsold be és állítsd be a ritkaságot 1/N értékre (1 = minden emoji, 1000000 = egymillióból egy)

### Kilépési animációk
Amikor a nyitókép bezárul, a logó 9 animációs mód egyikén lép ki.
Minden mód saját vezérlőcsúszkákkal rendelkezik, amelyek a legördülő menüből való kiválasztáskor jelennek meg.

- **Spirál kifelé** — a betűk spirálisan kifelé forognak a középpontból
- **Spirál befelé** — a betűk konfigurálható sugarú és hosszúságú szűkülő spirálban konvergálnak
- **Robbanás** — a betűk gravitációval kifelé törnek
- **Robbanás 2** — fizika-alapú robbanás szélről pattanással, konfigurálható erővel, káosszal és tengelyenkénti lendülettel
- **Elszállás** — a betűk irány-alapú dőléssel felfelé sodródnak
- **Vízszintes lapítás** — a betűk vízszintesen szétterjednek és konfigurálható tartási idővel 1px-es vonallá préselődnek
- **Gyenge robbanás** — egy lágyabb robbanás kevesebb erővel
- **Csillagok háborúja gördülés** — a betűk konfigurálható cél Y-pozícióval egy eltűnési pont felé konvergálnak
- **Robbanás 3** — a logó tengelyenkénti lendületvezérléssel egyedi pixelekre törik
- **Eső-nyomás** — a betűk leválnak és az eső fizikailag letolja őket a képernyőről
- **Véletlenszerű** — minden alkalommal másik módot választ

### Animációs beállítások panel
Nyisd meg az animációs beállításokat a csevegési fejléc fogaskerék ikonjából. Három füle van — Chat, Bobber és Splash.
A Splash fül két összecsukható akkordeont tartalmaz (Megjelenés és Mozgás), a kilépési mód legördülő menüt módonkénti csúszkákkal, és egy élő előnézeti vásznat, amelyre kattintva tesztelheted az animációkat.
A panel teljesen húzható és átméretezhető magassági korlát nélkül.

## Telepítés

### Forráskódból
```bash
npm install
./compile-and-install.sh
# Aztán: Ctrl+Shift+P → Developer: Reload Window
```

### Követelmények
- VS Code 1.120.0 vagy újabb
- Egy futó helyi ágens futtatókörnyezet (pl. OpenClaw Gateway, Hermes műszerfal, Souveraine szerver)

---

> Vannak húsvéti tojások. Itt nincsenek dokumentálva. Ez a lényeg.

## Köszönet

Az [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) alapján, Owen-Liuyuxuan (MIT).
A WebSocket/gateway kiépítés abból a projektből származik.
A több-bridge architektúra, a moduláris webview felület, az animációs motor és a modell/munkamenet-kezelők a Junction saját alkotásai.

---

MIT licenc. © Owen-Liuyuxuan (eredeti openclaw_vscode), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
