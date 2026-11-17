// Android's Share menu puts the link in `text` (its share system has no url field), often
// with words around it ("Check out this reel! https://..."), and sometimes in `title` or
// `url`. Returns the first http(s) link found, or '' when there is none. The backend checks
// the link itself; this only picks it out of the shared text.
export function findSharedLink({ title, text, url }) {
  for (const value of [url, text, title]) {
    const match = /https?:\/\/[^\s<>"]+/i.exec(value ?? '');
    if (match) return match[0].replace(/[.,!?)\]]+$/, '');
  }
  return '';
}
