# Reboxed

Reboxed (projet RBClone) est un logiciel DJ desktop (Electron + Web Audio) qui reprend les fonctionnalités de Rekordbox. Les fonctionnalités sont réimplémentées : aucun code, visuel ni asset de Pioneer/AlphaTheta n'est utilisé.

```sh
npm install
npm start          # lance l'application
npm test           # 65 tests unitaires (recherche, DSP, grilles, phrases, Camelot, rekordbox.xml, listes, MIDI, contrôleurs, WAV…)
npm run smoke      # test de bout en bout dans Electron, sans toucher à ta bibliothèque
                   # (avec RBCLONE_SPLEETER_DIR=<dossier des 4 .fp16.onnx> et/ou RBCLONE_STEM_MODEL=<HT-Demucs .onnx>, il teste aussi les stems FAST/HQ)
```

## Installeur Windows

```sh
npm run icon       # (re)génère build/icon.ico et build/icon.png
npm run dist       # dist/Reboxed-Setup-<version>.exe : installeur, avec le choix du dossier et des raccourcis Bureau et menu Démarrer
npm run dist:dir   # dist/win-unpacked/Reboxed.exe : version portable, sans installation
```

- **Données** : l'appli garde ses données dans `%APPDATA%\rbclone`, qui contient la bibliothèque, les analyses, les modèles de stems et les caches. La désinstallation ne les supprime pas.
- **Avertissement Windows** : l'installeur n'est pas signé, donc SmartScreen affiche « Éditeur inconnu ». Clique sur *Informations complémentaires*, puis sur *Exécuter quand même*.
- **Version empaquetée** : on la teste avec `dist\win-unpacked\Reboxed.exe --smoke "--shot=<png>"`.

## Fonctionnalités

