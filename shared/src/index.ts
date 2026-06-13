// Shared core exports for vscode extension and web app
export { initDuckDB, duckdb, type DuckHandles } from './duck';
export {
  ICON_PATHS,
  type IconName,
  type IconDef,
  UI_ICON_SIZE,
  PICKER_ICON_SIZE,
  SCHEMA_ICON_SIZE,
  CONTROL_ICON_SIZE,
  VISUAL_TYPE_ICONS,
  BUCKET_ICONS,
  HEADER_ICONS,
  SCHEMA_ICONS,
  CONTROL_ICONS,
  MENU_ICONS,
  EXPLORER_ICONS,
  BRAND_ICONS,
} from './icons';
export { app, mountWorkspace } from './workspace';
export { startStandaloneApp, autoStartStandaloneApp } from './standalone';
