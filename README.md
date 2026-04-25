# Publish to Site

Publish selected Markdown notes to a local Astro site.

Publish to Site is an Obsidian plugin for writers who draft in Obsidian and publish to a static blog. It scans Markdown notes by frontmatter rules, shows what is ready or blocked, converts publishable notes, syncs local images, and writes the output into an Astro project.

## Features

- Scan Markdown notes by folder, frontmatter properties, tags, and publish status.
- Publish one active note or all publishable notes.
- Convert Obsidian notes into Astro-compatible Markdown.
- Preserve core frontmatter such as title, date, tags, categories, summary, description, and cover image.
- Copy local images into the Astro `public/` directory and rewrite image paths.
- Track publish state: unpublished, synced, changed, or failed.
- Show configuration errors, warnings, scan results, and publish progress in Obsidian.
- Warn about Obsidian-specific syntax that may not publish cleanly, such as `[[wiki links]]` and non-image embeds.
- Import and export plugin settings as JSON.

## Current Scope

This first version focuses on a safe local publishing workflow:

- Target site: Astro.
- Publish mode: write files into a local Astro project.
- Sync mode: `upsert-only`.
- Output: generated Markdown plus copied local image assets.

Not included yet:

- Hosted CMS or deployment API publishing.
- Full-site cleanup or mirror sync.
- Visual diff before publishing.
- Automatic rewrite of all Obsidian wiki links.
- Expansion of note embeds such as `![[note]]` or `![[note#heading]]`.
- A fully configurable frontmatter mapping engine.

## How It Works

1. Write in Obsidian.
2. Mark notes for publishing with frontmatter, for example `status: published`.
3. Open the plugin settings and configure the target Astro project.
4. Scan notes to review publishable, blocked, and out-of-scope files.
5. Publish the active note or all publishable notes.
6. Preview, build, and deploy your Astro site as usual.

## Example Note

```yaml
---
title: My Post
status: published
slug: my-post
date: 2026-04-25
categories: Projects
tags:
  - obsidian
  - astro
description: A short summary for SEO and link previews.
summary: A longer summary for readers.
---
```

With a category mapping like `Projects -> project`, the generated Astro frontmatter will use:

```yaml
categories: "project"
```

## Recommended Settings

The default configuration is intentionally conservative:

```json
{
  "astroSiteRoot": "",
  "sourceFolders": ["posts"],
  "propertyFilters": [],
  "tagFilters": [],
  "categoryField": "categories",
  "categoryMappings": [
    { "source": "Posts", "target": "post" },
    { "source": "Notes", "target": "note" },
    { "source": "Projects", "target": "project" },
    { "source": "BookNotes", "target": "booknote" },
    { "source": "Clippings", "target": "clipping" }
  ],
  "publishStatusField": "status",
  "publishStatusValue": "published",
  "postOutputDir": "src/data/blog/_obsidian",
  "assetOutputDir": "public/uploads/obsidian",
  "syncMode": "upsert-only"
}
```

See [docs/config-mapping.md](docs/config-mapping.md) for the full configuration guide.

## Frontmatter Mapping

The plugin keeps the first version simple by using a small set of built-in mappings:

| Obsidian field | Astro output field |
| --- | --- |
| `title` | `title` |
| `date` | `pubDatetime` |
| `updated` | `modDatetime` |
| `description` | `description` |
| `summary` | `summary` |
| `tags` | `tags` |
| `categories` | `categories` |
| `cover` | `ogImage` |
| `canonical` | `canonicalURL` |

If `slug` is missing, the plugin generates one from the title or filename.

## Obsidian Syntax Support

Supported in V1:

- `![[image.png]]` is copied and converted to standard Markdown image syntax.
- `![alt](local-image.png)` is copied and rewritten when the target is a local image.
- A leading H1 matching the note title is removed to avoid duplicate page titles.

Warned but not transformed:

- `[[note]]`
- `[[note|alias]]`
- `![[note]]`
- `![[note#heading]]`
- `![[note#^block]]`

For public posts, prefer writing the required context directly in the note or using standard Markdown links.

## Installation

### Manual Install

1. Download the release files:
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. Create this folder in your Vault:

```text
<your-vault>/.obsidian/plugins/publish-to-site/
```

3. Copy the three files into that folder.
4. Restart Obsidian or reload plugins.
5. Enable `Publish to Site` in `Settings -> Community plugins`.

### Local Build

```bash
npm install
npm run build
```

Then copy `manifest.json`, `main.js`, and `styles.css` into:

```text
<your-vault>/.obsidian/plugins/publish-to-site/
```

## Development

```bash
npm install
npm run check
npm run build
npm run dev
```

Project structure:

```text
src/main.ts          Plugin entry and settings UI
src/scanner.ts       Vault scan and publishability checks
src/transform.ts     Markdown/frontmatter/image transformation
src/publisher.ts     File writing and publish state application
src/settings.ts      Settings model and defaults
docs/                Configuration docs
```

## Release Checklist

Before creating a GitHub release:

- `npm run check` passes.
- `npm run build` passes.
- `manifest.json`, `versions.json`, and `package.json` use the same version.
- `main.js`, `manifest.json`, and `styles.css` are attached to the GitHub release.
- The release tag matches the manifest version, for example `0.1.0`.
- The plugin works in a real Obsidian Vault.

## Roadmap

Planned improvements after V1:

- Rewrite `[[note]]` into internal site links when the target note is also published.
- Support alias links like `[[note|label]]`.
- Support heading anchors like `[[note#heading]]`.
- Add optional rendering for embedded notes and headings.
- Add visual diff before publishing.
- Add safer cleanup modes for deleted or unpublished notes.

## Support

Open a GitHub issue with:

- Obsidian version.
- Plugin version.
- Astro version.
- A minimal example note.
- Your plugin settings JSON with private paths removed.
- The exact error message or scan warning.

## License

MIT. See [LICENSE](LICENSE).
