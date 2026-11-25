// Guess a video's VR layout from common filename tags and its aspect ratio.
// projection: 'flat' | 'equi360' | 'equi180' | 'fisheye180'
// stereo:     'mono' | 'sbs' | 'tb'

// meta (optional) comes from the file's own VR metadata via FFmpeg: { spherical, stereo }.
// Without tags or metadata a video is treated as a normal flat video — aspect ratio alone is not
// trusted, because many ordinary films are 2:1 or square.
export function detectFormat(name = '', w = 0, h = 0, meta = null) {
  const tokens = name.toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...t) => t.some((x) => tokens.includes(x));
  const joined = tokens.join(' ');

  let projection = null;
  let stereo = null;

  if (has('fisheye', 'fe', 'fisheye180', 'mkx200', 'mkx220', 'rf52')) projection = 'fisheye180';
  else if (has('180', 'vr180', '180x180', 'equi180')) projection = 'equi180';
  else if (has('360', 'vr360', '360x180', 'equi360', 'equirect', 'equirectangular', 'mono360')) projection = 'equi360';
  else if (has('2d', 'flat')) projection = 'flat';

  if (has('sbs', 'lr', '3dh', 'hsbs', 'fsbs', 'rl') || /side by side/.test(joined)) stereo = 'sbs';
  else if (has('tb', 'ou', 'tab', '3dv', 'htb', 'hou', 'overunder', 'topbottom') || /over under|top bottom/.test(joined)) stereo = 'tb';
  else if (has('mono', '2d')) stereo = 'mono';

  const ar = w && h ? w / h : 0;
  if (meta && meta.spherical && !projection) projection = meta.spherical;
  if (meta && meta.stereo && !stereo) stereo = meta.stereo;
  if (!projection) projection = 'flat';
  if (!stereo) {
    if (projection === 'equi180' || projection === 'fisheye180') stereo = ar >= 1.9 ? 'sbs' : ar <= 1.1 && ar > 0 ? 'mono' : 'sbs';
    else stereo = 'mono';
  }
  return { projection, stereo, swap: has('rl') };
}

/** Effective display aspect of one eye for flat (non-VR) 3D videos; detects squeezed "half" SBS/TB. */
export function eyeAspect(w, h, stereo) {
  if (!w || !h) return 16 / 9;
  if (stereo === 'sbs') {
    const a = (w / 2) / h;
    return a < 1.2 ? w / h : a;    // half-SBS stores each eye squeezed
  }
  if (stereo === 'tb') {
    const a = w / (h / 2);
    return a > 2.5 ? w / h : a;    // half-TB
  }
  return w / h;
}
