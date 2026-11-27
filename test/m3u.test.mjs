import assert from 'node:assert/strict';
import { parseM3U, isHlsPlaylist, groupsOf, looksLikeM3U, isStreamUrl } from '../src/m3u.js';

const iptv = `#EXTM3U x-tvg-url="http://epg.example/guide.xml"
#EXTINF:-1 tvg-id="news1" tvg-name="News One" tvg-logo="http://logo/n1.png" group-title="News",News One HD
http://iptv.example/live/news1.m3u8
#EXTINF:-1 tvg-logo="x.png" group-title="Sports, Live",Match, Day 1
#EXTVLCOPT:http-user-agent=Foo
rtsp://cam.local/stream1
#EXTINF:120,Local clip
clips/clip%201.mp4
#EXTGRP:Music
#EXTINF:-1,Radio
https://radio.example/stream
http://plain.example/no-extinf.ts
`;
const items = parseM3U(iptv, 'http://lists.example/my/list.m3u');
assert.equal(items.length, 5);
assert.deepEqual(items[0], { name: 'News One HD', group: 'News', logo: 'http://logo/n1.png', duration: 0, url: 'http://iptv.example/live/news1.m3u8' });
assert.equal(items[1].name, 'Match, Day 1');
assert.equal(items[1].group, 'Sports, Live');
assert.equal(items[1].url, 'rtsp://cam.local/stream1');
assert.equal(items[2].url, 'http://lists.example/my/clips/clip%201.mp4');
assert.equal(items[2].duration, 120);
assert.equal(items[3].group, 'Music');
assert.equal(items[4].name, 'no-extinf.ts');
assert.deepEqual(groupsOf(items).map((g) => g.name), ['News', 'Sports, Live', '', 'Music']);

// relative entries in a local file stay relative (the app resolves them against the file's folder)
assert.equal(parseM3U('#EXTM3U\n#EXTINF:-1,A\nvideos/a.mkv\n')[0].url, 'videos/a.mkv');

const hls = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:12
#EXTINF:2.000,
index12.ts`;
assert.equal(isHlsPlaylist(hls), true);
assert.equal(isHlsPlaylist(iptv), false);
assert.equal(isHlsPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8'), true);
assert.ok(looksLikeM3U('list.m3u') && looksLikeM3U('http://x/a.m3u8?token=1') && !looksLikeM3U('a.mp4'));
assert.ok(isStreamUrl('https://x') && isStreamUrl('rtsp://cam') && !isStreamUrl('/media/a.mp4'));
console.log('m3u: all checks passed');

// ---- other playlist formats
import { parsePlaylist, looksLikeList, isDashUrl } from '../src/m3u.js';
const pls = `[playlist]
NumberOfEntries=2
File1=http://radio.example:8000/stream
Title1=Jazz Radio
File2=relative/b.mp3
Version=2`;
let r = parsePlaylist(pls, 'http://lists.example/x/list.pls');
assert.deepEqual(r.map((x) => [x.name, x.url]), [['Jazz Radio', 'http://radio.example:8000/stream'], ['b.mp3', 'http://lists.example/x/relative/b.mp3']]);
const xspf = `<?xml version="1.0" encoding="UTF-8"?>
<playlist xmlns="http://xspf.org/ns/0/" version="1"><trackList>
<track><location>https://tv.example/ch1.m3u8</location><title>Channel &amp; One</title></track>
<track><title>No location</title></track>
<track><location><![CDATA[rtsp://cam.local/live]]></location></track>
</trackList></playlist>`;
r = parsePlaylist(xspf);
assert.deepEqual(r.map((x) => [x.name, x.url]), [['Channel & One', 'https://tv.example/ch1.m3u8'], ['live', 'rtsp://cam.local/live']]);
const asx = `<ASX version="3.0"><Entry><Title>Old Station</Title><Ref href="mms://media.example/live" /></Entry>
<entry><ref href="http://media.example/b.wmv"/></entry></ASX>`;
r = parsePlaylist(asx);
assert.deepEqual(r.map((x) => [x.name, x.url]), [['Old Station', 'mms://media.example/live'], ['b.wmv', 'http://media.example/b.wmv']]);
assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:-1,A\nhttp://a/1.ts').length, 1);
assert.ok(looksLikeList('x.xspf') && looksLikeList('x.ASX') && looksLikeList('http://a/b.pls?x') && !looksLikeList('a.mpd'));
assert.ok(isDashUrl('https://a/manifest.mpd'));
assert.ok(isStreamUrl('rtmpt://a/b') && isStreamUrl('mms://a/b') && isStreamUrl('srt://1.2.3.4:9000') && !isStreamUrl('ftp://a'));
console.log('playlist formats: all checks passed');

import { directListUrl, isVideoSitePage } from '../src/m3u.js';
assert.equal(directListUrl('https://github.com/Free-TV/IPTV/blob/master/playlists/playlist_japan.m3u8'), 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/playlist_japan.m3u8');
assert.equal(directListUrl('https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'), 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8');
assert.equal(directListUrl('https://gitlab.com/a/b/-/blob/main/x.m3u'), 'https://gitlab.com/a/b/-/raw/main/x.m3u');
assert.ok(isVideoSitePage('https://www.youtube.com/@EuronewsAlbania/live') && !isVideoSitePage('https://x.example/live.m3u8'));
console.log('link helpers: all checks passed');

const withPlaceholders = parseM3U('#EXTM3U\n#EXTINF:-1,Real\nhttps://a/1.m3u8\n#EXTINF:-1,Gone\n[NO PUBLIC STREAM]\n#EXTINF:-1,Next\nhttps://a/2.m3u8\n', 'https://lists.example/x.m3u8');
assert.deepEqual(withPlaceholders.map((x) => x.name), ['Real', 'Next']);
console.log('placeholders: all checks passed');
