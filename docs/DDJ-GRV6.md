# Pioneer DDJ-GRV6 et RBClone

Branche le contrôleur et lance RBClone, il est reconnu automatiquement :
- **Mapping** : le profil est intégré à l'app. Il a été généré depuis le fichier de mapping officiel `DDJ-GRV6.midi.csv` de ton installation Rekordbox, soit 273 entrées et 258 fonctions.
- **Carte son** : celle du GRV6 est choisie toute seule. Le master sort sur les sorties 1/2, le casque sur 3/4. On peut le désactiver dans ⚙ > Audio output.
- **Diagnostic** : ⚙ > MIDI affiche le **moniteur MIDI**. Chaque message reçu y apparaît avec la fonction qu'il a déclenchée.

> Testé avec un **GRV6 virtuel**, qui envoie exactement les messages du mapping officiel (12 étapes du test `npm run smoke`). **Pas encore testé sur le contrôleur physique.** Si un réglage ne tombe pas juste (sens du fader de tempo, sensibilité des jogs), l'option ou la constante à ajuster est indiquée ci-dessous.

## Ce qui est pris en charge

| Section | Contrôles |
|---|---|
| Decks (×4, DECK 1/3 et 2/4) | PLAY, CUE, SHIFT+CUE (début du morceau), jog : scratch en mode VINYL, pitch bend sur la tranche, SHIFT+jog pour une recherche rapide. Fader de tempo en 14 bits avec reprise douce. MASTER TEMPO, TEMPO RANGE, SYNC, MASTER, KEY SYNC, KEY RESET, LOOP IN/OUT, 4-beat loop en appui long, RELOOP/EXIT, CALL ◀ ▶ et ½ ×2, MEMORY, DELETE, QUANTIZE, TAP (grille), SLIP, VINYL |
| Pads (8 par deck + SHIFT) | HOT CUE (A–H, SHIFT = effacer), BEAT JUMP (±1…±8, puis ±16…±128 via SHIFT+pads 7/8), BEAT LOOP (¼ à 32), SAMPLER (lecture, SHIFT = stop), KEYBOARD et KEY SHIFT (pages +/−), PAD FX (16 effets momentanés), STEMS (ACTIVE PART vocal/inst/bass/drums) |
| Groove Circuit | DRUM SWAP 1–4, banques A/B, mode simple ou multiple, potard DRUM SWAP GAIN, DRUM CAPTURE (1/2/4 mesures via SHIFT), DRUM ROLL ⅛ ¼ ½ 1 et DRUM TRANS (SHIFT), DRUM RELEASE FX |
| Mixer | TRIM, EQ HI/MID/LOW, PART ISOLATOR (SHIFT+CUE, puis les potards règlent VOCAL / INST / DRUMS), CFX par voie, CFX ON et SELECT, faders de voie, crossfader, CUE casque, MASTER CUE, fader start de voie et de crossfader |
| Beat FX | Les 14 effets du sélecteur : DELAY, ECHO, LOW CUT ECHO, SPIRAL, HELIX, REVERB, FLANGER, PHASER, FILTER, TRANS, PITCH, ROLL, MOBIUS SAW, MOBIUS TRI. BEAT ◀ ▶, AUTO, TAP, assignation CH1–4 / MASTER / SAMPLER, LEVEL/DEPTH, ON, RELEASE FX |
| Navigation | Encodeur BROWSE (arborescence ou liste), appui pour ouvrir, BACK, SHIFT+BROWSE (zoom des formes d'onde), LOAD 1–4 (double appui = Instant Doubles), sauts de page et début/fin, AREA, BROWSE VIEW, SHIFT+BROWSE VIEW (Tag List), DISCOVER (Track Suggestion), SHIFT+DISCOVER (Related Tracks), PREVIEW au casque, SAMPLER (panneau) |
| LED et voyants | Tous les boutons ci-dessus, pads selon le mode, VU-mètres de voie, anneau lumineux des jogs, LOADED, LOOP ACTIVE, SLIP |

## Différences avec Rekordbox
- **Couleurs des pads** : elles s'allument ou s'éteignent, sans la couleur du hot cue. La palette RGB du GRV6 n'est pas documentée dans le mapping.
- **Groove Circuit et PART ISOLATOR** : ils agissent sur les stems. Le bouton STEMS du deck (ou l'option « séparer au chargement ») lance la séparation FAST depuis la tête de lecture : les parties sont utilisables au bout de 2 à 3 s, puis le reste du morceau suit à environ 7× le temps réel.
- **DRUM SWAP** : les banques démarrent vides, alors que Rekordbox fournit des boucles de batterie. On les remplit avec DRUM CAPTURE.
- **DRUM RELEASE FX** : un seul type, un freinage de la batterie.
- **FX PART SELECT** : le choix de la partie est mémorisé, mais le Beat FX s'applique à toute la voie.
- **Jogs** : réglés sur 720 crans par tour à 33⅓ tours/min (`Deck.JOG_SEC_PER_TICK` dans `src/renderer/audio/deck.js`).
- **Fader de tempo** : si le sens est inversé sur ton appareil, coche ⚙ > MIDI > « Invert tempo slider direction ».

## Autres contrôleurs Pioneer
Pour un autre contrôleur, RBClone cherche `MidiMappings/<modèle>.midi.csv` dans ton installation Rekordbox et l'utilise pour toutes les fonctions qu'il connaît. Le MIDI learn de ⚙ > MIDI permet d'ajouter le reste.