| Zone | Fonctionnalités |
|---|---|
| **Bibliothèque** | Import par dossier, fichiers ou glisser-déposer. Collection, playlists et dossiers. Intelligent Playlists (conditions ET/OU). Tag List, Related Tracks, historiques, notes, 8 couleurs, My Tag, édition des infos, colonnes configurables, détection des fichiers manquants. |
| **Recherche** | Moteur identique à Rekordbox ([preuves](docs/rekordbox-search-evidence.md)) et Track Filter (BPM ±%, Key, Rating, Color, My Tag). |
| **Interop Rekordbox** | Outil **Import from rekordbox** (menu ⋯ du navigateur, ou glisser un `rekordbox.xml` sur la fenêtre). Il importe toutes les infos des morceaux, les hot cues, les memory cues, les boucles, les grilles, les playlists et les dossiers. Il affiche un aperçu chiffré, permet de choisir les playlists et de régler la fusion (rekordbox gagne ou garder mes modifs ; cues remplacées, fusionnées ou gardées), retrouve les fichiers déplacés et peut réimporter sans doublons. Export `rekordbox.xml` et M3U8. |
| **Téléchargement** | Bouton **DOWNLOAD** : recherche YouTube, liens (vidéo ou playlist) et **nouveautés** des chaînes suivies (artistes, labels ; vérifiées au démarrage). Formats M4A (sans réencodage), MP3 320, FLAC ou WAV. Tags « Artiste - Titre » nettoyés et pochette intégrée. Les morceaux arrivent dans la collection et dans la playlist « Downloads ». Le moteur est yt-dlp + ffmpeg + deno, comme Stacher (repris de `~/.stacher` ou du PATH). |
| **Analyse** | BPM et grille constante ou dynamique, premier temps de mesure, tonalité en Camelot ou classique, phrases (INTRO/UP/CHORUS/DOWN/OUTRO…), forme d'onde 3Band / RGB / BLUE, loudness, empreinte audio. |
| **Stems** | VOCAL / INST / BASS / DRUMS par IA, en deux qualités. **FAST** (Spleeter, environ 7× le temps réel) est progressif : la séparation commence à la tête de lecture et le deck utilise les stems dès que le premier bloc est prêt. **HQ** (HT-Demucs) prend le relais en arrière-plan en mode *auto*. Avancement visible dans la pastille de la barre du haut, sur le bouton STEMS, sur la barre de couverture de la vue d'ensemble et dans la colonne « Stems ». La forme d'onde est colorée par stem. Coupure et solo par deck. |
| **Préparation** | Éditeur de grille (tap tempo, verrouillage…), cues créés depuis les phrases, MIX IN / MIX OUT et Mix Point Link, Track Suggestion (morceaux qui sonnent pareil). |
| **Decks** (2 ou 4) | CUE façon CDJ, 16 hot cues (A–P), memory cues, boucles de 1/64 à 512 temps, beat jump, quantize, tempo ±6/10/16/WIDE, Master Tempo, Key Shift et Key Sync, Slip, Reverse, Censor, Beat Sync ou BPM Sync, Instant Doubles, édition de grille. |
| **Pads** | Modes HOT CUE, BEAT LOOP, BEAT JUMP, SLICER, SAMPLER, KEY SHIFT, KEYBOARD. |
| **Mixer** | Trim, auto-gain, EQ isolateur 3 bandes, Color FX (FILTER, SPACE, DUB ECHO, NOISE, CRUSH), cue casque sur une 2ᵉ carte son, courbes de fader et de crossfader, limiteur, VU-mètres. |
| **Beat FX** (16) | DELAY, ECHO, PING PONG, REVERB, FLANGER, PHASER, FILTER, TRANS, ROLL, REV ROLL, VINYL BRAKE, PITCH, UP ECHO, DOWN ECHO, PAN, ROBOT. Synchronisés au BPM, sur CH1–4 ou MASTER. |
| **Sampler** | 16 slots en one-shot ou en boucle, synchro au master, glisser-déposer, capture de la boucle d'un deck. |
| **Automix** | Joue la liste affichée avec préchargement, sync et fondu de 4 à 32 temps ; répétition et lecture aléatoire. |
| **Enregistrement** | WAV 16 bits dans `Musique\RBClone Recordings\`, ajouté automatiquement à la collection. |
| **Contrôle** | **Pioneer DDJ-GRV6 reconnu automatiquement** : mapping complet, LED, jogs, Groove Circuit, carte son 4 canaux ([notice](docs/DDJ-GRV6.md)). Autres contrôleurs Pioneer via leur mapping Rekordbox. Clavier façon preset « Performance 1 », MIDI learn. |

## Interface

Disposition et ambiance du mode PERFORMANCE de Rekordbox :
- **Barre globale** : mode, dispositions 2 decks / 4 decks / navigateur, panneaux FX / SAMPLER / MIXER / MIX POINT LINK / AUTOMIX, REC, état MIDI, horloge.
- **Panneau Beat FX** sur sa propre ligne.
- **Formes d'onde agrandies** empilées, avec le repère de chaque deck.
- **Decks** : pochette, KEY, BPM, MASTER/SYNC, vue d'ensemble, gros CUE/PLAY, pads colorés, fader de tempo.
- **Mixer** : potards à arc de valeur, VU-mètres segmentés.
- **Navigateur** : icônes, recherche, colonne pochette.

Palette, icônes et dessins sont propres à RBClone : aucun fichier visuel ni logo de Pioneer/AlphaTheta n'est utilisé.

## Architecture

```
src/main/        process Electron : fenêtre, protocoles app:// et media://, IPC, tags, stockage, enregistrement WAV
src/renderer/
  audio/         deck-processor (lecture, boucles, slip, time-stretch), fx-processor (roll, brake, pitch),
                 recorder-processor, deck, engine (mixer, Color FX), fx (Beat FX), sampler
  analysis/      décodage, ré-échantillonnage, worker
  ui/            decks et pads, mixer, navigateur, listes intelligentes et related, sampler, MIDI, préférences
  automix.js, library.js, app.js
src/shared/      code pur testé sous Node : DSP, Camelot, XML, rekordbox.xml, smartlist, related, MIDI, WAV
src/search/      moteur de recherche façon Rekordbox
```

Les données sont dans `%APPDATA%\rbclone\` : `library.json`, `analysis/`, `samples/`, `models/` (modèles de stems : `spleeter/` pour FAST, `htdemucs_fp16weights.onnx` pour HQ). Les stems sont gardés **à côté de la musique**, dans `<dossier du morceau>\stems\<morceau>\{vocals,drums,bass,other}.wav`, la version HQ remplaçant la FAST. Si le dossier n'est pas inscriptible, ou selon le réglage, ils vont dans `stems/<id>/` (cache caché).

La suite est dans [docs/ROADMAP.md](docs/ROADMAP.md) : phase 5 (export USB pour CDJ, mode Edit, Pad FX, vidéo…).
