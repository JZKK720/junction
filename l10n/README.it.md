# Junction

Un pannello chat per VS Code che collega il tuo editor agli agenti di programmazione AI locali.

`7 backend` · `Chat sidebar` · `Contesto del workspace` · `Splash animato` · `Licenza MIT`

![Due temi familiari](../media/two_familiar_skins.png)

Junction è un pannello chat per VS Code che si connette agli agenti di programmazione AI locali in esecuzione sulla tua macchina.
Comunica con diversi backend agente attraverso un'interfaccia unificata — passa da uno all'altro senza cambiare il tuo flusso di lavoro.

## Backend Supportati

Junction si connette a uno qualsiasi di questi runtime agente locali:

- **OpenClaw** — Integrazione WebSocket gateway con gestione sessioni e modelli
- **Hermes** — Supporto nativo WebSocket dashboard e REST API
- **Souveraine** — Integrazione server HTTP con spawning runtime gestito
- **MiMoCode** — Connessione server MiMo auto-avviata o preconfigurata
- **Goose** — Configurazione directory dati e chiave segreta
- **OpenCode** — Percorso binario e impostazioni config home
- **OpenHands** — Launcher server e configurazione directory home

## Funzionalità

### Chat Sidebar
Parla con il tuo agente attivo dalla sidebar secondaria di VS Code. Apri tramite Command Palette: `Junction: Open Sidebar`.

### Contesto del Workspace
Trascina e rilascia file nell'input della chat, o fai clic destro su un file o una selezione per aggiungerla al thread corrente.

### Selettore Modello e Ragionamento
Seleziona un modello e imposta lo sforzo di ragionamento per sessione dall'intestazione della sidebar.

### Rendering Markdown
Le risposte dell'assistente, le schede delle chiamate tool, i blocchi di ragionamento e i diff vengono renderizzati inline con evidenziazione della sintassi.

### Layout Chat
Passa dalla modalità compatta (attività ripiegata in accordion) alla modalità timeline (flusso cronologico del ragionamento con prompt utente fissi in alto).

### Modalità Follow-Up
Accoda messaggi per quando l'agente finisce, guida a metà turno, o interrompi e reindirizza. Configurabile globalmente o per singolo bridge.

### Riconnessione Automatica
Junction si riconnette al runtime automaticamente se la connessione cade. Nessun riavvio manuale necessario.

## Temi

Junction include due layout integrati. La modalità **Compatta** ripiega l'attività in accordion riassuntivi per una vista densa.
La modalità **Timeline** mostra una barra cronologica delle attività con indicatori a punti, sezione ragionamento espandibile e un tema con accento arancione.
Entrambi i layout si adattano al tema colori di VS Code.

## Splash Screen e Animazioni

Junction si apre con una splash screen animata che presenta un effetto pioggia in stile matrix dietro il logotipo.
La splash screen è completamente personalizzabile tramite il pannello delle impostazioni animazione integrato nell'editor.

### Set di Caratteri
L'effetto pioggia supporta 10 set di caratteri: Katakana, Matrix Latin, Latin, Hiragana, CJK, Hangul, Emoji, Binary, Simboli e Personalizzato.
Mescola gocce di emoji con rarità configurabile, o fornisci il tuo set di caratteri.

### Controlli Pioggia
- **Direzione** — alterna la pioggia che cade verso l'alto o verso il basso
- **Probabilità inversione** — imposta una percentuale perché le gocce vadano nella direzione opposta
- **Rimbalzo bordi** — la pioggia rimbalza dai bordi sinistro/destro invece di cadere fuori schermo
- **Gravità, rimbalzo, collisione, velocità** — regola come le gocce si muovono e interagiscono con il logotipo
- **Quantità, varianza dimensione, varianza colore, intervallo opacità** — controlla la densità e l'aspetto della pioggia
- **Colore personalizzato** — scegli un colore e un'alfa per la pioggia e il logotipo
- **Mixing emoji** — attiva e imposta la rarità come 1/N (1 = tutte emoji, 1000000 = una su un milione)

### Animazioni di Uscita
Quando lo splash si chiude, il logotipo esce attraverso una delle 9 modalità di animazione.
Ogni modalità ha il proprio set di controlli scorrevoli che appaiono quando la selezioni dal menu a tendina.

- **Spiral out** — le lettere si allontanano a spirale dal centro
- **Spiral in** — le lettere convergono in una spirale che si stringe con raggio e lunghezza configurabili
- **Explode** — le lettere scoppiano verso l'esterno con gravità
- **Explode 2** — esplosione basata sulla fisica con rimbalzo dai bordi, forza, caos e momento per asse configurabili
- **Float away** — le lettere fluttuano verso l'alto con inclinazione basata sulla direzione
- **Horizontal flatten** — le lettere si espandono orizzontalmente e si schiacciano in una linea di 1px con tempo di permanenza configurabile
- **Explode weak** — un'esplosione più delicata con meno forza
- **Starwars crawl** — le lettere convergono verso un punto di fuga con posizione Y target configurabile
- **Explode 3** — il logotipo si frantuma in pixel singoli con controllo del momento per asse
- **Rain push** — le lettere si staccano e la pioggia le spinge fisicamente fuori schermo
- **Random** — sceglie una modalità diversa ogni volta

### Pannello Impostazioni Animazioni
Apri le impostazioni animazione dall'icona ingranaggio nell'intestazione della chat. Ha tre schede — Chat, Bobber e Splash.
La scheda Splash contiene due accordion richiudibili (Aspetto e Movimento), il menu a tendina della modalità di uscita con controlli per modalità, e un'anteprima live su canvas su cui puoi cliccare per testare le animazioni.
Il pannello è completamente trascinabile e ridimensionabile senza limite di altezza.

## Installazione

### Dal sorgente
```bash
npm install
./compile-and-install.sh
# Poi: Ctrl+Shift+P → Developer: Reload Window
```

### Requisiti
- VS Code 1.120.0 o superiore
- Un runtime agente locale in esecuzione (es. OpenClaw Gateway, dashboard Hermes, server Souveraine)

---

## Crediti

Basato su [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) di Owen-Liuyuxuan (MIT).
L'infrastruttura WebSocket/gateway risale a quel progetto.
L'architettura multi-bridge, l'interfaccia webview modulare, il motore delle animazioni e i gestori di modello/sessione sono originali di Junction.

---

Licenza MIT. © Owen-Liuyuxuan (openclaw_vscode originale), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
