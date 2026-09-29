# opensac-installer

The npm distribution of [OpenSAC](https://gitee.com/startvibecoding/opensac), an
AI coding assistant for the terminal.

```bash
npm install -g opensac-installer
```

The installer resolves one prebuilt binary for your platform, so you download a
single executable rather than a package per platform.

## Usage

```bash
opensac                              # Interactive TUI
opensac -P "write fizzbuzz in Go"    # One-shot mode
opensac --provider deepseek-openai --model deepseek-v4-flash
```

Add an API key from inside the TUI with `/auth`, or export one before starting
(`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …).

Settings live in `$XDG_CONFIG_HOME/opensac/settings.json`
(`~/Library/Application Support/opensac/settings.json` on macOS,
`%APPDATA%\opensac\settings.json` on Windows).

## Supported platforms

| Platform      | Package                          |
| ------------- | -------------------------------- |
| Linux x64     | `opensac-installer-linux-x64`    |
| Linux arm64   | `opensac-installer-linux-arm64`  |
| macOS x64     | `opensac-installer-darwin-x64`   |
| macOS arm64   | `opensac-installer-darwin-arm64` |
| Windows x64   | `opensac-installer-win32-x64`    |
| Windows arm64 | `opensac-installer-win32-arm64`  |

## Uninstall

```bash
npm uninstall -g opensac-installer
```

## License

MIT
