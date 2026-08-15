import { loadConfig, configPath, type Config } from "./config.js";
import { loadExisting, writeConfig } from "./cli/provider-config.js";
import {
  applyUiPatch,
  mergeUiSettings,
  parseUiPatch,
  type UiSettings,
} from "./ui-settings.js";
import { resetPollCache } from "./providers/poll-cache.js";

export interface PublicSettingsResponse {
  ui: UiSettings;
  providers: Config["providers"];
  configPath: string;
}

export async function getPublicSettings(): Promise<PublicSettingsResponse> {
  const cfg = await loadConfig();
  return {
    ui: cfg.ui,
    providers: cfg.providers,
    configPath: configPath(),
  };
}

export async function saveUiSettingsPatch(body: unknown): Promise<UiSettings> {
  const existing = loadExisting();
  const current = mergeUiSettings(existing.ui);
  const patch = parseUiPatch(body);
  const next = applyUiPatch(current, patch);
  writeConfig({ ...existing, ui: next });
  resetPollCache();
  return next;
}
