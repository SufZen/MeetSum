# Vendored IBM Plex fonts (M9 Package B)

One font source serves both the UI (`next/font/local`, woff2, see `lib/fonts.ts`)
and the Hebrew PDF export (pdfkit, TTF, see `lib/pdf/fonts.ts`). Nothing is
fetched from Google Fonts or npm at build or run time.

## Source

Downloaded on 2026-10-13 from IBM's official GitHub releases of
[IBM/plex](https://github.com/IBM/plex/releases), release version **1.1.0** of
each family (published 2024-11-13):

| Family | Release tag | Asset | SHA-256 of the zip |
|---|---|---|---|
| IBM Plex Sans | `@ibm/plex-sans@1.1.0` | [ibm-plex-sans.zip](https://github.com/IBM/plex/releases/download/%40ibm/plex-sans%401.1.0/ibm-plex-sans.zip) | `fb365d910566e6d199cc2c15579a7dd9a267128e18431a394ed81f1970c69200` |
| IBM Plex Sans Hebrew | `@ibm/plex-sans-hebrew@1.1.0` | [ibm-plex-sans-hebrew.zip](https://github.com/IBM/plex/releases/download/%40ibm/plex-sans-hebrew%401.1.0/ibm-plex-sans-hebrew.zip) | `d7d490b8a767b972a7f361055fdcf60ad7cb7c270b38ff1bf859562a021369fd` |
| IBM Plex Mono | `@ibm/plex-mono@1.1.0` | [ibm-plex-mono.zip](https://github.com/IBM/plex/releases/download/%40ibm/plex-mono%401.1.0/ibm-plex-mono.zip) | `4bfc936d0e1fd19db6327a3786eabdbc3dc0d464500576f6458f6706df68d26c` |

Files are copied unmodified from each zip's `fonts/complete/ttf/` and
`fonts/complete/woff2/` folders. The `@ibm/plex-*` npm packages are
deliberately not dependencies: they ship no TTF files and run an IBM
telemetry `postinstall` script.

Weights (unchanged from the former `next/font/google` setup):

- IBM Plex Sans and IBM Plex Sans Hebrew: 400 Regular, 500 Medium, 600 SemiBold, 700 Bold
- IBM Plex Mono: 400 Regular, 500 Medium

## License

SIL Open Font License 1.1, Reserved Font Name "Plex". See `OFL.txt` (the
release's `LICENSE.txt`, identical in all three zips).

## Overrides

`MEETSUM_PDF_FONT_DIR` points the PDF renderer at another directory holding
the same `IBMPlex*.ttf` file names (the default is `assets/fonts/ttf`).
