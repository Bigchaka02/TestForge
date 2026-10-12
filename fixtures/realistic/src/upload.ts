import { basename, extname } from 'node:path';
import { slugify } from 'tiny-slug';

/**
 * Safe upload name: the slug of the base name plus the lower-case extension.
 * A name without an extension gets ".bin".
 * A slug longer than 12 characters is cut to its first 11 characters and "~".
 * Throws TypeError when the base name has no letters or digits.
 */
export function uploadName(file: string): string {
  const ext = extname(file).toLowerCase();
  const slug = slugify(basename(file, extname(file)));
  if (slug === '') throw new TypeError('file name has no letters or digits');
  const short = slug.length > 12 ? slug.slice(0, 11) + '~' : slug;
  return short + (ext === '' ? '.bin' : ext);
}
