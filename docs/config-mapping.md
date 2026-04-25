# Publish to Site 配置与映射说明

这份文档解释插件里的关键配置，以及如何用 JSON 快速导入导出。

## 最小可用配置

第一次使用时，建议先只配置这些字段：

```json
{
  "astroSiteRoot": "/Users/name/projects/my-astro-site",
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

然后在 Obsidian 笔记里使用：

```yaml
---
title: My Post
status: published
slug: my-post
date: 2026-04-25
categories: Posts
tags:
  - obsidian
  - astro
---
```

## 字段说明

`astroSiteRoot`

本地 Astro 站点项目的绝对路径。插件发布前会检查这里是否存在 `astro.config.*`。

`sourceFolders`

扫描哪些 Vault 内目录。路径相对于 Vault 根目录。建议至少填一个目录，避免扫描整个 Vault。

示例：

```json
["posts", "articles"]
```

`propertyFilters`

额外 frontmatter 筛选条件。多条规则需要全部满足。不确定时留空。

示例：

```json
[
  { "key": "type", "value": "article" }
]
```

`tagFilters`

标签筛选。多条规则命中任意一个即可。不确定时留空。

示例：

```json
["blog", "public"]
```

`publishStatusField` 和 `publishStatusValue`

决定哪些笔记可以发布。默认是 `status = published`。

支持字符串：

```yaml
status: published
```

也支持列表：

```yaml
status:
  - published
```

`categoryField`

读取栏目值的 frontmatter 字段名。默认是 `categories`。

`categoryMappings`

把 Obsidian 里的栏目值转换成 Astro 站点期望的栏目值。

例如 Obsidian 里写：

```yaml
categories: Projects
```

配置：

```json
[
  { "source": "Projects", "target": "project" }
]
```

发布到 Astro 后会输出：

```yaml
categories: "project"
```

如果你在 Obsidian 里用 wiki link 作为分类，也可以这样配：

```json
[
  { "source": "[[Projects]]", "target": "project" },
  { "source": "[[Posts]]", "target": "post" }
]
```

`postOutputDir`

生成的 Markdown 文章目录，路径相对于 Astro 站点根目录。

推荐：

```json
"src/data/blog/_obsidian"
```

`assetOutputDir`

图片等资源目录，路径相对于 Astro 站点根目录。建议放在 `public/` 下。

推荐：

```json
"public/uploads/obsidian"
```

`syncMode`

当前版本固定使用：

```json
"upsert-only"
```

含义是只覆盖当前发布命中的文章和资源目录，不删除其他站点文件。

## 内置 frontmatter 映射

当前版本只开放关键配置，不做任意字段映射器。

内置映射如下：

| Obsidian 字段 | Astro 输出字段 |
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

如果缺少 `slug`，插件会根据标题或文件名生成 slug。

## 导入导出建议

- 导出的 JSON 只包含配置，不包含发布历史。
- 导入 JSON 会覆盖当前设置。
- 导入后先扫描，不要直接发布。
- 如果多人共用配置，建议保留 `astroSiteRoot` 为空，让每个人填写自己的本地路径。

