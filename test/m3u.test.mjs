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
