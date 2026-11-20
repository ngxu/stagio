# Code signing policy

Free code signing for the Windows version is provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

> Status: applied for. Until the project is accepted, the Windows installers are not signed.

## What is signed

- `Stagio.exe`, the program itself
- the three installers: `Stagio-Lite-Setup-*.exe`, `Stagio-Standard-Setup-*.exe`,
  `Stagio-Extra-Setup-*.exe`

Only files built from this repository's source are signed, and only by the
[Windows build workflow](.github/workflows/windows.yml) on GitHub's own machines. Nothing built on
a personal computer is signed. Third-party files that ship inside the app (Electron and its
libraries) are not re-signed by this project.

The Mac version is not signed (it would need a paid Apple Developer account).

## Team

| Role | Members |
| --- | --- |
| Authors (trusted committers) | [ngxu](https://github.com/ngxu) |
| Reviewers | [ngxu](https://github.com/ngxu) |
| Approvers | [ngxu](https://github.com/ngxu) |

Changes from people outside the team are reviewed by a team member before they are merged.
Every release is approved by hand before it is signed. Accounts that can commit or approve use multi-factor
authentication on GitHub and SignPath.

## Privacy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it.

In detail:

- Stagio runs on the presentation computer. Phones and tablets connect to it directly over the
  local network (or Bluetooth); nothing goes through a server of this project.
- **Spotify**: only if the user connects a Spotify Premium account in Settings, Stagio talks to
  Spotify's Web API (`accounts.spotify.com`, `api.spotify.com`) to control playback. The tokens
  stay on the computer.
- **Bluetooth remote page**: only if the user starts the Bluetooth remote, the phone opens a page
  hosted on GitHub Pages (`ngxu.github.io/stagio/remote/`); GitHub serves that page as it serves any
  website. The remote itself then talks to the computer over Bluetooth.
- No analytics, no crash reports, no update checks.

## Reporting a problem

If a signed file looks wrong, or you think a signature is being misused, open an issue in this
repository or contact SignPath Foundation.
