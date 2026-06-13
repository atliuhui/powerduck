# PowerDuck

<!-- tagline:start -->
> Lightweight, Power BI–inspired data visualizer powered by **DuckDB-WASM** and **Apache ECharts**.
<!-- tagline:end -->

PowerDuck is a local-first data visualizer for VS Code.
Open data files from Explorer, build visuals with drag-and-drop fields,
and inspect or edit the SQL behind each chart.

## Features

- Open local `.parquet`, `.csv`, `.tsv`, `.json`, `.jsonl`, and `.ndjson`
  files directly from VS Code Explorer.
- Build visuals with drag-and-drop field wells (Axis, Legend, Values,
  Columns, Filters).
- Use multiple visual types: bar/column variants, line, area, scatter,
  pie, doughnut, table, KPI card.
 - Inspect and edit generated SQL, then re-run with `Ctrl+Enter`.
- Keep data local: all analysis runs in DuckDB-WASM inside the webview.

## Getting Started

1. Install the extension.
2. In VS Code Explorer, right-click a supported data file.
3. Choose **Open in Data Visualizer (PowerDuck)**.
4. After initialization, create visuals and optionally edit SQL.

## Supported Formats

| Extension | DuckDB reader |
| --- | --- |
| `.parquet` | `read_parquet` |
| `.csv`, `.tsv` | `read_csv_auto` |
| `.json`, `.jsonl`, `.ndjson` | `read_json_auto` |

## Privacy & Security

- Query execution is client-side in DuckDB-WASM.
- Local files are streamed from extension host to webview as `Uint8Array`
  chunks and are not uploaded by the extension.
- The webview uses a strict Content Security Policy.
- On first non-CSV use, DuckDB-WASM may fetch a signed format extension
  module from `https://extensions.duckdb.org` (no user data upload).

## Tech Stack

- [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview)
- [Apache ECharts](https://echarts.apache.org/)
- [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons)

## Support

- Issues: [GitHub Issues](https://github.com/atliuhui/powerduck/issues)
- Repository: [atliuhui/powerduck](https://github.com/atliuhui/powerduck)

## License

MIT. See [LICENSE](LICENSE).

PowerDuck is an independent open-source project. **Power BI** is a
trademark of Microsoft Corporation; this project is not affiliated with
or endorsed by Microsoft.

Contributing? See [DEVELOPMENT.md](DEVELOPMENT.md).
