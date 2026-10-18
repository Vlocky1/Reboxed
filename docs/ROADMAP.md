# Feuille de route RBClone

Source : un inventaire statique de Rekordbox 7.2.18, fait avec REA en lecture seule. Il s'appuie sur :
- les chaînes de l'interface (`locale\*.lang`, environ 5 400 entrées) ;
- les classes RTTI ;
- les fichiers `pad\*.pad.csv` et `MidiMappings\*.midi.csv` ;
- les noms de clés de réglages.

Rien n'a été décompilé : les algorithmes internes (DSP des effets, time-stretch, détection) sont réécrits de zéro. Le chiffrement SQLCipher de `master.db`, le DRM (`clatc.dll`/Widevine) et les identifiants des services de streaming ont été volontairement ignorés.

Légende : ✅ fait · 🟡 partiel · ⬜ à faire

## Phase 1 : cœur (✅)
- ✅ Collection, tags, playlists/dossiers, historiques, notes, couleurs (hex Rekordbox), My Tag, colonnes.
- ✅ Recherche identique à Rekordbox, Track Filter (BPM ±0–6 %, Key, Rating, Color, My Tag ET/OU).
- ✅ `rekordbox.xml` en import et en export (TRACK, TEMPO, POSITION_MARK, NODE). Les listes intelligentes sont exportées avec leur contenu du moment.
- ✅ Outil d'import rekordbox :
  - aperçu chiffré, puis sélection des playlists ;
  - fusion : rekordbox gagne, ou on ne remplit que les champs vides ;
  - cues remplacées, fusionnées ou gardées ;
  - fichiers déplacés retrouvés par nom et taille, avec déduction des règles de dossier ;
  - réimport qui met à jour le dossier « rekordbox » sans créer de doublons ;
  - tonalité, grille et cues importées conservées par l'analyse.
- ⬜ My Tags et historiques : ils ne figurent pas dans `rekordbox.xml`. Il faudrait lire `master.db`, qui est chiffrée.
- ✅ Analyse : BPM/grille à tempo constant, plages BPM, tonalité Camelot/classique, forme d'onde 3Band/RGB/BLUE, loudness.
- ✅ Decks : CUE CDJ, memory cues, boucles 1/64–512, beat jump, quantize, tempo ±6/10/16/WIDE, Master Tempo, Key Shift/Sync, Slip, Reverse.
- ✅ Mixer : trim, auto-gain, isolateur 3 bandes, cue casque sur une 2ᵉ sortie, courbes de fader et de crossfader, limiteur.

## Phase 2 : essentiels DJ (✅ sauf ⬜)
- ✅ 4 decks (préférence 2/4) : disposition 1-2-[mixer]-3-4, 4 formes d'onde.
- ✅ 16 hot cues A–P en deux banques.
- ✅ Intelligent Playlists : Match all/any. Texte : contient, ne contient pas, est, n'est pas, commence par, finit par. Nombres : plage, est, ≥, ≤. Dates : N derniers jours ou plage. Tonalité : est ou compatible. My Tag, couleur, limite de taille. Une liste peut être figée en playlist normale.
- ✅ Tag List : bac temporaire, conversion en playlist.
- ✅ Related Tracks : BPM ± avec double/demi, tonalité identique ou relative, genre, artiste (y compris feat. et titre), label, couleur, My Tag, année ±N, note. Référence : master, un deck précis ou la sélection.
- ✅ Beat Sync vs BPM Sync ; sync double/demi optionnelle.
- ✅ Beat FX (16) : DELAY, ECHO, PING PONG, REVERB, FLANGER, PHASER, FILTER, TRANS, ROLL, REV ROLL, VINYL BRAKE, PITCH, UP ECHO, DOWN ECHO, PAN, ROBOT. Assignables sur CH1–4 ou MASTER.
- ✅ Color FX : FILTER, SPACE, DUB ECHO, NOISE, CRUSH, pilotés par le knob COLOR de chaque voie.
- ✅ MIDI : Web MIDI, détection automatique des contrôleurs, MIDI learn dans les Préférences. Messages note, CC, pitch-bend 14 bits et encodeurs relatifs (jog, défilement).
- ⬜ Ableton Link : nécessite un module natif.
- ⬜ Matching (paires de morceaux).
- ⬜ Éditeur de raccourcis clavier : seul le preset fixe existe.
- ⬜ Beat FX restants : SPIRAL, MT DELAY, SLIP ROLL, STRETCH, ENIGMA JET, HELIX. Mode multi (3 FX). Release FX.
- ⬜ Color FX restants : PITCH, SWEEP, GATE COMP, JET.
- ⬜ Import des CSV de mapping MIDI Rekordbox.

## Phase 3 : performance (✅ sauf ⬜)
- ✅ Pad modes : HOT CUE, BEAT LOOP, BEAT JUMP, SLICER (8 tranches, retour en slip), SAMPLER, KEY SHIFT, KEYBOARD.
- ✅ Sampler 16 slots :
  - one-shot ou boucle, gain par slot, volume ;
  - synchro au tempo du master, départ calé sur le prochain temps ;
  - glisser-déposer d'un morceau, capture de la boucle d'un deck en WAV ;
  - configuration restaurée au démarrage.
