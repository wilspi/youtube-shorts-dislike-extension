# Mozilla Source Build Instructions

The extension's JavaScript and CSS are submitted as written: they are not
minified, transpiled, bundled, or generated. The build script copies the runtime
files and uses a short Python script to add Firefox-only settings to
`manifest.json`.

## Requirements

- A Unix-like operating system. The script is compatible with Mozilla's default
  Ubuntu 24.04 reviewer environment.
- Bash
- Python 3 (standard library only)
- `zip`
- Standard `cp`, `mkdir`, and `rm` utilities

No package manager, dependency download, or network access is required.

## Build

From the extracted source archive's root directory, run:

```sh
chmod +x build.sh
./build.sh
```

The Firefox package is generated at:

```text
dist/shorts-dislike-firefox.zip
```

Extract that ZIP to compare its contents with the submitted extension. ZIP file
timestamps may reflect the build time, but the extracted files are identical.
