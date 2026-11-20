// Spotify Web API client with Authorization Code + PKCE (no client secret needed).
const crypto = require('crypto');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

const { withFades } = require('./fade');

const API = 'https://api.spotify.com/v1';

class Spotify {
  constructor(cfg, saveCfg) {
    this.cfg = cfg;
    this.saveCfg = saveCfg;
    this.pkce = null;
    this.player = null;
    this.error = null;
    withFades(this, { stepMs: 200 }); // fadeOut/fadeIn/setVolume/cancelFade; slower steps for the Web API rate limit
  }

  // ---- used by withFades ----
  readout() {
    const p = this.player;
    return { playing: !!p?.is_playing, volume: p?.device?.volume_percent ?? null, canSetVolume: p?.device?.supports_volume !== false };
  }
  rawVolume(v) {
    return this.api('PUT', '/me/player/volume', { query: { volume_percent: Math.max(0, Math.min(100, Math.round(v))) } });
  }

  get redirectUri() { return `http://127.0.0.1:${this.cfg.port}/spotify/callback`; }
  get configured() { return !!this.cfg.spotify.clientId; }
  get authorized() { return !!this.cfg.spotify.tokens?.refresh_token; }

  authUrl() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(12).toString('base64url');
    this.pkce = { verifier, state };
    const q = new URLSearchParams({
      client_id: this.cfg.spotify.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    });
    return `https://accounts.spotify.com/authorize?${q}`;
  }

  async handleCallback(code, state) {
    if (!this.pkce || state !== this.pkce.state) throw new Error('Sign-in state mismatch, please connect again');
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: this.pkce.verifier,
    });
    this.pkce = null;
    this.storeTokens(tokens);
  }

  async tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.spotify.clientId, ...params }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Spotify sign-in failed: ${body.error_description || body.error || res.status}`);
    return body;
  }

  storeTokens(t) {
    const old = this.cfg.spotify.tokens || {};
    this.cfg.spotify.tokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token || old.refresh_token,
      expires_at: Date.now() + (t.expires_in - 60) * 1000,
    };
    this.saveCfg();
  }

  logout() {
    this.cfg.spotify.tokens = null;
    this.player = null;
    this.saveCfg();
  }

  async accessToken(force = false) {
    const t = this.cfg.spotify.tokens;
    if (!t) throw new Error('Spotify is not connected');
    if (force || Date.now() > t.expires_at) {
      if (!this.refreshing) {
        this.refreshing = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token })
          .then((nt) => this.storeTokens(nt))
          .finally(() => { this.refreshing = null; });
      }
      await this.refreshing;
    }
    return this.cfg.spotify.tokens.access_token;
  }

  async api(method, path, { query, body } = {}, retried = false) {
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : (method === 'GET' ? undefined : ''),
      signal: AbortSignal.timeout(10000), // a stalled connection must not stall the console
    });
    if (res.status === 401 && !retried) {
      await this.accessToken(true);
      return this.api(method, path, { query, body }, true);
    }
    if (res.status === 429) {
      // Spotify says how long to back off; polling on regardless only prolongs the block.
      const wait = Math.min(60, Number(res.headers.get('retry-after')) || 5);
      this.retryAt = Date.now() + wait * 1000;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* some endpoints return plain text */ }
    if (!res.ok) {
      const reason = json?.error?.reason;
      if (reason === 'NO_ACTIVE_DEVICE' || res.status === 404) throw new Error('No active Spotify device: open Spotify on this PC and play something, or pick a device under Devices');
      if (reason === 'PREMIUM_REQUIRED') throw new Error('Playback control needs a Spotify Premium account');
      if (res.status === 429) throw new Error('Too many Spotify requests, try again in a moment');
      throw new Error(json?.error?.message || `Spotify error ${res.status}`);
    }
    return json;
  }

  async poll() {
    if (!this.authorized) { this.player = null; return; }
    if (Date.now() < (this.retryAt || 0)) return; // rate-limited: wait it out
    try {
      this.player = await this.api('GET', '/me/player', { query: { additional_types: 'episode' } });
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
  }

  summary() {
    const p = this.player;
    const item = p?.item;
    return {
      configured: this.configured,
      authorized: this.authorized,
      redirectUri: this.redirectUri,
      error: this.error,
      fading: this.fading,
      player: p ? {
        isPlaying: p.is_playing,
        progressMs: p.progress_ms,
        shuffle: p.shuffle_state,
        repeat: p.repeat_state,
        device: p.device ? { id: p.device.id, name: p.device.name, type: p.device.type, volume: p.device.volume_percent, supportsVolume: p.device.supports_volume } : null,
        context: p.context?.uri || null,
        item: item ? {
          name: item.name,
          artists: (item.artists || []).map((a) => a.name).join(', ') || item.show?.name || '',
          album: item.album?.name || '',
          image: (item.album?.images || item.images || [])[0]?.url || null,
          durationMs: item.duration_ms,
          uri: item.uri,
        } : null,
      } : null,
    };
  }

  // ---- playback ----
  deviceId() { return this.player?.device?.id || undefined; }

  play(opts = {}) {
    const body = {};
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.uris) body.uris = opts.uris;
    return this.api('PUT', '/me/player/play', { query: { device_id: opts.deviceId }, body: Object.keys(body).length ? body : undefined });
  }
  pause() { return this.api('PUT', '/me/player/pause'); }
  next() { return this.api('POST', '/me/player/next'); }
  previous() { return this.api('POST', '/me/player/previous'); }
  seek(ms) { return this.api('PUT', '/me/player/seek', { query: { position_ms: Math.round(ms) } }); }
  shuffle(on) { return this.api('PUT', '/me/player/shuffle', { query: { state: !!on } }); }
  repeat(mode) { return this.api('PUT', '/me/player/repeat', { query: { state: mode } }); }
  queue(uri) { return this.api('POST', '/me/player/queue', { query: { uri } }); }
  async devices() { return (await this.api('GET', '/me/player/devices'))?.devices || []; }
  transfer(deviceId, play = true) { return this.api('PUT', '/me/player', { body: { device_ids: [deviceId], play } }); }
  async playlists() {
    const r = await this.api('GET', '/me/playlists', { query: { limit: 50 } });
    return (r?.items || []).filter(Boolean).map((p) => ({ name: p.name, uri: p.uri, image: p.images?.[0]?.url || null, owner: p.owner?.display_name }));
  }
  async search(q) {
    const r = await this.api('GET', '/search', { query: { q, type: 'track,playlist', limit: 10 } });
    return {
      tracks: (r?.tracks?.items || []).filter(Boolean).map((t) => ({ name: t.name, artists: t.artists.map((a) => a.name).join(', '), uri: t.uri, image: t.album?.images?.at(-1)?.url })),
      playlists: (r?.playlists?.items || []).filter(Boolean).map((p) => ({ name: p.name, uri: p.uri, image: p.images?.[0]?.url, owner: p.owner?.display_name })),
    };
  }

  async togglePlay() {
    await this.poll();
    if (this.player?.is_playing) return this.pause();
    return this.play({ deviceId: this.deviceId() });
  }
}

module.exports = { Spotify };
