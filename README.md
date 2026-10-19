<p align="center"><img src="src/renderer/assets/logo.svg" width="112" alt="Reboxed logo"></p>

<h1 align="center">Reboxed</h1>

<p align="center"><b>Comme Rekordbox mais en mieux.</b></p>

<p align="center">Logiciel DJ gratuit et libre pour Windows : bibliothèque, 4 decks, stems par IA, Groove Circuit, contrôleurs Pioneer par plugins, export sur clé USB pour CDJ, import de ta collection Rekordbox.</p>

<p align="center"><a href="LICENSE">Licence MIT</a> · <a href="docs/PLUGINS.md">Plugins</a> · <a href="docs/DDJ-GRV6.md">DDJ-GRV6</a> · <a href="docs/ROADMAP.md">Feuille de route</a></p>

## Installer

1. Télécharge `Reboxed-Setup-<version>.exe` dans les [Releases](https://github.com/Vlocky1/Reboxed/releases).
2. Lance-le. Windows affiche « Éditeur inconnu », car l'installeur n'est pas signé : clique sur *Informations complémentaires*, puis sur *Exécuter quand même*.
3. Reboxed démarre en plein écran fenêtré (fenêtre agrandie) ; **F11** passe en vrai plein écran. Préférences ▸ General ▸ *Window at start* change ce choix.

Pour récupérer ta collection Rekordbox, exporte-la depuis Rekordbox avec `File ▸ Export Collection in xml format`, puis importe-la dans Reboxed avec le menu ⋯ ▸ *Import from rekordbox*.

## Développer

Reboxed est un logiciel desktop (Electron + Web Audio) qui reprend les fonctionnalités de Rekordbox. Elles sont réimplémentées : aucun code, visuel ni asset de Pioneer/AlphaTheta n'est utilisé.

```sh
npm install
npm start          # lance l'application
npm test           # 94 tests unitaires (recherche, DSP, grilles, phrases, Camelot, rekordbox.xml, listes, MIDI, contrôleurs, plugins, export CDJ, formes d'onde, stockage…)
npm run smoke      # test de bout en bout dans Electron, sans toucher à ta bibliothèque
                   # (avec REBOXED_SPLEETER_DIR=<dossier des 4 .fp16.onnx> et/ou REBOXED_STEM_MODEL=<HT-Demucs .onnx>, il teste aussi les stems FAST/HQ ;
                   #  avec REBOXED_DL_TEST=1, il fait une vraie recherche et un vrai téléchargement YouTube)
```

## Installeur Windows

```sh
npm run icon       # (re)génère build/icon.ico et build/icon.png
npm run dist       # dist/Reboxed-Setup-<version>.exe : installeur, avec le choix du dossier et des raccourcis Bureau et menu Démarrer
npm run dist:dir   # dist/win-unpacked/Reboxed.exe : version portable, sans installation
```

- **Données** : voir « Où sont les données » plus bas. La désinstallation ne les supprime pas.
- **Avertissement Windows** : l'installeur n'est pas signé, donc SmartScreen affiche « Éditeur inconnu ». Clique sur *Informations complémentaires*, puis sur *Exécuter quand même*.
- **Version empaquetée** : on la teste avec `dist\win-unpacked\Reboxed.exe --smoke "--shot=<png>"`.

## Fonctionnalités

| Zone | Fonctionnalités |
|---|---|
| **Bibliothèque** | Import par dossier, fichiers ou glisser-déposer. Collection, playlists et dossiers. Intelligent Playlists (conditions ET/OU). Tag List, Related Tracks, historiques (une mini playlist par jour ; on peut en retirer des morceaux, supprimer un jour ou tout effacer), notes, 8 couleurs, My Tag, détection des fichiers manquants. **Track information** (clic droit) : chaque champ modifiable, avec une aide, en sections Track, Credits, DJ (note, couleur, My Tag, commentaires, BPM, tonalité, nombre de lectures, date et heure d'ajout) et File en lecture seule. Bouton **Search info (Deezer / Spotify)** : tu choisis le service (le choix est mémorisé). **Deezer** marche sans compte et donne les genres et les labels ; **Spotify** demande ses identifiants, et comme il n'a presque plus de genres, un résultat Spotify reprend le genre et le label du même morceau sur Deezer (même ISRC, ou même artiste et titre). Une recherche qui ne répond pas s'arrête au bout de 15 s avec un message clair ; Reboxed montre pour chaque champ la valeur actuelle et celle trouvée (titre, mix, artiste, album, genre, année, numéro de piste, label, pochette…) et ne remplace que les cases cochées (le genre est coché d'office ; s'il y a plusieurs genres, tu choisis lequel). Pour ajouter Spotify (facultatif) : une appli Spotify gratuite créée sur developer.spotify.com/dashboard (redirect URI : `http://127.0.0.1:8888/callback`, jamais utilisée mais exigée par Spotify ; API : Web API), dont on colle le Client ID et le Client Secret dans Préférences ▸ Library. **Auto-tag en masse** (clic droit sur une sélection ▸ *Auto-tag with Spotify / Deezer…*, ou menu ⋯ pour la liste affichée) : une recette d'étapes, chacune avec son service et ses champs, par exemple 1) Spotify : titre et artistes, puis 2) Deezer : genre, cherché avec le titre que Spotify vient de nettoyer. Les titres de vidéos (« Artiste - Titre (Clip officiel) [HD] ») sont nettoyés avant la recherche. Un résultat n'est retenu que si l'artiste, le titre et la durée (± 4 s, réglable) correspondent, et la bonne version (Extended, Radio Edit…) est préférée. Options par étape : ne remplir que les champs vides, nom du mix dans le titre. Tous les changements s'affichent avant d'être enregistrés, cochés d'office et décochables un par un ou par champ ; *Apply* enregistre, *Undo* revient en arrière. La recette est mémorisée. La colonne **Date Added** affiche aussi l'heure pour les morceaux ajoutés depuis la 1.5. **Colonnes** au choix (clic droit sur l'en-tête) et **redimensionnables** : glisser le bord, double-clic pour ajuster au contenu, « Fit all columns » dans le menu ; les largeurs sont mémorisées. |
| **Recherche** | Moteur identique à Rekordbox ([preuves](docs/rekordbox-search-evidence.md)) et Track Filter (BPM ±%, Key, Rating, Color, My Tag). |
| **Interop Rekordbox** | Outil **Import from rekordbox** (menu ⋯ du navigateur, ou glisser un `rekordbox.xml` sur la fenêtre). Il importe toutes les infos des morceaux, les hot cues, les memory cues, les boucles, les grilles, les playlists et les dossiers. Il affiche un aperçu chiffré, permet de choisir les playlists et de régler la fusion (rekordbox gagne ou garder mes modifs ; cues remplacées, fusionnées ou gardées), retrouve les fichiers déplacés et peut réimporter sans doublons. Export `rekordbox.xml` et M3U8. |
| **Téléchargement** | Bouton **DOWNLOAD**. Onglet **Search** : tu choisis la plateforme, **YouTube** ou **SoundCloud** (le choix est mémorisé), puis tu cherches. Onglet **Link** : tu colles un lien, Reboxed reconnaît tout seul s'il vient de YouTube ou de SoundCloud (vidéo, morceau, playlist, page d'artiste) et refuse les autres sites. Les morceaux SoundCloud réservés aux abonnés Go+ ne donnent qu'un extrait de 30 s : ils sont signalés « 30 s preview ». Onglet **New releases** : nouveautés des chaînes suivies (YouTube ou SoundCloud ; vérifiées au démarrage). Formats M4A, MP3 320, FLAC ou WAV, réglés dans Préférences ▸ Downloads. Tags « Artiste - Titre » nettoyés et pochette intégrée. Les morceaux arrivent dans la collection et dans la playlist « Downloads ». Le moteur est yt-dlp + ffmpeg + deno, trouvés dans le PATH, dans un dossier choisi dans les Préférences ou dans l'installation de Stacher si elle existe. |
| **Bibliothèque amovible** | Préférences ▸ Library : le **dossier de la bibliothèque** peut être sur une clé USB. Si la lettre de la clé change d'un PC à l'autre, les chemins suivent ; si la clé est absente au démarrage, Reboxed propose Réessayer, un autre dossier ou la bibliothèque locale. Les **stems** vont par défaut dans `<bibliothèque>\stems`, déplaçables vers un autre dossier ou à côté de chaque morceau. **Move my collection to a USB drive** (Préférences ▸ Library ou menu ⋯) : pour chaque morceau encore sur l'ordinateur, Reboxed cherche son homonyme dans le dossier de la clé que tu choisis (rien n'est proposé d'office). Il le reconnaît s'il porte le même nom, le même nom dans un autre format, ou un nom proche confirmé par les tags et la durée à ±2 s ; un Extended Mix n'est pas confondu avec l'Original Mix. Tu vérifies les cas douteux morceau par morceau : lier, copier sur la clé (dossier `From computer`), garder ou retirer. Les cues, tags, analyses et playlists sont conservés, les stems suivent dans le dossier `stems` de la clé, les morceaux présents seulement sur la clé sont ajoutés, et les fichiers locaux peuvent partir à la corbeille. |
| **Export CDJ / XDJ** | Menu ⋯ ▸ *Export to USB for CDJ / XDJ…* : écrit une clé lisible par les lecteurs Pioneer, comme l'export de rekordbox. Base `export.pdb` (morceaux, artistes, albums, genres, tonalités, couleurs, pochettes, playlists et dossiers ; listes intelligentes figées), fichiers d'analyse `ANLZ0000.DAT/.EXT/.2EX` (grille, hot cues **avec leur couleur** et leur nom, memory cues, boucles, formes d'onde bleue, RGB et 3Band) et **My Settings** des lecteurs et de la table de mixage (couleur de forme d'onde, format de tonalité, position de lecture, luminosité, jog, quantize, Auto Cue, tempo, courbes de fader…). Toute la collection ou seulement des playlists ; les morceaux déjà sur la clé restent en place, les autres sont copiés dans `Contents`. Un export existant est d'abord sauvegardé. Vérifié avec des lecteurs indépendants du format ; pas encore essayé sur un vrai CDJ. |
| **Analyse** | BPM et grille constante ou dynamique, premier temps de mesure, tonalité en Camelot ou classique, phrases (INTRO/UP/CHORUS/DOWN/OUTRO…), forme d'onde 3Band / RGB / BLUE (zoomée : la vraie onde, précise au 1/2700ᵉ de seconde ; dézoomée : vue simplifiée), loudness, empreinte audio. |
| **Stems** | VOCAL / INST / BASS / DRUMS par IA, en deux qualités. **FAST** (Spleeter, environ 7× le temps réel) est progressif : la séparation commence à la tête de lecture et le deck utilise les stems dès que le premier bloc est prêt. **HQ** (HT-Demucs) prend le relais en arrière-plan en mode *auto*. Avancement visible dans la pastille de la barre du haut, sur le bouton STEMS, sur la barre de couverture de la vue d'ensemble et dans la colonne « Stems ». La forme d'onde est colorée par stem. Coupure et solo par deck. Stems rangés en **MP3** (256 ou 320 kbps, environ 9 Mo par stem pour 5 min au lieu de 53 Mo en WAV) ou en WAV, au choix ; un bouton convertit les anciens stems WAV. |
| **Préparation** | Éditeur de grille (tap tempo, verrouillage…), cues créés depuis les phrases, MIX IN / MIX OUT et Mix Point Link, Track Suggestion (morceaux qui sonnent pareil). |
| **Decks** (2 ou 4) | CUE façon CDJ, 16 hot cues (A–P), memory cues, boucles de 1/64 à 512 temps (les flèches de taille redimensionnent aussi la boucle en cours, depuis son début), beat jump, quantize, tempo ±6/10/16/WIDE, Master Tempo, Key Shift et Key Sync, Slip, Reverse, Censor, Beat Sync ou BPM Sync, Instant Doubles, édition de grille. |
| **Pads** | Modes HOT CUE, BEAT LOOP, BEAT JUMP, SLICER, SAMPLER, KEY SHIFT, KEYBOARD. |
| **Mixer** | Trim, auto-gain, EQ isolateur 3 bandes, Color FX (FILTER, SPACE, DUB ECHO, NOISE, CRUSH), cue casque sur une 2ᵉ carte son, courbes de fader et de crossfader, limiteur, VU-mètres. |
| **Beat FX** (16) | DELAY, ECHO, PING PONG, REVERB, FLANGER, PHASER, FILTER, TRANS, ROLL, REV ROLL, VINYL BRAKE, PITCH, UP ECHO, DOWN ECHO, PAN, ROBOT. Synchronisés au BPM, sur CH1–4 ou MASTER. |
| **Sampler** | 16 slots en one-shot ou en boucle, synchro au master, glisser-déposer, capture de la boucle d'un deck. |
| **Automix** | Joue la liste affichée avec préchargement, sync et fondu de 4 à 32 temps ; répétition et lecture aléatoire. |
| **Enregistrement** | WAV 16 bits dans `Musique\Reboxed Recordings\`, ajouté automatiquement à la collection. |
| **Contrôle** | **Plugins matériels** (Préférences ▸ Plugins) : un plugin par contrôleur, activable ou non, reconnu automatiquement au branchement. Fournis : **DDJ-GRV6** (mapping complet, LED, jogs, Groove Circuit, carte son 4 canaux, [notice](docs/DDJ-GRV6.md)), **DDJ-FLX2**, **DDJ-FLX4**, **DDJ-FLX6** et **DDJ-FLX10**. N'importe qui peut en créer un pour un autre contrôleur, en un clic depuis un mapping rekordbox `.midi.csv` ou à la main ([guide](docs/PLUGINS.md)), et le partager. Sans plugin, un contrôleur dont le mapping est dans une installation rekordbox est quand même reconnu. Clavier façon preset « Performance 1 », MIDI learn. |

## Interface

Disposition et ambiance du mode PERFORMANCE de Rekordbox :
- **Barre globale**, rangée par usage : logo, mode et dispositions (2 decks / 4 decks / navigateur) ; **panneaux** (FX, MIXER, SAMPLER) ; **aides au mix** (MIX POINT LINK, AUTOMIX) ; **outils** (DOWNLOAD, REC) ; puis l'état (stems, MIDI, horloge), le raccourci **Appearance** (palette) et les Préférences.
- **Thèmes** (Préférences ▸ Appearance) : Reboxed Dark, OLED Black, Midnight, Graphite, Ember, Neon, Forest et Rosé, avec un aperçu de chacun ; couleur d'accent au choix (10 teintes ou n'importe quelle couleur) ; taille de l'interface de 85 % à 125 % ; barre du haut avec icônes et noms ou icônes seules.
- **Préférences en onglets** : General, Appearance, Decks & Mixer, Audio, Library, Stems, Downloads, MIDI, Plugins, Keyboard. La version de Reboxed est affichée dans la barre de titre et en tête des Préférences.
- **Panneau Beat FX** sur sa propre ligne.
- **Formes d'onde agrandies** empilées, avec le repère de chaque deck.
- **Decks** : pochette, KEY, BPM, MASTER/SYNC, vue d'ensemble, gros CUE/PLAY, pads colorés, fader de tempo.
- **Mixer** : potards à arc de valeur, VU-mètres segmentés.
- **Navigateur** : icônes, recherche, colonne pochette.

Palette, icônes et dessins sont propres à Reboxed : aucun fichier visuel ni logo de Pioneer/AlphaTheta n'est utilisé.

## Architecture

```
src/main/        process Electron : fenêtre, protocoles app:// et media://, IPC, tags, stockage, enregistrement WAV,
                 plugins, export CDJ, stems (process isolé, encodage MP3)
