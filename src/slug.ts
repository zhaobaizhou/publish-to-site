import { pinyin } from "pinyin-pro";

export type SlugSource = "frontmatter" | "title-pinyin" | "filename";

export interface SlugResolution {
  slug: string;
  source: SlugSource;
}

interface ResolveNoteSlugOptions {
  explicitSlug?: string | null;
  title?: string | null;
  fileBasename: string;
}

export function resolveNoteSlug({
  explicitSlug,
  title,
  fileBasename
}: ResolveNoteSlugOptions): SlugResolution {
  const manualSlug = normalizeSlug(explicitSlug?.trim() ?? "");
  if (manualSlug) {
    return {
      slug: manualSlug,
      source: "frontmatter"
    };
  }

  const normalizedTitle = normalizeSlug(transliterateToPinyin(title?.trim() ?? ""));
  if (normalizedTitle) {
    return {
      slug: normalizedTitle,
      source: "title-pinyin"
    };
  }

  return {
    slug: normalizeSlug(transliterateToPinyin(fileBasename)),
    source: "filename"
  };
}

function transliterateToPinyin(value: string): string {
  const parts = pinyin(value, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
    v: true
  });

  return parts.join(" ");
}

function normalizeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]/g, " ")
    .replace(/[\s_]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
