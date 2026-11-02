// 专辑分组键：有「专辑歌手」标签时按专辑歌手 + 专辑名；没有时按所在目录 + 专辑名，
// 这样合辑里每首歌手不同也能归成一张（与渲染进程 store.js 里的 albumKey 规则一致）
export function albumKeyOf(t) {
  if (t.tagAlbumArtist === false) return `${t.path.slice(0, Math.max(t.path.lastIndexOf('\\'), t.path.lastIndexOf('/')))}\u0001${t.album}`;
  return `${t.albumArtist}\u0001${t.album}`;
}