src/plugins/     plugins matériels fournis (un dossier par contrôleur : plugin.json + mapping)
src/renderer/
  audio/         deck-processor (lecture, boucles, slip, time-stretch), fx-processor (roll, brake, pitch),
                 recorder-processor, deck, engine (mixer, Color FX), fx (Beat FX), sampler
  analysis/      décodage, ré-échantillonnage, worker
  ui/            decks et pads, mixer, navigateur, listes intelligentes et related, sampler, MIDI, préférences
  automix.js, library.js, app.js
src/shared/      code pur testé sous Node : DSP, Camelot, XML, rekordbox.xml, smartlist, related, MIDI, WAV, MP3,
                 format CDJ (export.pdb, ANLZ, My Settings),
                 boucles DRUM SWAP, chemins portables, liaison USB, date d'ajout
src/search/      moteur de recherche façon Rekordbox
```

## Où sont les données

- `%APPDATA%\Reboxed\` (propre à l'ordinateur) contient :
  - `location.json`, qui indique où est la bibliothèque ;
  - `models\` : les modèles de stems, `spleeter\` pour FAST et `htdemucs_fp16weights.onnx` pour HQ ;
  - `plugins\` : les plugins matériels que tu as installés ou créés ;
  - les caches.

  Les versions précédentes utilisaient `%APPDATA%\rbclone\`, qui est renommé automatiquement au premier lancement.
- **Dossier de la bibliothèque** (par défaut le même, ou une clé USB) : `library.json`, `analysis\`, `artwork\`, `groove\` (captures DRUM CAPTURE) et `stems\<morceau>\{vocals,drums,bass,other}.mp3` (ou `.wav`). La version HQ des stems remplace la FAST.
- **Emplacements des stems** : le dossier de la bibliothèque, un dossier au choix ou à côté de chaque morceau. Les stems déjà rangés à côté de la musique ou dans l'ancien cache restent lus.

La suite est dans [docs/ROADMAP.md](docs/ROADMAP.md) : phase 5 (mode Edit, Pad FX, vidéo…).

## Licence

Reboxed est distribué sous **licence MIT** ([LICENSE](LICENSE)). Tout le monde peut l'utiliser, le copier, le modifier et le redistribuer, y compris pour un usage commercial. Seule condition : garder la mention de copyright et de licence.

Composants tiers :
- Electron, onnxruntime et music-metadata : licence MIT.
- lamejs (`@breezystack/lamejs`, encodage MP3 des stems) : licence LGPL-3.0, utilisée sans modification comme bibliothèque séparée.
- Modèles de stems, téléchargés au premier usage et absents du dépôt : Spleeter 4 stems (poids de Deezer sous MIT, export ONNX sous Apache-2.0) et HT-Demucs v4 (MIT).
- yt-dlp, ffmpeg et deno : utilisés s'ils sont installés sur la machine. Ils ne sont pas fournis avec Reboxed.

Reboxed n'est ni affilié ni approuvé par AlphaTheta / Pioneer DJ. *rekordbox*, *Pioneer DJ*, *CDJ*, *XDJ*, *DDJ-GRV6* et *DDJ-FLX* sont des marques de leurs propriétaires respectifs ; elles ne sont citées que pour décrire la compatibilité.
