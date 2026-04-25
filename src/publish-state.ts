export type PublishSyncStatus = "unpublished" | "synced" | "changed" | "failed";

export interface PublishStateRecord {
  sourcePath: string;
  slug: string;
  targetMarkdownRelativePath: string;
  targetAssetDirRelativePath: string;
  contentHash: string;
  lastAttemptedAt: string;
  lastPublishedAt?: string;
  lastResult: "success" | "failure";
  lastError?: string;
}

export interface PublishStateStore {
  recordsBySourcePath: Record<string, PublishStateRecord>;
}

export const EMPTY_PUBLISH_STATE: PublishStateStore = {
  recordsBySourcePath: {}
};

export function normalizePublishState(
  input: Partial<PublishStateStore> | null | undefined
): PublishStateStore {
  const rawRecords = input?.recordsBySourcePath ?? {};
  const recordsBySourcePath = Object.fromEntries(
    Object.entries(rawRecords)
      .filter(([sourcePath, value]) => Boolean(sourcePath.trim()) && Boolean(value))
      .map(([sourcePath, value]) => {
        const record = value as Partial<PublishStateRecord>;
        return [
          sourcePath,
          {
            sourcePath,
            slug: String(record.slug ?? "").trim(),
            targetMarkdownRelativePath: String(
              record.targetMarkdownRelativePath ?? ""
            ).trim(),
            targetAssetDirRelativePath: String(
              record.targetAssetDirRelativePath ?? ""
            ).trim(),
            contentHash: String(record.contentHash ?? "").trim(),
            lastAttemptedAt: String(record.lastAttemptedAt ?? "").trim(),
            lastPublishedAt: record.lastPublishedAt
              ? String(record.lastPublishedAt).trim()
              : undefined,
            lastResult: record.lastResult === "failure" ? "failure" : "success",
            lastError: record.lastError ? String(record.lastError).trim() : undefined
          } satisfies PublishStateRecord
        ];
      })
  );

  return {
    recordsBySourcePath
  };
}

export function getPublishStateRecord(
  state: PublishStateStore,
  sourcePath: string
): PublishStateRecord | null {
  return state.recordsBySourcePath[sourcePath] ?? null;
}

export function setPublishStateRecord(
  state: PublishStateStore,
  record: PublishStateRecord
): PublishStateStore {
  return {
    recordsBySourcePath: {
      ...state.recordsBySourcePath,
      [record.sourcePath]: record
    }
  };
}
