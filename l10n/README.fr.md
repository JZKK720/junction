# Junction

Un panneau latéral de chat pour VS Code qui connecte votre éditeur à des agents de code locaux.

`7 backends` · `Panneau de chat` · `Contexte du workspace` · `Splash animé` · `Licence MIT`

![Deux thèmes familiers](../media/two_familiar_skins.png)

Junction est un panneau de chat pour VS Code qui se connecte à des agents de code propulsés par l'IA s'exécutant sur votre machine.
Il communique avec plusieurs backends d'agents via une interface unifiée — passez de l'un à l'autre sans changer votre flux de travail.

## Backends pris en charge

Junction se connecte à n'importe lequel de ces runtimes d'agents locaux :

- **OpenClaw** — intégration WebSocket gateway avec gestion des sessions et des modèles
- **Hermes** — support natif WebSocket et REST API du tableau de bord
- **Souveraine** — intégration de serveur HTTP avec spawning de runtime géré
- **MiMoCode** — connexion auto-lancée ou préconfigurée au serveur MiMo
- **Goose** — configuration du répertoire de données et de la clé secrète
- **OpenCode** — chemin du binaire et paramètres du répertoire de configuration
- **OpenHands** — lanceur de serveur et configuration du répertoire home

## Fonctionnalités

### Panneau de chat
Parlez à votre agent actif depuis la barre latérale secondaire de VS Code. Ouvrez-le via la Palette de commandes : `Junction: Open Sidebar`.

### Contexte du workspace
Glissez-déposez des fichiers dans le champ de saisie du chat, ou faites un clic droit sur un fichier ou une sélection pour l'ajouter au fil de discussion en cours.

### Sélecteur de modèle et de raisonnement
Choisissez un modèle et réglez l'effort de raisonnement par session depuis l'en-tête du panneau latéral.

### Rendu Markdown
Les réponses de l'assistant, les cartes d'appels d'outils, les blocs de raisonnement et les diffs sont rendus en ligne avec coloration syntaxique.

### Dispositions de chat
Basculez entre le mode compact (activité pliée en accordéons) et le mode chronologie (flux chronologique du raisonnement avec prompts utilisateur épinglés).

### Modes de suivez
Mettez des messages en file d'attente pour quand l'agent a terminé, orientez en cours de tour, ou interrompez et redirigez. Configurable globalement ou par bridge.

### Reconnexion automatique
Junction se reconnecte au runtime automatiquement si la connexion tombe. Aucun redémarrage manuel nécessaire.

## Thèmes

Junction inclut deux dispositions intégrées. Le mode **Compact** plie l'activité en accordéons de résumé pour une vue dense.
Le mode **Chronologie** affiche un rail d'activité chronologique avec indicateurs par points, dévoilement du raisonnement et un thème à accent orange.
Les deux dispositions s'adaptent au thème de couleur de votre VS Code.

## Écran d'accueil et animations

Junction s'ouvre avec un écran d'accueil animé présentant un effet de pluie style matrix derrière le logo.
L'écran d'accueil est entièrement personnalisable via le panneau de paramètres d'animation intégré dans l'éditeur.

### Jeux de caractères
L'effet de pluie prend en charge 10 jeux de caractères : Katakana, Matrix Latin, Latin, Hiragana, CJK, Hangul, Emoji, Binary, Symbols et Custom.
Mélangez des gouttes d'emoji avec une rareté configurable, ou fournissez votre propre jeu de caractères.

### Contrôles de la pluie
- **Direction** — basculez la pluie vers le haut ou vers le bas
- **Chance d'inversion** — définissez un pourcentage pour que les gouttes aillent dans la direction opposée
- **Rebond sur les bords** — la pluie rebondit sur les bords gauche/droite au lieu de sortir de l'écran
- **Gravité, rebond, collision, vitesse** — ajustez le déplacement des gouttes et leur interaction avec le logo
- **Quantité, variance de taille, variance de couleur, plage d'opacité** — contrôlez la densité et l'apparence de la pluie
- **Couleur personnalisée** — choisissez une couleur et une transparence pour la pluie et le logo
- **Mélange d'emojis** — activez et réglez la rareté sur 1/N (1 = tout emojis, 1000000 = un sur un million)

### Animations de sortie
Quand l'écran d'accueil se ferme, le logo sort via l'un des 9 modes d'animation.
Chaque mode a son propre jeu de curseurs de contrôle qui apparaissent quand vous le sélectionnez dans le menu déroulant.

- **Spirale vers l'extérieur** — les lettres s'enroulent en spirale depuis le centre
- **Spirale vers l'intérieur** — les lettres convergent en une spirale qui se resserre avec rayon et longueur configurables
- **Explosion** — les lettres éclatent vers l'extérieur sous l'effet de la gravité
- **Explosion 2** — explosion basée sur la physique avec rebond sur les bords, force, chaos et moment par axe configurables
- **Flottement** — les lettres dérivent vers le haut avec une inclinaison basée sur la direction
- **Aplatissement horizontal** — les lettres s'étendent horizontalement et se compriment en une ligne de 1px avec un temps de maintien configurable
- **Explosion légère** — une explosion plus douce avec moins de force
- **Avance style Star Wars** — les lettres convergent vers un point de fuite avec position Y cible configurable
- **Explosion 3** — le logo se fragmente en pixels individuels avec contrôle du moment par axe
- **Poussée de la pluie** — les lettres se détachent et la pluie les pousse physiquement hors de l'écran
- **Aléatoire** — choisit un mode différent à chaque fois

### Panneau de paramètres d'animation
Ouvrez les paramètres d'animation depuis l'icône d'engrenage dans l'en-tête du chat. Il comporte trois onglets : Chat, Bobber et Splash.
L'onglet Splash contient deux accordéons réductibles (Apparence et Mouvement), le menu déroulant du mode de sortie avec des curseurs par mode, et un canevas d'aperçu en direct où vous pouvez cliquer pour tester les animations.
Le panneau est entièrement déplaçable et redimensionnable sans limite de hauteur.

## Installation

### Depuis les sources
```bash
npm install
./compile-and-install.sh
# Puis : Ctrl+Shift+P → Developer: Reload Window
```

### Prérequis
- VS Code 1.120.0 ou supérieur
- Un runtime d'agent local en cours d'exécution (par ex. OpenClaw Gateway, tableau de bord Hermes, serveur Souveraine)

---

> Il y a des œufs de Pâques. Ils ne sont pas documentés ici. C'est tout le but.

## Crédits

Basé sur [openclaw_vscode](https://github.com/Owen-Liuyuxuan/openclaw_vscode) de Owen-Liuyuxuan (MIT).
L'infrastructure WebSocket/gateway provient de ce projet.
L'architecture multi-bridge, l'interface modulaire du webview, le moteur d'animation et les gestionnaires de modèle/session sont originaux de Junction.

---

Licence MIT. © Owen-Liuyuxuan (openclaw_vscode original), © Plaer1 (Junction).
[github.com/Plaer1/junction](https://github.com/Plaer1/junction)
