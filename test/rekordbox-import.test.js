import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRekordboxXml, summarizeRekordbox, colourName } from '../src/shared/rekordbox-xml.js';
import { trackPatch, mergeCues, selectPlaylists, playlistPaths, remapPath, inferRules, forEachNode } from '../src/shared/rekordbox-import.js';
import { Library } from '../src/renderer/library.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.18" Company="AlphaTheta"/>
  <COLLECTION Entries="3">
    <TRACK TrackID="1" Name="Strobe" Artist="deadmau5" Album="For Lack of a Better Name" Genre="Progressive House"
      Kind="MP3 File" Size="25000000" TotalTime="637" DiscNumber="1" TrackNumber="5" Year="2009" AverageBpm="128.00"
      DateAdded="2024-01-02" Comments="Big build" Rating="204" Location="file://localhost/D:/Music/Strobe.mp3"
      Tonality="Am" Label="mau5trap" Mix="Original" Colour="0xFF0000" PlayCount="7">
      <TEMPO Inizio="0.025" Bpm="128.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="60.025" Num="0" Red="40" Green="226" Blue="20"/>
      <POSITION_MARK Name="Intro" Type="0" Start="0.025" Num="-1" Red="255" Green="0" Blue="0"/>
      <POSITION_MARK Name="Outro loop" Type="4" Start="500.0" End="507.5" Num="-1"/>
      <POSITION_MARK Name="" Type="3" Start="1.0" Num="-1"/>
    </TRACK>
    <TRACK TrackID="2" Name="Café" Artist="X" Location="file://localhost/D:/Music/House/Cafe.flac" Size="1000" Rating="0" Comments=""/>
    <TRACK TrackID="3" Name="Lonely" Artist="Y" Location="file://localhost/D:/Music/Lonely.mp3" Colour="0xFE0101"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Type="0" Name="Sets" Count="2">
        <NODE Name="Friday" Type="1" KeyType="0" Entries="2"><TRACK Key="2"/><TRACK Key="1"/></NODE>
        <NODE Name="Warmup" Type="1" KeyType="0" Entries="1"><TRACK Key="3"/></NODE>
      </NODE>
      <NODE Name="Faves" Type="1" KeyType="0" Entries="1"><TRACK Key="1"/></NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

function makeLibrary(tracks = [], playlists = []) {
  const lib = new Library({ tracks, playlists });
  lib.scheduleSave = () => {};
  return lib;
}

test('parser keeps disc number, cue types, memory cue colours and nearest track colour', () => {
  const { tracks } = importRekordboxXml(XML);
  const [t, cafe, lonely] = tracks;
  assert.equal(t.discNumber, 1);
  assert.equal(t.source, 'rekordbox');
  assert.equal(t.color, 'Red');
  assert.equal(lonely.color, 'Red'); // 0xFE0101 is not one of the 8 exact values
  assert.equal(colourName(''), '');
  assert.equal(t.cues[1].color, '#ff0000');
  assert.deepEqual(t.cues.map((c) => [c.kind, c.name, c.end, c.type]), [
    ['hot', 'Drop', undefined, undefined], ['memory', 'Intro', undefined, undefined],
    ['memory', 'Outro loop', 507.5, undefined], ['memory', '', undefined, 'load'],
  ]);
  assert.equal(cafe.comments, '');
});

test('summary counts what the preview shows', () => {
  const s = summarizeRekordbox(importRekordboxXml(XML));
  assert.deepEqual(
    [s.tracks, s.playlists, s.folders, s.entries, s.hotCues, s.memoryCues, s.loops, s.comments, s.grids, s.rated],
    [3, 3, 1, 4, 1, 3, 1, 1, 1, 1]);
});

test('trackPatch: rekordbox wins or only fills, unknown values never erase', () => {
  const x = importRekordboxXml(XML).tracks[1]; // Café: empty comment, 0 stars, no BPM/key
  const ours = { title: 'Cafe (edit)', comments: 'my note', rating: 3, bpm: 124, key: '8A', cues: [] };
  const over = trackPatch(ours, x, { metadata: 'overwrite' });
  assert.equal(over.title, 'Café');
  assert.equal(over.comments, '');  // cleared in rekordbox -> cleared here
  assert.equal(over.rating, 0);
  assert.equal('bpm' in over, false); // rekordbox has no BPM: keep ours
  assert.equal('key' in over, false);
  const fill = trackPatch(ours, x, { metadata: 'fill' });
  assert.equal(fill.title, undefined);
  assert.equal(fill.comments, undefined);
  assert.equal(fill.artist, 'X');
});

test('mergeCues: replace / merge / keep', () => {
  const ours = [{ kind: 'hot', slot: 0, start: 10 }, { kind: 'memory', start: 5 }];
  const theirs = [{ kind: 'hot', slot: 0, start: 60 }, { kind: 'hot', slot: 2, start: 70 }, { kind: 'memory', start: 5.004 }, { kind: 'memory', start: 90 }];
  assert.deepEqual(mergeCues(ours, theirs, 'replace').map((c) => c.start), [60, 70, 5.004, 90]);
  assert.deepEqual(mergeCues(ours, theirs, 'merge').map((c) => c.start), [10, 5, 70, 90]);
  assert.equal(mergeCues(ours, theirs, 'keep'), ours);
  assert.equal(mergeCues(ours, [], 'replace'), ours); // no cues in rekordbox: ours stay
});

