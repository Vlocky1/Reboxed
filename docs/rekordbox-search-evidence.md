# How track search works in Rekordbox 7.2.18: reverse-engineering evidence

**Target:** `C:\Program Files\rekordbox\rekordbox 7.2.18\rekordbox.exe` (x64 PE, about 100 MB, image base `0x140000000`).

**Method:**
- The analysis was static and read-only. REA had no decompiler configured on this host: Ghidra is not set up, and IDA/Hopper are not available.
- The disassembly was read by hand, using capstone and pefile with:
  - function boundaries from `.pdata`,
  - RIP-relative cross-references,
  - RTTI-to-vtable resolution.
- All addresses are virtual addresses (VAs). Code excerpts are paraphrased from the disassembly, not decompiler output.
- `master.db` is encrypted with SQLCipher. It was **not** opened, and no attempt was made to recover the key.

**Confidence levels:**
- **Confirmed:** seen directly in the code or data.
- **Likely:** strongly suggested by the evidence, but not proven.
- **UI strings only:** known only from text shown in the interface.

## Summary

Rekordbox is a native C++ app built on **JUCE**, with ICU 51 linked statically. It does not search with SQL:

1. Tracks are loaded from `master.db` into in-memory `db::RowDataTrack` objects.
2. Each searchable text field is a `MultipurposeString`, which stores three things:
   - the original text;
   - a precomputed **search form**: NFKD → a few extra letter folds → uppercase;
   - a **64-bit character-class mask**.
3. The query is split on whitespace into tokens. A track is kept when **every token is a substring of at least one selected field**.
4. Search runs 500 ms after the last keystroke.

## Evidence

### 1. Architecture: confirmed
- About 1,784 `juce` strings. JUCE RTTI includes `juce::Array`, `DummyCriticalSection@juce` and `rbxfrm::TaskDrivenThreadWithLockType<juce::SpinLock>`.
- There are no Qt DLLs and no QML. `rekordboxAgent-win32-x64/` is a separate Electron agent.
- Search classes found in RTTI:
  - **UI:** `browse::SearchFilter`, `SearchTargetSelector`, `SelectSearchFilterButton`, `BrowseFilterView`, `Browse{Bpm,Key,Rate,Color,Mytag}Filter`, `BrowseCategoryFilterView`, `BrowseColumnFilterView`.
  - **Data:** `db::DbSearchEngine`, `AbstractTrackSearch`, `TrackListFilter`, `TrackFilterData`, `AttributeFilter`, `RelatedTrack*Search`.
  - **Middleware:** `rb::middleware::db::rekordbox::PlaylistSearchService` and `PlaylistSearchTimer`.
- Key vtables:

  | Class | vtable |
  |---|---|
  | `DbSearchEngine` | `0x143ac52a8` (slot 1 = `0x141f24d20`) |
  | `TrackListFilter` | `0x1436f8f68` |
  | `browse::SearchFilter` | `0x14377d480` |

### 2. Data source: in-memory, not SQL (confirmed)
- `master.db` is not plain SQLite. Its header is not `SQLite format 3`, which means it is encrypted.
- The rows are loaded with plain SELECT statements:

  | Address | What it loads |
  |---|---|
  | `0x14204c530` | RowDataTrack, built from `djmdContent` |
  | `0x14202ad10` | `select djmdAlbum.*, djmdArtist.Name as ArtistName ... inner join djmdArtist` |
  | `0x14202b090` | `select * from djmdGenre where rb_local_deleted = 0` |
  | `0x14208d0a0` | `select MyTagID, ContentID from djmdSongMyTag where rb_local_deleted = 0` |

- There is **no search SQL**. The only `LIKE` strings in the binary are for path relocation (`FolderPath like '`), a stream-quality check, and a generic DAO `ESCAPE`. There is no FTS, `MATCH` or `COLLATE` used for search.
- `0x141e57610` fetches the list's tracks (`0x141e57720`), then calls `0x141f24350(DbSearchEngine, query, trackArray)`.
  - That function removes non-matching tracks from the array in place: `memmove` at `0x142ec6f10`, count decrement at `0x141f244b1`.
  - So the list keeps its current sort order and there is no ranking.

### 3. Normalization: `MultipurposeString::formatForSearch` @ `0x141d70f80`
- **Confirmed:**
  - `icu::Normalizer::normalize(src, mode=3 /*UNORM_NFKD*/, ...)` at `0x1427f0690`, called from `0x141d7103e` with `edx=3`.
  - `findAndReplace` (`0x1427eaf40`) then folds Ð/ð → D, ƒ → F, ı → I, Ø/ø → O.