- ✅ Automix : depuis la liste affichée, préchargement, sync, fondu au crossfader de 4 à 32 temps, répétition et lecture aléatoire.
- ✅ Censor (maintien), Instant Doubles, éjection.
- ✅ Enregistrement WAV 16 bits en streaming dans `Musique\RBClone Recordings\`, ajouté automatiquement à la collection et à la playlist « Recordings ».
- ⬜ PAD FX, ACTIVE CENSOR, SP.SCRATCH.
- ⬜ Séquenceur du sampler, packs `.spp`, sampler OSC.
- ⬜ Enregistrement : déclenchement à -60 dB, arrêt sur silence, découpage.

## Phase 4 : analyse avancée (✅ sauf ⬜)
- ✅ **Grilles dynamiques** (Préférences > Beatgrid mode = Dynamic) :
  - suivi des temps par programmation dynamique avec tempo local ; un tempo stable redonne une grille constante ;
  - la sync suit les variations de tempo ;
  - export/import `rekordbox.xml` avec un marqueur TEMPO par changement de tempo.
- ✅ **Premier temps de mesure** : changements d'harmonie, énergie, attaque du kick, débuts de section. Il sert aux barres de mesure, au slicer et aux phrases.
- ✅ **Éditeur de grille** (bouton GRID) : premier temps ici, décalage de ±10 ms ou ±1 temps, ×2/÷2, BPM ±0,01, tap tempo, conversion dynamique → constante, verrouillage, ré-analyse en mode normal ou dynamique.
- ✅ **Analyse des phrases** : frontières sur des blocs de 4 ou 8 mesures, mood High / Mid / Low. Étiquettes INTRO/UP/CHORUS/DOWN/OUTRO ou INTRO/VERSE/CHORUS/BRIDGE/OUTRO, affichées sur les formes d'onde.
- ✅ **Intelligent Cue Creation** :
  - un memory cue par phrase ;
  - hot cues A = intro, B = premier refrain, C = premier breakdown, D = outro, E = boucle d'intro de 8 mesures ;
  - à la demande, ou automatiquement après l'analyse (option dans les Préférences) ;
  - les cues existants ne sont jamais écrasés.
- ✅ **Stems** VOCAL/INST/BASS/DRUMS :
  - **FAST** : Spleeter 4 stems ONNX (licence Apache-2.0, 79 Mo, téléchargé automatiquement au premier usage). Environ 7× le temps réel sur CPU ; la séparation commence au bloc de la tête de lecture et les blocs sont envoyés au deck au fil de l'eau (mix d'origine là où rien n'est encore prêt). Approche inspirée de Serato : séparation à la demande, pas besoin de pré-analyser ;
  - **HQ** : HT-Demucs v4 ONNX (licence MIT, 166 Mo, Préférences > Stems), avec la normalisation par moyenne et écart-type de demucs, progressive elle aussi. En mode *auto* : FAST tout de suite, puis montée en HQ en arrière-plan ;
  - visibilité : pastille dans la barre du haut (qualité, %, temps restant, file d'attente), bouton STEMS avec remplissage, barre de couverture sur la vue d'ensemble, colonne « Stems » (FAST/HQ/%), forme d'onde colorée par stem ;
  - calcul dans un process isolé, cache sur disque ;
  - par deck : clic = couper, Maj+clic = solo, fondu entre le mix d'origine et la somme des stems.
- ✅ **Positions vocales** : déduites du stem voix, affichées en rose sous les formes d'onde.
- ✅ **Mix Point Link** : MIX IN / MIX OUT par morceau ; au MIX OUT, le deck partenaire démarre synchronisé depuis son MIX IN. L'Automix utilise aussi ces points.
- ✅ **Track Suggestion** : empreinte audio de 18 dimensions (harmonie, brillance, énergie, grave/aigu, densité rythmique, dynamique), compatibilité de tempo.
- ⬜ STEM FX et STEM ISO en potentiomètres continus (aujourd'hui : coupure et solo).
- ⬜ Séparation en temps réel pendant la lecture. Aujourd'hui elle se fait à l'avance, en environ 1,4 × la durée du morceau sur CPU.
- ⬜ DirectML (GPU) : le moteur ONNX plante nativement sur ce PC pendant l'inférence. L'option reste expérimentale, avec repli automatique sur CPU.

## Contrôleurs (✅ DDJ-GRV6)
- ✅ **DDJ-GRV6** : mapping intégré, LED, jogs (scratch, pitch bend, recherche), pad modes, Groove Circuit, PART ISOLATOR, Beat FX du GRV6, carte son 4 canaux, moniteur MIDI. Détails dans [DDJ-GRV6.md](DDJ-GRV6.md).
- ✅ **Autres contrôleurs Pioneer** : lecture de leur `.midi.csv` dans l'installation Rekordbox.
- ⬜ Couleurs RGB des pads (palette non documentée), banques de boucles DRUM SWAP fournies d'office, FX PART SELECT réel.

## Phase 5 : extras
- ⬜ Export USB/SD pour CDJ : `export.pdb` et fichiers `ANLZ0000.DAT/.EXT/.2EX`, d'après les spécifications publiques.
- ⬜ Mode EDIT : éditeur de clips quantisé, rendu en fichier.
- ⬜ Pad FX presets, Merge FX, Groove Circuit.
- ⬜ Vidéo, paroles, éclairage DMX, synchro cloud et mobile.

## Limites connues
- **Grille et phrases :** la détection est calibrée sur de la musique électronique à kick. Les phrases et le mood sont des heuristiques (énergie, kick, aigus), pas un modèle appris ; corrige au besoin avec le bouton GRID et les cues.
- **Stems :** environ 42 Mo de cache par minute de musique (4 stems en PCM 16 bits), soit environ 250 Mo pour un morceau de 6 min. Le cache se vide dans les Préférences.
- **Master Tempo et effets de hauteur :** le Master Tempo utilise un time-stretch granulaire, et PITCH un pitch-shifter à deux têtes. Corrects jusqu'à environ ±10 %, en dessous de la qualité studio.
- **Cue casque :** passe par un élément `<audio>` sur un second périphérique, avec quelques dizaines de ms de latence.
- **Sampler en mode SYNC :** il change la vitesse de lecture, donc aussi la hauteur.