test('playlist selection and paths', () => {
  const { playlists } = importRekordboxXml(XML);
  const keys = [];
  forEachNode(playlists, (n, k) => keys.push([k, n.name]));
  assert.deepEqual(keys, [['0', 'Sets'], ['0/0', 'Friday'], ['0/1', 'Warmup'], ['1', 'Faves']]);
  const only = selectPlaylists(playlists, new Set(['0/1']));
  assert.deepEqual(only.map((n) => [n.name, n.children?.map((c) => c.name)]), [['Sets', ['Warmup']]]);
  assert.deepEqual([...playlistPaths(only)], ['d:\\music\\lonely.mp3']);
  assert.deepEqual(selectPlaylists(playlists, new Set()), []);
});

test('moved music: per-file relocation and inferred folder rules', () => {
  const rules = inferRules([['D:\\Music\\House\\Cafe.flac', 'E:\\DJ\\Music\\House\\Cafe.flac']]);
  assert.deepEqual(rules, [['D:\\', 'E:\\DJ\\']]);
  assert.equal(remapPath('D:\\Music\\Strobe.mp3', { rules }), 'E:\\DJ\\Music\\Strobe.mp3');
  const relocated = new Map([['d:\\music\\strobe.mp3', 'F:\\x\\Strobe.mp3']]);
  assert.equal(remapPath('D:\\Music\\Strobe.mp3', { relocated, rules }), 'F:\\x\\Strobe.mp3');
});

test('library import: tracks, cues, playlists; re-import updates the rekordbox folder', () => {
  const lib = makeLibrary([
    { id: 'old', path: 'D:\\music\\strobe.mp3', title: 'Strobe (my tag)', comments: 'mine', cues: [{ kind: 'hot', slot: 5, start: 1 }], analyzed: true, myTags: ['peak'] },
  ], [{ id: 'mine', type: 'playlist', name: 'My own', trackIds: ['old'] }]);
  const parsed = importRekordboxXml(XML);
  const r = lib.importRekordbox(parsed, { missing: new Set(['d:\\music\\lonely.mp3']) });
  assert.deepEqual([r.added, r.updated, r.playlists, r.folders, r.missing], [2, 1, 3, 1, 1]);
  const strobe = lib.get('old');
  assert.equal(strobe.title, 'Strobe');
  assert.equal(strobe.comments, 'Big build');
  assert.equal(strobe.rating, 4);
  assert.equal(strobe.key, '8A');
  assert.equal(strobe.playCount, 7);
  assert.deepEqual(strobe.myTags, ['peak']); // not in rekordbox.xml: untouched
  assert.equal(strobe.analyzed, true);
  assert.equal(strobe.cues.length, 4);
  assert.equal(strobe.beatgrid.bpm, 128);
  assert.equal(lib.all().find((t) => t.title === 'Lonely').missing, true);
  const folder = lib.playlists.find((n) => n.importSource === 'rekordbox');
  assert.equal(folder.name, 'Imported');
  const friday = folder.children[0].children[0];
  assert.equal(friday.name, 'Friday');
  assert.deepEqual(friday.trackIds.map((id) => lib.get(id).title), ['Café', 'Strobe']);
  assert.equal(lib.playlists[0].name, 'My own');
  // Second import: same folder, no duplicate tracks or folders.
  const r2 = lib.importRekordbox(parsed, {});
  assert.deepEqual([r2.added, r2.updated], [0, 3]);
  assert.equal(lib.playlists.filter((n) => n.importSource === 'rekordbox').length, 1);
  assert.equal(lib.all().length, 3);
});

test('library import: only selected playlists, keep my edits, relocated files', () => {
  const lib = makeLibrary([{ id: 'c', path: 'E:\\DJ\\Music\\House\\Cafe.flac', title: 'Café (my edit)', comments: '', cues: [] }]);
  const parsed = importRekordboxXml(XML);
  const relocated = new Map([['d:\\music\\house\\cafe.flac', 'E:\\DJ\\Music\\House\\Cafe.flac']]);
  const r = lib.importRekordbox(parsed, {
    selected: new Set(['0/0']), scope: 'playlists', metadata: 'fill', placement: 'new', relocated, rules: inferRules([...relocated].map(([, v]) => ['D:\\Music\\House\\Cafe.flac', v])),
  });
  assert.deepEqual([r.added, r.updated, r.relocated, r.playlists], [1, 1, 2, 1]);
  assert.equal(lib.get('c').title, 'Café (my edit)');
  assert.equal(lib.get('c').artist, 'X');
  assert.ok(lib.all().some((t) => t.path === 'E:\\DJ\\Music\\Strobe.mp3'));
  assert.equal(lib.all().some((t) => t.title === 'Lonely'), false);
  assert.match(lib.playlists[0].name, /^Imported \d{4}-\d{2}-\d{2}$/);
});
