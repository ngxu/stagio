# Security

## Reporting a vulnerability

Please report security problems privately: on GitHub, open the **Security** tab of this repository
and choose **Report a vulnerability**. Please do not open a public issue for them. You will get an
answer within a week; fixes go into the next beta of every edition that is affected.

Supported: the newest version of each edition (Lite, Standard, Extra) on the download page.

## How Stagio protects the desk

Stagio is a small web server on the presentation computer (port 7300, all network interfaces), so
phones on the same network can be remotes. What protects it:

- **The computer itself** (loopback) is trusted. Every other device needs the **access key**, which
  it gets by scanning the QR code shown on the computer, or by entering the 6-digit **PIN** shown
  there. Eight wrong PINs from one address lock that address out for five minutes.
- **Pairing details** (`/api/remote`: PIN, key, QR code) are only given to the computer itself.
- **Cross-site requests and DNS rebinding**: requests whose `Host` is not this computer, or whose
  `Origin` / `Sec-Fetch-Site` shows another site, are refused, so a web page open in a browser on
  the same computer cannot drive the desk.
- **Stage display** (Extra): its own PIN and key, which reach only a short list of read-only paths
  (`STAGE_PATHS` in `server.js`); changing slides from there is off unless the desk allows it.
- **Bluetooth remote**: paired with the same PIN.
- **Stored data**: settings, PIN, keys and the Spotify sign-in (PKCE, no client secret) are kept in
  the user's own profile (`%APPDATA%\OneDesk\config.json`) and never leave the computer except to
  Spotify, when the user connects it.

## Known limits

- The connection between phone and computer is **plain HTTP** on the local network. Someone who can
  watch that network's traffic could see the access key. Use a network you trust, or Stagio's own
  Wi-Fi (Windows; it has its own password).
- There is no button yet for a new PIN and key. To get new ones, close Stagio, remove `pin`,
  `accessKey`, `stagePin` and `stageKey` from `config.json`, and start it again.
- Anyone who can use the presentation computer's Windows account can use Stagio.
- The Windows installers are not code-signed yet (see [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md));
  the Mac version is not signed by Apple. Download only from this repository's releases or the
  official download page, and compare the SHA-256 shown in the release notes.
