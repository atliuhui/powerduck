# Development

Notes for contributors and maintainers of **PowerDuck**. See
[README.md](README.md) for the end-user overview.

## Prerequisites

- Node.js 20+ and npm.
- VS Code 1.95 or newer (the extension's `engines.vscode`).

## Monorepo Structure

- `vscode/`: VS Code extension package (`powerduck-vscode`)
- `webapp/`: standalone web package (`powerduck-webapp`)
- `chrome/`: Chrome MV3 extension package (`powerduck-chrome`)
- `shared/`: shared runtime and UI modules (`@powerduck/shared`)

`webapp` and `chrome` are independent branches that both depend on
`shared` directly.

## Root Scripts

```bash
npm install
npm run typecheck          # Typecheck shared + vscode + webapp
npm run build              # Build shared + vscode + webapp + chrome
npm run package            # Build and package all distributables
npm run gen:icons          # Render PNG icons from assets/icon.svg
npm run sync:tagline       # Sync tagline from root package.json#description
npm run check:tagline      # Check tagline drift (non-zero on mismatch)
npm run sync:meta          # Copy LICENSE/README into vscode/ package
```

## Package Scripts

- `vscode`:
        - `npm run -w vscode build`
        - `npm run -w vscode watch:extension`
        - `npm run -w vscode watch:webview`
        - `npm run -w vscode package`
- `webapp`:
        - `npm run -w powerduck-webapp dev`
        - `npm run -w powerduck-webapp build`
        - `npm run -w powerduck-webapp package`
- `chrome`:
        - `npm run -w powerduck-chrome dev`
        - `npm run -w powerduck-chrome build`
        - `npm run -w powerduck-chrome package`

## VS Code Extension Debugging

1. Run watchers in one or two terminals:
         - `npm run -w vscode watch:extension`
         - `npm run -w vscode watch:webview`
2. Press **F5** in VS Code to launch Extension Development Host.
3. Right-click a supported data file in the new window and run
         **Open in Data Visualizer (PowerDuck)**.

## Packaging Outputs

`npm run package` generates:

- `vscode/powerduck-vscode-<version>.vsix`
- `webapp/power-duck-webapp-<version>.zip`
- `chrome/power-duck-chrome-<version>.zip`

## Tooling

| Tool | Version | Docs |
| --- | --- | --- |
| `@duckdb/duckdb-wasm` | 1.32.0 | [SQL reference](https://duckdb.org/docs/stable/sql/introduction) · [Functions](https://duckdb.org/docs/stable/sql/functions/overview) · [DuckDB-Wasm guide](https://duckdb.org/docs/stable/clients/wasm/overview) |
| `echarts` | 6.1.0 | [Option reference](https://echarts.apache.org/en/option.html) |
| `@fluentui/react-icons` | SVG path data is inlined into `shared/src/icons.ts` (no runtime dependency) | [Icon catalog](https://react.fluentui.dev/?path=/docs/icons-catalog--docs) |
| `@typescript/native-preview` (`tsgo`) | 7.0.0-dev.20260421.2 | [Repo](https://github.com/microsoft/typescript-go) |
| `vite` | 8.0.16 | [Guide](https://vite.dev/guide/) |

## Layout

```
assets/icon.svg                         # Single source icon
scripts/build-icon.mjs                  # SVG -> png rendering for vscode/chrome
shared/src/workspace.ts                 # Core workspace app logic
shared/src/standalone.ts                # Standalone app entry (webapp/chrome)
vscode/src/extension/extension.ts       # Extension host, file streaming
vscode/src/webview/main.ts              # Webview bridge to shared app
webapp/src/main.ts                      # Thin entry -> shared standalone app
chrome/src/main.ts                      # Thin entry -> shared standalone app
chrome/src/background.js                # Browser action behavior
```

## Data flow

```
explorer/context → command 'powerduck.open' (uri)
        ↓
vscode/src/extension/extension.ts: createWebviewPanel + html
        ↓                      ↑ postMessage
vscode/src/webview/main.ts ← bytes (Uint8Array, streamed in chunks)
        ↓
shared app (`app.loadBytes`) → DuckDB-WASM
                                                                                                                 → CREATE VIEW ... AS read_*()
```

## SELECT alias encoding

Each column emitted by the generated visual SQL is aliased with a
reversible code so that hand-edited custom SQL can round-trip back into
the bucket configuration (Axis / Legend / Values / Columns / Filters) when
the user clicks **Apply**. See `encodeFieldAlias` / `decodeFieldAlias` in
[shared/src/workspace.ts](shared/src/workspace.ts).

Two formats are accepted. The **short** form is what `encodeFieldAlias`
emits by default; the **long** form is recognised by the decoder so you
can hand-write more readable aliases in custom SQL.

```
short:  {b}{rrr}_{encodedCol}_{n}        e.g. agrp_Category_1
long:   {bucket}_{role}_{encodedCol}_{n} e.g. axis_group_Category_1
```

| Part | Meaning |
| --- | --- |
| `bucket` / `b` | Long bucket name / its single-letter code |
| `role` / `rrr` | Long role name / its 3-letter code |
| `encodedCol` | `encodeURIComponent(col)` (`_` is left as-is — see note below) |
| `n` | 1-based ordinal within the bucket, **always emitted** so the trailing `_\d+` is unambiguous |

`_` inside the column name does **not** need to be escaped: both decoder
regexes anchor the trailing `_\d+` to end-of-string with a greedy `.+`
in front, so the **last** `_n` is always the ordinal. For example
`vcdt_user_id_1` decodes unambiguously to col=`user_id`, seq=1.

### Bucket codes

| Long | Short | Bucket |
| --- | --- | --- |
| `axis` | `a` | Axis |
| `legend` | `l` | Legend |
| `values` | `v` | Values |
| `columns` | `c` | Columns |
| _(none)_ | _(none)_ | Filters – predicates live in `WHERE`, not in `SELECT`, so no alias is emitted |

### Role / aggregation codes

| Long | Short | Agg | Notes |
| --- | --- | --- | --- |
| `group` | `grp` | Group | Plain dimension grouping (default for Axis / Legend / Columns) |
| `sum` | `sum` | Sum | Default for Values |
| `avg` | `avg` | Avg | |
| `min` | `min` | Min | |
| `max` | `max` | Max | |
| `count` | `cnt` | Count | |
| `countdistinct` | `cdt` | CountDistinct | |
| `year` | `yer` | Year | Date bin: `STRFTIME(col, '%Y')` |
| `yearmonth` | `ymo` | YearMonth | Date bin: `STRFTIME(col, '%Y-%m')` |
| `date` | `dat` | Date | Date bin: `STRFTIME(col, '%Y-%m-%d')` |

### Examples

| Bucket / Agg / Column | Short (emitted) | Long (also accepted) |
| --- | --- | --- |
| Axis · Group · `Category` (1st) | `agrp_Category_1` | `axis_group_Category_1` |
| Legend · YearMonth · `OrderDate` (1st) | `lymo_OrderDate_1` | `legend_yearmonth_OrderDate_1` |
| Values · Sum · `Amount` (1st) | `vsum_Amount_1` | `values_sum_Amount_1` |
| Values · Sum · `Amount` (2nd) | `vsum_Amount_2` | `values_sum_Amount_2` |
| Values · CountDistinct · `user_id` (1st) | `vcdt_user_id_1` | `values_countdistinct_user_id_1` |
| Columns · Date · `CreatedAt` (1st) | `cdat_CreatedAt_1` | `columns_date_CreatedAt_1` |
