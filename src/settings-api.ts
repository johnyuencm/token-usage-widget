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
  /** Local absolute config path. Only included for loopback callers (see options). */
  configPath?: string;
}

export async function getPublicSettings(
  options: { includeConfigPath?: boolean } = {},
): Promise<PublicSettingsResponse> {
  const cfg = await loadConfig();
  const body: PublicSettingsResponse = {
    ui: cfg.ui,
    providers: cfg.providers,
  };
  // The absolute path leaks the local username/home layout; keep it on loopback.
  if (options.includeConfigPath !== false) body.configPath = configPath();
  return body;
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
