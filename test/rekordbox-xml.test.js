import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRekordboxXml, exportRekordboxXml, locationToPath, pathToLocation } from '../src/shared/rekordbox-xml.js';
import { parseXml } from '../src/shared/xml.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.2.18" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="11" Name="Strobe" Artist="deadmau5" Composer="" Album="For Lack of a Better Name" Grouping=""
      Genre="Progressive House" Kind="MP3 File" Size="25000000" TotalTime="637" DiscNumber="0" TrackNumber="5"
      Year="2009" AverageBpm="128.00" DateAdded="2024-01-02" BitRate="320" SampleRate="44100" Comments="Big &amp; long"
      PlayCount="3" Rating="204" Location="file://localhost/C:/Music/deadmau5%20-%20Strobe.mp3" Remixer="" Tonality="Am"
      Label="mau5trap" Mix="Original" Colour="0x0000FF">
      <TEMPO Inizio="0.025" Bpm="128.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="60.025" Num="0" Red="40" Green="226" Blue="20"/>
      <POSITION_MARK Name="" Type="0" Start="0.025" Num="-1"/>
      <POSITION_MARK Name="Loop" Type="4" Start="120.0" End="127.5" Num="1" Red="255" Green="0" Blue="0"/>
    </TRACK>
    <TRACK TrackID="12" Name="Café" Artist="X" Location="file://localhost/Users/me/Music/Caf%C3%A9.flac" Tonality="8A" Rating="0"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Type="0" Name="Sets" Count="1">
        <NODE Name="Friday" Type="1" KeyType="0" Entries="2"><TRACK Key="12"/><TRACK Key="11"/></NODE>
      </NODE>
      <NODE Name="ByPath" Type="1" KeyType="1" Entries="1"><TRACK Key="file://localhost/C:/Music/deadmau5%20-%20Strobe.mp3"/></NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

test('location <-> path', () => {
  assert.equal(locationToPath('file://localhost/C:/Music/a%20b.mp3'), 'C:\\Music\\a b.mp3');
  assert.equal(locationToPath('file://localhost/Users/me/Caf%C3%A9.flac'), '/Users/me/Café.flac');
  assert.equal(pathToLocation('C:\\Music\\a b#1.mp3'), 'file://localhost/C:/Music/a%20b%231.mp3');
  assert.equal(locationToPath(pathToLocation('C:\\Music\\é & ü?.mp3')), 'C:\\Music\\é & ü?.mp3');
});

test('imports tracks, beatgrid, cues and playlists', () => {
  const { tracks, playlists, product } = importRekordboxXml(SAMPLE);
  assert.equal(product, 'rekordbox');
  assert.equal(tracks.length, 2);
  const [t] = tracks;
  assert.equal(t.path, 'C:\\Music\\deadmau5 - Strobe.mp3');
  assert.equal(t.comments, 'Big & long');
  assert.equal(t.rating, 4);
  assert.equal(t.key, '8A');
  assert.equal(t.color, 'Blue');
  assert.deepEqual(t.beatgrid, { bpm: 128, firstBeat: 0.025, beat: 1 });
  assert.deepEqual(t.cues.map((c) => [c.kind, c.slot, c.start, c.end]), [
    ['hot', 0, 60.025, undefined], ['memory', undefined, 0.025, undefined], ['hot', 1, 120, 127.5],
  ]);
  assert.equal(t.cues[0].color, '#28e214');
  assert.equal(tracks[1].path, '/Users/me/Music/Café.flac');
  assert.equal(tracks[1].key, '8A');
  assert.deepEqual(playlists, [
    { type: 'folder', name: 'Sets', children: [{ type: 'playlist', name: 'Friday', paths: ['/Users/me/Music/Café.flac', 'C:\\Music\\deadmau5 - Strobe.mp3'] }] },
    { type: 'playlist', name: 'ByPath', paths: ['C:\\Music\\deadmau5 - Strobe.mp3'] },
  ]);
});

test('export round-trips through import', () => {
  const { tracks } = importRekordboxXml(SAMPLE);
  const lib = {
    tracks: tracks.map((t, i) => ({ ...t, id: `t${i}` })),
    playlists: [{ type: 'folder', name: 'Sets', children: [{ type: 'playlist', name: 'Friday', trackIds: ['t1', 't0'] }] }],
  };
  const xml = exportRekordboxXml(lib);
  assert.equal(parseXml(xml).name, 'DJ_PLAYLISTS');
  const again = importRekordboxXml(xml);
  assert.equal(again.product, 'Reboxed');
  for (const field of ['path', 'title', 'artist', 'rating', 'key', 'color', 'comments', 'bpm', 'year']) {
    assert.deepEqual(again.tracks.map((t) => t[field]), tracks.map((t) => t[field]), field);
  }
  assert.deepEqual(again.tracks[0].beatgrid, tracks[0].beatgrid);
  assert.deepEqual(again.tracks[0].cues, tracks[0].cues);
  assert.deepEqual(again.playlists[0].children[0].paths, [tracks[1].path, tracks[0].path]);
});

test('dynamic grids round-trip as multiple TEMPO markers', () => {
  const beats = [];
  for (let t = 0.1; t < 10; t += 0.5) beats.push(Math.round(t * 1000) / 1000);        // 120 BPM
  for (let t = beats.at(-1) + 0.4; t < 20; t += 0.4) beats.push(Math.round(t * 1000) / 1000); // 150 BPM
  const lib = { tracks: [{ id: 'd', title: 'Dyn', path: 'C:\\m\\d.mp3', duration: 20, beatgrid: { bpm: 135, firstBeat: 0.1, beat: 2, beats } }], playlists: [] };
  const xml = exportRekordboxXml(lib);
  assert.equal((xml.match(/<TEMPO /g) ?? []).length, 2);
  assert.match(xml, /Battito="2"/);
  const [t] = importRekordboxXml(xml).tracks;
  assert.ok(t.beatgrid.beats.length >= beats.length - 1);
  for (let i = 0; i < beats.length - 1; i++) assert.ok(Math.abs(t.beatgrid.beats[i] - beats[i]) < 0.003, `beat ${i}`);
  assert.equal(t.beatgrid.beat, 2);
});

test('rejects non-rekordbox XML', () => {
  assert.throws(() => importRekordboxXml('<foo/>'), /DJ_PLAYLISTS/);
});
