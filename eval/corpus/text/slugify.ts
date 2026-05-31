// Convert arbitrary strings to URL-safe slugs.

export function slugify(text: string, separator = "-"): string {
  return text
    .normalize("NFKD")                       // decompose accented chars
    .replace(/[̀-ͯ]/g, "")         // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)       // non-alphanum → separator
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), ""); // trim
}

export function deSlugify(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function uniqueSlug(base: string, existing: Set<string>): string {
  const slug = slugify(base);
  if (!existing.has(slug)) return slug;
  let n = 2;
  while (existing.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}
