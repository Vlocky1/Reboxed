# Pioneer DDJ-GRV6 et Reboxed

Branche le contrôleur et lance Reboxed, il est reconnu automatiquement :
- **Mapping** : c'est un plugin fourni avec l'app (`src/plugins/pioneer-ddj-grv6`, Préférences ▸ Plugins). Il a été généré depuis le fichier de mapping officiel `DDJ-GRV6.midi.csv` de Rekordbox, soit 273 entrées et 258 fonctions. Pour l'ajuster sans recompiler, installe un plugin du même id (voir [PLUGINS.md](PLUGINS.md)).
- **Carte son** : celle du GRV6 est choisie toute seule. Le master sort sur les sorties 1/2, le casque sur 3/4. On peut le désactiver dans ⚙ > Audio output.
- **Diagnostic** : ⚙ > MIDI affiche le **moniteur MIDI**. Chaque message reçu y apparaît avec la fonction qu'il a déclenchée.

> Testé avec un **GRV6 virtuel**, qui envoie exactement les messages du mapping officiel (17 étapes du test `npm run smoke`). **Pas encore testé sur le contrôleur physique.** Si un réglage ne tombe pas juste (sens du fader de tempo, sensibilité des jogs), l'option ou la constante à ajuster est indiquée ci-dessous.

## Ce qui est pris en charge

| Section | Contrôles |
|---|---|
| Decks (×4, DECK 1/3 et 2/4) | PLAY, CUE, SHIFT+CUE (début du morceau), jog : scratch en mode VINYL, pitch bend sur la tranche, SHIFT+jog pour une recherche rapide. Fader de tempo en 14 bits avec reprise douce. MASTER TEMPO, TEMPO RANGE, SYNC, MASTER, KEY SYNC, KEY RESET, LOOP IN/OUT, 4-beat loop en appui long, RELOOP/EXIT, CALL ◀ ▶ et ½ ×2, MEMORY, DELETE, QUANTIZE, TAP (grille), SLIP, VINYL |
| Pads (8 par deck + SHIFT) | HOT CUE (A–H, SHIFT = effacer), BEAT JUMP (±1…±8, puis ±16…±128 via SHIFT+pads 7/8), BEAT LOOP (¼ à 32), SAMPLER (lecture, SHIFT = stop), KEYBOARD (SHIFT+pad = hot cue de départ) et KEY SHIFT (pages +/−), PAD FX (16 effets momentanés), STEMS (rangée du haut : ACTIVE PART vocal/inst/bass/drums ; rangée du bas : FX PART SELECT) |
| Groove Circuit | DRUM SWAP 1–4 avec **8 boucles intégrées** (banque A : House, Techno, Tech House, Disco ; banque B : Breakbeat, UK Garage, Hip-Hop, Trap), générées au tempo du deck. Banques A/B, mode simple ou multiple, potard DRUM SWAP GAIN. DRUM CAPTURE (1/2/4 mesures via SHIFT) : les captures remplacent les boucles intégrées et sont **gardées d'une session à l'autre**. DRUM ROLL ⅛ ¼ ½ 1, DRUM TRANS (SHIFT), DRUM RELEASE FX avec **5 effets** (BRAKE, BACKSPIN, ROLL, FILTER, ECHO), choisis avec SHIFT+DRUM RELEASE FX ou RELEASE FX SELECT |
| FX PART SELECT | Le Beat FX s'applique **seulement aux parties choisies** (VOCAL, INST, BASS, DRUMS), le reste de la voie n'est pas touché. LED par partie |
| Mixer | TRIM, EQ HI/MID/LOW, PART ISOLATOR (SHIFT+CUE, puis les potards règlent VOCAL / INST / DRUMS), CFX par voie, CFX ON et SELECT, faders de voie, crossfader, CUE casque, MASTER CUE, fader start de voie et de crossfader |
| Beat FX | Les 14 effets du sélecteur : DELAY, ECHO, LOW CUT ECHO, SPIRAL, HELIX, REVERB, FLANGER, PHASER, FILTER, TRANS, PITCH, ROLL, MOBIUS SAW, MOBIUS TRI. BEAT ◀ ▶, AUTO, TAP, assignation CH1–4 / MASTER / SAMPLER, LEVEL/DEPTH, ON, RELEASE FX |
| Navigation | Encodeur BROWSE (arborescence ou liste), appui pour ouvrir, BACK, SHIFT+BROWSE (zoom des formes d'onde), LOAD 1–4 (double appui = Instant Doubles), sauts de page et début/fin, AREA, BROWSE VIEW, SHIFT+BROWSE VIEW (Tag List), DISCOVER (Track Suggestion), SHIFT+DISCOVER (Related Tracks), PREVIEW au casque, SAMPLER (panneau) |
| Decks 3 et 4 | Les boutons DECK 1/3 et 2/4 passent l'écran en 4 decks quand la couche 3/4 est choisie |
| LED et voyants | Tous les boutons ci-dessus, pads selon le mode, FX PART SELECT, DRUM CAPTURE, VU-mètres de voie, anneau lumineux des jogs, LOADED, LOOP ACTIVE, SLIP |

À l'écran, les modes de pads **STEMS** et **GROOVE** reprennent ces fonctions, ce qui permet de s'en servir sans le contrôleur :
- **STEMS** : pads 1–4 = ACTIVE PART, pads 5–8 = FX PART.
- **GROOVE** : pads 1–4 = DRUM SWAP, 5 = banque A/B, 6 = CAPTURE (Maj+clic pour la longueur), 7 = ROLL ¼ (maintenu), 8 = RELEASE FX (maintenu, Maj+clic pour le type).

## Différences avec Rekordbox
- **Couleurs des pads** : elles s'allument ou s'éteignent, sans la couleur du hot cue. La palette RGB du GRV6 n'est pas documentée dans le mapping.
- **Stems à la demande** : le Groove Circuit, le PART ISOLATOR et FX PART agissent sur les stems. Si le morceau n'en a pas encore, toucher l'un de ces boutons lance la séparation FAST depuis la tête de lecture : les parties sont utilisables au bout de 2 à 3 s. Une boucle DRUM SWAP démarre tout de suite et remplace la batterie du morceau dès que les stems arrivent.
- **Boucles DRUM SWAP** : ce sont celles de Reboxed (synthétisées, aucun échantillon tiers), pas celles de Rekordbox.
- **Boutons non pris en charge** : réglages internes du GRV6 (mode démo, mise en veille, intervalles MIDI). Ils n'ont pas d'effet dans Rekordbox non plus.
- **Jogs** : réglés sur 720 crans par tour à 33⅓ tours/min (`Deck.JOG_SEC_PER_TICK` dans `src/renderer/audio/deck.js`).
- **Fader de tempo** : si le sens est inversé sur ton appareil, coche ⚙ > MIDI > « Invert tempo slider direction ».

## Autres contrôleurs Pioneer
Pour un autre contrôleur, Reboxed cherche `MidiMappings/<modèle>.midi.csv` dans ton installation Rekordbox et l'utilise pour toutes les fonctions qu'il connaît. Le MIDI learn de ⚙ > MIDI permet d'ajouter le reste.
