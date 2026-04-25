import { normalizePath, type Plugin } from "obsidian";
import path from "path";
import {
  EMPTY_PUBLISH_STATE,
  normalizePublishState,
  type PublishStateStore
} from "./publish-state";
import type { PublishToAstroSettings } from "./settings";

const PLUGIN_DATA_VERSION = 2;
const PLUGIN_DATA_BACKUP_FILE = "plugin-data-backup.json";
const LEGACY_SETTINGS_BACKUP_FILE = "settings-backup.json";

export interface PersistedPluginData {
  settings: Partial<PublishToAstroSettings> | null;
  publishState: PublishStateStore;
}

interface PersistedPluginLoadResult extends PersistedPluginData {
  recoveredFromBackup: boolean;
}

interface PersistedPluginFile {
  version: number;
  settings: Partial<PublishToAstroSettings>;
  publishState: PublishStateStore;
}

export async function loadPersistedPluginData(
  plugin: Plugin
): Promise<PersistedPluginLoadResult> {
  const primary = parsePersistedPluginData(await plugin.loadData());
  const backup = await loadBackupPluginData(plugin);

  if (primary) {
    return {
      settings: {
        ...(backup?.settings ?? {}),
        ...(primary.settings ?? {})
      },
      publishState: normalizePublishState(
        Object.keys(primary.publishState.recordsBySourcePath).length > 0
          ? primary.publishState
          : backup?.publishState
      ),
      recoveredFromBackup: false
    };
  }

  if (backup) {
    return {
      settings: backup.settings,
      publishState: backup.publishState,
      recoveredFromBackup: true
    };
  }

  return {
    settings: null,
    publishState: EMPTY_PUBLISH_STATE,
    recoveredFromBackup: false
  };
}

export async function savePersistedPluginData(
  plugin: Plugin,
  data: PersistedPluginData
): Promise<void> {
  const normalized = normalizePersistedPluginData(data);
  await plugin.saveData(normalized);
  await saveBackupPluginData(plugin, normalized);
}

function normalizePersistedPluginData(data: PersistedPluginData): PersistedPluginFile {
  return {
    version: PLUGIN_DATA_VERSION,
    settings: data.settings ?? {},
    publishState: normalizePublishState(data.publishState)
  };
}

function parsePersistedPluginData(raw: unknown): PersistedPluginData | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if ("settings" in record || "publishState" in record || "version" in record) {
    return {
      settings:
        record.settings && typeof record.settings === "object"
          ? (record.settings as Partial<PublishToAstroSettings>)
          : null,
      publishState: normalizePublishState(
        record.publishState as Partial<PublishStateStore> | null | undefined
      )
    };
  }

  return {
    settings: record as Partial<PublishToAstroSettings>,
    publishState: EMPTY_PUBLISH_STATE
  };
}

async function loadBackupPluginData(
  plugin: Plugin
): Promise<PersistedPluginData | null> {
  const currentBackup = await loadBackupFile(plugin, getCurrentBackupPath(plugin));
  if (currentBackup) {
    return currentBackup;
  }

  const legacySettings = await loadLegacySettingsBackup(plugin);
  if (!legacySettings) {
    return null;
  }

  return {
    settings: legacySettings,
    publishState: EMPTY_PUBLISH_STATE
  };
}

async function loadBackupFile(
  plugin: Plugin,
  filePath: string
): Promise<PersistedPluginData | null> {
  try {
    const exists = await plugin.app.vault.adapter.exists(filePath);
    if (!exists) {
      return null;
    }

    const raw = await plugin.app.vault.adapter.read(filePath);
    return parsePersistedPluginData(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadLegacySettingsBackup(
  plugin: Plugin
): Promise<Partial<PublishToAstroSettings> | null> {
  const legacyPath = getLegacySettingsBackupPath(plugin);

  try {
    const exists = await plugin.app.vault.adapter.exists(legacyPath);
    if (!exists) {
      return null;
    }

    const raw = await plugin.app.vault.adapter.read(legacyPath);
    return JSON.parse(raw) as Partial<PublishToAstroSettings>;
  } catch {
    return null;
  }
}

async function saveBackupPluginData(
  plugin: Plugin,
  data: PersistedPluginFile
): Promise<void> {
  const backupPath = getCurrentBackupPath(plugin);
  await ensureDirectory(plugin, path.posix.dirname(backupPath));
  await plugin.app.vault.adapter.write(
    backupPath,
    JSON.stringify(data, null, 2)
  );
}

async function ensureDirectory(plugin: Plugin, normalizedDir: string): Promise<void> {
  const adapter = plugin.app.vault.adapter;
  if (await adapter.exists(normalizedDir)) {
    return;
  }

  const parent = path.posix.dirname(normalizedDir);
  if (parent && parent !== "." && parent !== normalizedDir) {
    await ensureDirectory(plugin, parent);
  }

  if (!(await adapter.exists(normalizedDir))) {
    await adapter.mkdir(normalizedDir);
  }
}

function getCurrentBackupPath(plugin: Plugin): string {
  return normalizePath(
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}-${PLUGIN_DATA_BACKUP_FILE}`
  );
}

function getLegacySettingsBackupPath(plugin: Plugin): string {
  return normalizePath(
    `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}-${LEGACY_SETTINGS_BACKUP_FILE}`
  );
}