- **Likely:** `UnicodeString::toUpper()` with the default locale (`0x1427efb70`). This identification is based on the shape of the ICU code.
- **Consequences:**
  - Full-width letters match half-width ones.
  - Combining marks are **kept**. So `cafe` finds `café`, but `café` does not find `cafe`.
  - Hiragana and katakana are **not** unified.
- **Mask loop at `0x141d71433` (confirmed).** For each UTF-16 code unit c:

  | Character range | Mask bit |
  |---|---|
  | `0`–`9` | 0–9 |
  | `A`–`Z` | 10–35 |
  | other ASCII | 36 |
  | ≤ U+00FF | 37 |
  | ≤ U+02FF | 38 |
  | ≤ U+0FFF | 39 |
  | surrogates | 55 |
  | anything else | `40 + ((c − 0x1000) >> 12)` |

### 4. Matching: confirmed
- **Contains test** (`0x141f255c0`):
  ```
  if (!(flags & 1)) return false;
  if ((tokenMask & ~fieldMask) != 0) return false;   // mask pre-reject
  return field.searchForm.contains(token.searchForm); // substring
  ```
- **Tokenizer** (`0x1414b8c30`): `StringArray::addTokens(text, " \u3000\t", " \u3000\t")` followed by `removeEmptyStrings`.
  - Tokens split on space, ideographic space and tab.
  - There are no quoted phrases and no operators.
- **Combining tokens** (`0x141f24350`): **AND across tokens, OR across fields**.
- **"All" fields** (`0x141f24d20`), in this order:
  - Title, Album, Artist, Genre, Album Artist, Composer, Remixer, Original Artist, Label.
  - Then Year and BPM, but **only if the token consists only of `0-9.`**.
  - Then Comments, Mix Name, Grouping.
- **Per-field dispatch** (`0x141f24a60`):
  - **Year:** `sprintf("%d")`, then `strstr` against the raw token.
  - **BPM:** `"%d.%02d"` of BPM×100, then `strstr` against the raw token.
  - In both cases a value of 0 never matches.

### 5. UX behavior
- **Confirmed:**
  - Debounce: in `0x1414b8c30`, the delay is `typing && text non-empty ? 500 : 0` (`and ecx, 0x1f4`). `PlaylistSearchTimer` is at `0x142162140`, with its callback at `0x1421621d0`.
  - The search is skipped when the field and tokens are unchanged (`0x1414b8d8f`–`0x1414b8dab`).
  - TextEditor listeners: `textChanged` `0x141556a90`, `returnKey` `0x141556b40`, `escapeKey` `0x141556b60` (clears the box).
  - Changing the field (`0x141556d00`) searches immediately.
- **UI strings only, likely in code:** the scope is the list currently shown, either the Collection or the selected playlist.
- **Track Filter:**
  - BPM base ± 0–6% (strings at `0x1436f9790`) — confirmed.
  - "Set BPM and KEY from the MASTER DECK" (`0x141395ff0`) — confirmed.
  - Key, Rating and Color selectors — UI strings only.
  - My Tag with "Match all" / "Match any" — confirmed in the UI.
- **Related Tracks:**
  - Rule criteria (BPM, key, artist, genre, label, year, history, color, rating, My Tag, file format, and others) combined with match-all or match-any.
  - Runs asynchronously.
  - The algorithms were not decompiled.

## What was reimplemented and where

| Rekordbox | RBClone |
|---|---|
| `formatForSearch` NFKD → folds → upper, plus the mask | `src/search/normalize.js`: `normalizeForSearch`, `charClassMask`, `SearchString` |
| `MultipurposeString::contains` | `SearchString.contains` |
| `addTokens(" \u3000\t")` | `tokenize` in `src/search/engine.js` |
| `DbSearchEngine` fields, Year/BPM rules, AND/OR loop | `searchTracks`, `IndexedTrack`, `formatBpm` |
| Track Filter panel | `src/search/filters.js`: `compileTrackFilter` |
| `SearchFilter` + `PlaylistSearchTimer` | `src/search/controller.js`: `SearchController` |

**Optional extras that go beyond Rekordbox:**
- `foldAccents`: makes accent matching work in both directions.
- `foldKana`: unifies katakana and hiragana.

## Unknowns
- The Key-filter "related keys" semantics and the internals of the Rating and Color filters. Simple set membership is used instead.
- The ranking used by Related-tracks.
- What `DbSearchEngine` mode 2 means.
- Which list types wait for Enter instead of searching while typing (the check is at `0x141557570`; these are likely streaming lists).
- No runtime tracing was done.
