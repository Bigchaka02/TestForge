/** Lower-cases text and joins its runs of ASCII letters and digits with single dashes. */
export function slugify(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}
