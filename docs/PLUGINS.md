# Hardware plugins

A plugin teaches Reboxed a piece of hardware: which MIDI messages its buttons, knobs and jogs send,
which LEDs it has, and which sound card it brings. Reboxed ships plugins for the Pioneer DDJ-GRV6,
DDJ-FLX2, DDJ-FLX4, DDJ-FLX6 and DDJ-FLX10. Anyone can write one for another controller and share it.

Plugins are managed in **Preferences > Plugins**: enable / disable, install a plugin folder, create
one from a controller mapping (CSV), remove, open the plugins folder.

## Where plugins live

| Folder | What |
| --- | --- |
| `src/plugins/<id>/` | Built-in plugins (shipped with Reboxed, read only). |
| `%APPDATA%\Reboxed\plugins\<id>\` | Plugins you installed or created. |

A plugin you install with the **same id** as a built-in one replaces it: that is how you fix or
extend a built-in mapping without rebuilding Reboxed.

## The quickest way: from a controller mapping (CSV)

Many controllers come with a MIDI mapping file installed by their manufacturer's DJ software
(`MidiMappings\<model>.midi.csv`). Reboxed understands that format directly:

- In the app: **Preferences > Plugins > Create from a controller mapping (CSV)…**, pick the `.csv`, give a
  name and the MIDI port name. Done.
- From the command line (for contributors):

  ```sh
  node scripts/plugin-from-csv.mjs "C:\...\MidiMappings\DDJ-400.midi.csv" src/plugins/pioneer-ddj-400 \
    --id pioneer-ddj-400 --name "Pioneer DDJ-400" --match DDJ-400 --decks 2
  ```

Even without a plugin, a controller whose mapping file is installed on the computer is picked up
automatically; a plugin makes it work anywhere and lets you tune it.

## plugin.json

```json
{
  "id": "pioneer-ddj-grv6",
  "name": "Pioneer DDJ-GRV6",
  "version": "1.1.0",
  "author": "Reboxed",
  "kind": "controller",
  "description": "4-deck controller with Groove Circuit…",
  "match": ["DDJ-GRV6"],
  "driver": "pioneer",
  "mapping": "mapping.json",
  "decks": 4,
  "audio": { "device": "GRV6", "layout": "quad" },
  "fxPartPadStatus": [151, 153, 155, 157],
  "padModes": { "1": "HOT CUE", "2": "PAD FX" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lower-case letters, digits, `-`, `_`, `.`; also the folder name once installed. |
| `name`, `version`, `author`, `description` | no | Shown in Preferences > Plugins. |
| `kind` | yes | `"controller"` (the only kind for now). |
| `match` | yes | Parts of the MIDI port name (case and punctuation ignored). The longest match wins. |
| `driver` | no | `"pioneer"` (default): the mapping uses the standard Pioneer function names. |
| `mapping` | yes | `mapping.json` (Reboxed format) or a raw `.midi.csv` mapping. |
| `decks` | no | 2 or 4. |
| `audio` | no | `device`: part of the sound card name to select when the controller connects; `layout`: `"stereo"` or `"quad"` (master on 1/2, headphones on 3/4). Users can turn this off (Preferences > Audio). |
| `padModes` | no | For controllers whose pads use generic names (`PADn_PadModeM`, `PadModeM`): what each mode number is. Values: `HOT CUE`, `PAD FX`, `PAD FX2`, `SLICER`, `BEAT JUMP`, `BEAT LOOP`, `SAMPLER`, `KEYBOARD`, `KEY SHIFT`, `STEMS`, `MEMORY CUE`. Pressing a mode button opens the matching pad page on screen. |
| `fxPartPadStatus` | no | MIDI status bytes (per deck) of the FX PART SELECT pads, when the mapping has no deck column for them. |

## mapping.json

The parsed form of a `.midi.csv` mapping (see `src/shared/controllers/rbcsv.js`):

```json
{
  "device": "DDJ-TEST",
  "entries": [
    {
      "name": "PlayPause", "label": "PlayPause", "type": "Button",
      "inputs":  [{ "status": 144, "data1": 11, "deck": 0 }, { "status": 145, "data1": 11, "deck": 1 }],
      "outputs": [{ "status": 144, "data1": 11, "deck": 0 }, { "status": 145, "data1": 11, "deck": 1 }],
      "options": { "Fast": true },
      "comment": "Play/Pause"
    }
  ]
}
```

- `name` is the function (standard names: `PlayPause`, `Cue`, `Sync`, `JogScratch`, `TempoSlider`,
  `ChannelFader`, `CrossFader`, `EQHigh`, `PAD1_HotCue`, `PAD1_PadMode2`, `FX1-1On`, `Browse`, `Load`…).
  `src/renderer/controller/pioneer.js` lists every function Reboxed handles; FX2 controls drive the
  same Beat FX unit as FX1.
- `inputs`: what the controller sends (`deck` = 0-3, or `null` for global controls).
  14-bit knobs and faders use the MSB / LSB pair of the same control.
- `outputs`: LEDs and rings Reboxed lights (same shape).
- Controller-side settings (`…Setting`, jog timing, demo mode…) are ignored.

Use **Preferences > MIDI**: its live monitor shows every message received and the functions it
triggered, which is the fastest way to check a new plugin.

## Sharing a plugin

Zip the plugin folder (`plugin.json` + mapping). Users install it with **Install a plugin folder…**
(after unzipping). To ship it with Reboxed, open a pull request adding it under `src/plugins/` and
adding its id to the list in `test/plugins.test.js`.
