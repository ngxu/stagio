# Stagio helper: a long-running PowerShell process.
# Reads one JSON request per line on stdin: {"id":1,"cmd":"ppt.next","args":{...}}
# Writes one JSON response per line on stdout: {"id":1,"ok":true,"data":...}

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Windows.Forms

# Compiling C# takes a few seconds per helper start. Keep the compiled DLL (named by a hash of
# its source) so a crashed helper is back in about a second instead of five.
function Add-CachedType([string]$name, [string]$source, [string[]]$refs = @()) {
  $dir = Join-Path $env:LOCALAPPDATA 'Stagio\types'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source + ($refs -join ',')))) -replace '-', '').Substring(0, 16)
  $dll = Join-Path $dir "$name-$hash.dll"
  if (-not (Test-Path $dll)) {
    # Several helpers may start at once: compile to a private file, then move it into place.
    # If another helper got there first, its copy is used and ours is discarded.
    $tmp = Join-Path $dir "$name-$hash.$PID.dll"
    $params = @{ TypeDefinition = $source; Language = 'CSharp'; OutputAssembly = $tmp; OutputType = 'Library' }
    if ($refs.Count) { $params.ReferencedAssemblies = $refs }
    Add-Type @params
    try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
  Add-Type -LiteralPath $dll
  # Builds of this type from older versions are no longer needed. (A file another helper still
  # has loaded can't be deleted; it goes next time.)
  Get-ChildItem -LiteralPath $dir -Filter "$name-*.dll" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "$name-$hash.dll" } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

$audioSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Stagio {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROPERTYKEY { public Guid fmtid; public int pid; }

  [StructLayout(LayoutKind.Explicit, Size = 24)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorCom { }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  }

  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint ch, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  // Undocumented but long-stable interface used to change the default audio endpoint.
  [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
    [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
    [PreserveSig] int ResetDeviceFormat(IntPtr a);
    [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
    [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
  }

  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  class PolicyConfigClient { }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, uint b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, uint b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr name, IntPtr ctx);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr path, IntPtr ctx);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(IntPtr g, IntPtr ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
  }

  // Session volume per channel. (On this Windows build the sessions don't expose
  // ISimpleAudioVolume, but IChannelAudioVolume works and is applied on top of the mixer slider.)
  [ComImport, Guid("1C158861-B533-4B30-B1CF-E853E51C59B8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IChannelAudioVolume {
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetChannelVolume(uint index, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolume(uint index, out float level);
  }

  /// Volume of one application's audio (e.g. Spotify), on every output device.
  public static class AppVolume {
    public static string LastError;

    /// Names of all processes that currently have an audio session (diagnostics).
    public static List<string> Apps() {
      List<string> names = new List<string>();
      Find(null, names);
      return names;
    }

    static List<IChannelAudioVolume> Find(string processName, List<string> names) {
      List<IChannelAudioVolume> result = new List<IChannelAudioVolume>();
      // Match sessions by process ID: one process lookup per call instead of one per audio session.
      HashSet<uint> pids = null;
      if (processName != null) {
        pids = new HashSet<uint>();
        foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName(processName)) {
          pids.Add((uint)p.Id);
          p.Dispose();
        }
        if (pids.Count == 0) return result;
      }
      IMMDeviceCollection col;
      if (((IMMDeviceEnumerator)(new MMDeviceEnumeratorCom())).EnumAudioEndpoints(0, 1, out col) != 0) return result;
      int count; col.GetCount(out count);
      for (int i = 0; i < count; i++) {
        IMMDevice dev; if (col.Item(i, out dev) != 0) continue;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
        IAudioSessionEnumerator en;
        if (((IAudioSessionManager2)o).GetSessionEnumerator(out en) != 0) continue;
        int n; en.GetCount(out n);
        for (int j = 0; j < n; j++) {
          IAudioSessionControl2 ctl; if (en.GetSession(j, out ctl) != 0) continue;
          uint pid; if (ctl.GetProcessId(out pid) != 0 || pid == 0) continue;
          try {
            if (names != null) {
              using (System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById((int)pid)) names.Add(p.ProcessName);
            }
            if (pids != null && pids.Contains(pid)) result.Add((IChannelAudioVolume)ctl);
          } catch (Exception ex) { LastError = ex.GetType().Name + ": " + ex.Message; }
        }
      }
      return result;
    }

    /// 0-100, or -1 when the app has no audio session yet (it has not played anything).
    public static int Get(string processName) {
      float max = -1;
      foreach (IChannelAudioVolume v in Find(processName, null)) {
        uint ch; if (v.GetChannelCount(out ch) != 0) continue;
        for (uint c = 0; c < ch; c++) { float f; if (v.GetChannelVolume(c, out f) == 0 && f > max) max = f; }
      }
      return max < 0 ? -1 : (int)Math.Round(max * 100);
    }

    /// Sets every channel of every session of the app; returns how many sessions were changed.
    public static int Set(string processName, int percent) {
      StopFade(0); // a level set by hand ends any fade
      Guid g = Guid.Empty;
      float f = Math.Max(0, Math.Min(100, percent)) / 100f;
      List<IChannelAudioVolume> list = Find(processName, null);
      foreach (IChannelAudioVolume v in list) {
        uint ch; if (v.GetChannelCount(out ch) != 0) continue;
        for (uint c = 0; c < ch; c++) v.SetChannelVolume(c, f, ref g);
      }
      return list.Count;
    }

    // ---- fades ----
    // Windows applies a change of an app's volume at once, so each step of a fade is a small break
    // in the sound wave. Steps of a few points every 0.1 s (Stagio before 0.7.2) are heard as
    // crackling, like a microphone overloading. So a fade runs here, on its own thread: the app's
    // volume controls are looked up once, then set every ~2 ms along a straight line in decibels,
    // 50 dB deep, then silence. Each change Windows applies is then about 0.1 dB. Measured with a
    // test tone: breaks of ~1% of the wave and none over 10%, instead of a median 5% and up to 20%.

    [DllImport("winmm.dll")] static extern int timeBeginPeriod(int ms);
    [DllImport("winmm.dll")] static extern int timeEndPeriod(int ms);
    const double FadeDepthDb = 50;
    static readonly object fadeGate = new object();
    static int fadeId;                    // the fade allowed to run; any other one stops
    static string fadeState = "idle";     // running | done | stopped | failed
    static int fadeLevel = -1;            // last level set by a fade, 0-100

    /// Starts moving the app's volume from `from` (-1: where it is now) to `to` (0-100) over `ms`.
    /// Returns at once with the fade's number, or 0 if the app has no audio yet (nothing done).
    public static int StartFade(string processName, int from, int to, int ms) {
      int id;
      lock (fadeGate) { id = ++fadeId; fadeState = "running"; }
      int found = -1;
      ManualResetEvent ready = new ManualResetEvent(false);
      // A thread of its own (multithreaded COM), so it neither waits for nor blocks the helper.
      Thread t = new Thread(delegate () {
        List<IChannelAudioVolume> vols = null;
        try { vols = Find(processName, null); found = vols.Count; } catch { found = 0; }
        ready.Set();
        if (found > 0) RunFade(vols, processName, from, to, ms, id);
      });
      t.IsBackground = true;
      t.Priority = ThreadPriority.AboveNormal;
      t.Start();
      ready.WaitOne(5000);
      if (found <= 0) { lock (fadeGate) { if (fadeId == id) fadeState = "failed"; } return 0; }
      return id;
    }

    /// Stops fade `id` (0: whatever fade runs). Once this returns, that fade sets nothing more.
    public static void StopFade(int id) {
      lock (fadeGate) {
        if (id != 0 && id != fadeId) return;
        fadeId++;
        if (fadeState == "running") fadeState = "stopped";
      }
    }

    /// "running|done|stopped|failed|replaced" and the level it set last.
    public static string FadeStatus(int id) {
      lock (fadeGate) return (id == fadeId ? fadeState : "replaced") + "|" + fadeLevel;
    }

    static float LevelFor(double from, double to, double f) {
      if (f >= 1) return (float)to;
      if (from == to) return (float)to;
      double a, b;                                    // dB at the start and at the end
      if (to < from) { a = 20 * Math.Log10(from); b = to > 0 ? 20 * Math.Log10(to) : a - FadeDepthDb; }
      else { b = 20 * Math.Log10(to); a = from > 0 ? 20 * Math.Log10(from) : b - FadeDepthDb; }
      return (float)Math.Max(0, Math.Min(1, Math.Pow(10, (a + (b - a) * f) / 20)));
    }

    static void RunFade(List<IChannelAudioVolume> vols, string processName, int fromPct, int toPct, int ms, int id) {
      Guid g = Guid.Empty;
      double from = fromPct >= 0 ? fromPct / 100.0 : -1, to = Math.Max(0, Math.Min(100, toPct)) / 100.0;
      if (from < 0) {                                  // from where it is now
        float max = 0;
        foreach (IChannelAudioVolume v in vols) { uint ch; if (v.GetChannelCount(out ch) != 0) continue; for (uint c = 0; c < ch; c++) { float x; if (v.GetChannelVolume(c, out x) == 0 && x > max) max = x; } }
        from = max;
      }
      timeBeginPeriod(1);                              // ~2 ms sleeps instead of ~16 ms
      try {
        System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
        bool refound = false;
        for (;;) {
          double f = ms <= 0 ? 1 : Math.Min(1.0, sw.Elapsed.TotalMilliseconds / ms);
          float level = LevelFor(from, to, f);
          lock (fadeGate) {
            if (id != fadeId) return;                  // stopped, or another fade took over
            bool failed = false;
            foreach (IChannelAudioVolume v in vols) {
              uint ch; if (v.GetChannelCount(out ch) != 0) { failed = true; continue; }
              for (uint c = 0; c < ch; c++) if (v.SetChannelVolume(c, level, ref g) != 0) failed = true;
            }
            fadeLevel = (int)Math.Round(level * 100);
            if (failed && !refound) {                 // e.g. Spotify moved to another output device
              refound = true;
              try { List<IChannelAudioVolume> again = Find(processName, null); if (again.Count > 0) vols = again; } catch { }
            }
            if (f >= 1) { fadeState = "done"; return; }
          }
          Thread.Sleep(2);
        }
      } catch (Exception ex) {
        LastError = ex.GetType().Name + ": " + ex.Message;
        lock (fadeGate) { if (id == fadeId) fadeState = "failed"; }
      } finally { timeEndPeriod(1); }
    }

    /// Waits (up to `ms`) for the app's audio to appear and silences it the moment it does:
    /// a fade-in right after Spotify was opened would otherwise start at full level. True if found.
    public static bool SilenceWhenReady(string processName, int ms) {
      System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
      Guid g = Guid.Empty;
      while (sw.ElapsedMilliseconds < ms) {
        List<IChannelAudioVolume> vols = Find(processName, null);
        if (vols.Count > 0) {
          foreach (IChannelAudioVolume v in vols) { uint ch; if (v.GetChannelCount(out ch) != 0) continue; for (uint c = 0; c < ch; c++) v.SetChannelVolume(c, 0f, ref g); }
          return true;
        }
        Thread.Sleep(10);
      }
      return false;
    }
  }

  public class AudioDevice {
    public string Id;
    public string Name;
    public bool IsDefault;
  }

  public static class Audio {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);

    static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom()); }

    static void Check(int hr) { if (hr != 0) Marshal.ThrowExceptionForHR(hr); }

    static string FriendlyName(IMMDevice dev) {
      IPropertyStore store;
      Check(dev.OpenPropertyStore(0, out store));
      PROPERTYKEY key = new PROPERTYKEY();
      key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
      key.pid = 14;
      PROPVARIANT pv;
      Check(store.GetValue(ref key, out pv));
      string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.pointerValue) : "(unknown)";
      PropVariantClear(ref pv);
      return name;
    }

    public static string DefaultId() {
      IMMDevice dev;
      int hr = Enumerator().GetDefaultAudioEndpoint(0, 1, out dev);
      if (hr != 0) return null;
      string id; Check(dev.GetId(out id));
      return id;
    }

    public static List<AudioDevice> List() {
      string def = DefaultId();
      List<AudioDevice> result = new List<AudioDevice>();
      IMMDeviceCollection col;
      Check(Enumerator().EnumAudioEndpoints(0, 1, out col));
      int count; Check(col.GetCount(out count));
      for (int i = 0; i < count; i++) {
        IMMDevice dev; Check(col.Item(i, out dev));
        string id; Check(dev.GetId(out id));
        AudioDevice d = new AudioDevice();
        d.Id = id; d.Name = FriendlyName(dev); d.IsDefault = (id == def);
        result.Add(d);
      }
      return result;
    }

    public static void SetDefault(string id) {
      IPolicyConfig pc = (IPolicyConfig)(new PolicyConfigClient());
      for (int role = 0; role < 3; role++) Check(pc.SetDefaultEndpoint(id, role));
    }

    static IAudioEndpointVolume Volume() {
      IMMDevice dev;
      Check(Enumerator().GetDefaultAudioEndpoint(0, 1, out dev));
      Guid iid = typeof(IAudioEndpointVolume).GUID;
      object o;
      Check(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }

    public static int GetVolume() { float v; Check(Volume().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }
    public static void SetVolume(int percent) {
      lock (glideGate) glideId++;  // a level set at once ends any glide
      Guid g = Guid.Empty;
      float v = Math.Max(0, Math.Min(100, percent)) / 100f;
      Check(Volume().SetMasterVolumeLevelScalar(v, ref g));
    }

    // The system volume moves to a new level over `ms` instead of jumping (a jump is heard as a
    // bump, or a click while sound plays): small steps every ~5 ms, on its own thread so the
    // helper answers at once. Windows' "scalar" volume already follows the ear, so the steps are
    // even in it. A newer glide or a level set at once stops the one running.
    [DllImport("winmm.dll")] static extern int timeBeginPeriod(int ms);
    [DllImport("winmm.dll")] static extern int timeEndPeriod(int ms);
    static readonly object glideGate = new object();
    static int glideId;

    public static void GlideVolume(int percent, int ms) {
      int id;
      lock (glideGate) id = ++glideId;
      float to = Math.Max(0, Math.Min(100, percent)) / 100f;
      Thread t = new Thread(delegate () {
        timeBeginPeriod(1);
        try {
          IAudioEndpointVolume vol = Volume();
          Guid g = Guid.Empty;
          float from; Check(vol.GetMasterVolumeLevelScalar(out from));
          System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
          for (;;) {
            double f = ms <= 0 ? 1 : Math.Min(1.0, sw.Elapsed.TotalMilliseconds / ms);
            float v = (float)(from + (to - from) * f);
            lock (glideGate) {
              if (id != glideId) return;
              vol.SetMasterVolumeLevelScalar(v, ref g);
            }
            if (f >= 1) return;
            Thread.Sleep(5);
          }
        } catch { } finally { timeEndPeriod(1); }
      });
      t.IsBackground = true;
      t.Start();
    }
    public static bool GetMute() { bool m; Check(Volume().GetMute(out m)); return m; }
    public static void SetMute(bool mute) { Guid g = Guid.Empty; Check(Volume().SetMute(mute, ref g)); }
  }
}
'@
Add-CachedType 'audio' $audioSource

# ---------------- PowerPoint ----------------

$ppSlideShowStates = @{ 1 = 'running'; 2 = 'paused'; 3 = 'black'; 4 = 'white'; 5 = 'done' }

function Get-PPT {
  try { return [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { return $null }
}

function Require-PPT {
  $app = Get-PPT
  if (-not $app) { throw 'PowerPoint is not running' }
  return $app
}

function Find-Presentation($app, $path) {
  if ($path) {
    foreach ($p in $app.Presentations) { if ($p.FullName -eq $path) { return $p } }
    throw "Presentation is not open: $path"
  }
  if ($app.SlideShowWindows.Count -gt 0) { return $app.SlideShowWindows.Item(1).Presentation }
  if ($app.Presentations.Count -gt 0) { return $app.ActivePresentation }
  throw 'No presentation is open'
}

function Get-ShowView {
  $app = Require-PPT
  if ($app.SlideShowWindows.Count -lt 1) { throw 'The slide show is not running' }
  return $app.SlideShowWindows.Item(1).View
}

function Get-SlideTitle($slide) {
  try {
    if ($slide.Shapes.HasTitle -eq -1) {
      $t = $slide.Shapes.Title.TextFrame.TextRange.Text
      if ($t) { return ($t -replace '[\r\n\v]+', ' ').Trim() }
    }
  } catch { }
  return ''
}

function Get-SlideNotes($slide) {
  try {
    foreach ($sh in $slide.NotesPage.Shapes.Placeholders) {
      if ($sh.PlaceholderFormat.Type -eq 2) { return ($sh.TextFrame.TextRange.Text -replace '\r', "`n") }
    }
  } catch { }
  return ''
}

$script:notesKey = ''
$script:notesText = ''
$script:notesClock = [Diagnostics.Stopwatch]::StartNew()

function PPT-State {
  $app = Get-PPT
  if (-not $app) { return @{ running = $false } }
  $list = @()
  foreach ($p in $app.Presentations) {
    $autoSave = $null
    try { $autoSave = [bool]$p.AutoSaveOn } catch { }
    $list += @{ name = $p.Name; path = $p.FullName; slides = $p.Slides.Count; cloud = ($p.FullName -match '^https?://'); autoSave = $autoSave }
  }
  $show = $null
  if ($app.SlideShowWindows.Count -gt 0) {
    $w = $app.SlideShowWindows.Item(1)
    $v = $w.View
    $pres = $w.Presentation
    $full = $pres.FullName
    $idx = 0; $notes = ''; $sid = 0; $click = 0; $clicks = 0
    try {
      $cur = $v.Slide; $idx = $cur.SlideIndex; $sid = $cur.SlideID
      # Animation steps: how many clicks this slide has and how many have been played, so the
      # console can tell whether the next press reveals a build or changes the slide.
      try { $click = [int]$v.GetClickIndex(); $clicks = [int]$v.GetClickCount() } catch { }
      # This runs several times a second. Notes take a handful of extra calls into PowerPoint, so
      # they are re-read only when the slide changes (and every 5 s, in case they are edited live).
      $key = "$full|$sid"
      if ($key -ne $script:notesKey -or $script:notesClock.ElapsedMilliseconds -gt 5000) {
        $script:notesText = Get-SlideNotes $cur
        $script:notesKey = $key
        $script:notesClock.Restart()
      }
      $notes = $script:notesText
    } catch { $idx = 0 }
    $show = @{
      path   = $full
      name   = $pres.Name
      slide  = $idx
      slideId = $sid   # stable identity: slide numbers shift when slides are added or removed live
      total  = $pres.Slides.Count
      state  = $ppSlideShowStates[[int]$v.State]
      notes  = $notes
      click  = $click
      clicks = $clicks
    }
  }
  $active = $null
  try { if ($app.Presentations.Count -gt 0) { $active = $app.ActivePresentation.FullName } } catch { }
  # A file opened from a download or e-mail sits in Protected View: PowerPoint shows it, but it is
  # not among Presentations until "Enable Editing" is clicked. Report it so the console can say why
  # it sees no presentation.
  $protected = $null
  try {
    if ($app.ProtectedViewWindows.Count -gt 0) {
      $pv = $app.ProtectedViewWindows.Item(1)
      try { $protected = [string]$pv.SourceName } catch { }   # the file name
      if (-not $protected) { $protected = [string]$pv.Caption }
    }
  } catch { }
  return @{ running = $true; presentations = $list; active = $active; show = $show; protectedView = $protected }
}

function PPT-EnableEditing {
  $app = Require-PPT
  if ($app.ProtectedViewWindows.Count -lt 1) { throw 'No file is in Protected View' }
  $p = $app.ProtectedViewWindows.Item(1).Edit()
  return $p.FullName
}

# Slide scanning runs as compiled C#: reading COM properties from PowerShell script is roughly
# 10x slower, which made a 100-slide deck take ~9 s per scan.
$scanSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Stagio {
  public class SlideInfo {
    public int index { get; set; }
    public int id { get; set; }
    public string title { get; set; }
    public bool hidden { get; set; }
    public string sig { get; set; }
  }

  public class ScanResult {
    public List<int> ids { get; set; }          // every slide's ID, in show order (cheap)
    public List<SlideInfo> slides { get; set; } // details for requested and newly seen slides
  }

  public static class PptScan {
    static readonly MD5 Md5 = MD5.Create();

    /// Lists every slide ID (cheap). Slides not in `known` get title + hidden flag (cheap).
    /// Then the slides in `want` (slide numbers, most urgent first) get a content signature
    /// until `budgetMs` runs out; at least one is always done. Reading shapes over COM competes
    /// with the running show, so each call stays short.
    public static ScanResult Scan(string path, int[] want, int[] known, int budgetMs, bool listAll) {
      dynamic app = Marshal.GetActiveObject("PowerPoint.Application");
      dynamic pres = null;
      foreach (dynamic p in app.Presentations) { if ((string)p.FullName == path) { pres = p; break; } }
      if (pres == null) throw new Exception("Presentation is not open: " + path);
      HashSet<int> knownSet = new HashSet<int>(known ?? new int[0]);
      ScanResult r = new ScanResult();
      r.slides = new List<SlideInfo>();
      if (!listAll) {
        // Only the requested slides: listing every slide costs ~3 cross-process calls per slide.
        System.Diagnostics.Stopwatch sw0 = System.Diagnostics.Stopwatch.StartNew();
        int count = (int)pres.Slides.Count;
        bool did = false;
        foreach (int index in want ?? new int[0]) {
          if (index < 1 || index > count) continue;
          if (did && sw0.ElapsedMilliseconds >= budgetMs) break;
          dynamic s = pres.Slides.Item(index);
          SlideInfo info = Basic(s, index, (int)s.SlideID);
          info.sig = Sig(s);
          r.slides.Add(info);
          did = true;
        }
        return r;
      }
      r.ids = new List<int>();
      List<dynamic> all = new List<dynamic>();
      foreach (dynamic s in pres.Slides) { all.Add(s); r.ids.Add((int)s.SlideID); }

      System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
      Dictionary<int, SlideInfo> byIndex = new Dictionary<int, SlideInfo>();
      for (int k = 0; k < all.Count && sw.ElapsedMilliseconds < budgetMs; k++) {
        if (knownSet.Contains(r.ids[k])) continue;
        SlideInfo info = Basic(all[k], k + 1, r.ids[k]);
        byIndex[k + 1] = info;
        r.slides.Add(info);
      }
      bool done = false;
      foreach (int index in want ?? new int[0]) {
        if (index < 1 || index > all.Count) continue;
        if (done && sw.ElapsedMilliseconds >= budgetMs) break;
        SlideInfo info;
        if (!byIndex.TryGetValue(index, out info)) {
          info = Basic(all[index - 1], index, r.ids[index - 1]);
          byIndex[index] = info;
          r.slides.Add(info);
        }
        info.sig = Sig(all[index - 1]);
        done = true;
      }
      return r;
    }

    static SlideInfo Basic(dynamic s, int index, int id) {
      SlideInfo info = new SlideInfo();
      info.index = index;
      info.id = id;
      info.title = Title(s);
      try { info.hidden = (int)s.SlideShowTransition.Hidden == -1; } catch { }
      return info;
    }
    static string Clean(string t) {
      if (t == null) return "";
      t = System.Text.RegularExpressions.Regex.Replace(t, "[\r\n\v]+", " ").Trim();
      return t.Length > 80 ? t.Substring(0, 80) : t;
    }

    /// The title placeholder's text, or else the first text on the slide (many decks made in
    /// design tools have no title placeholder, only text boxes).
    static string Title(dynamic s) {
      try {
        if ((int)s.Shapes.HasTitle == -1) {
          string t = Clean((string)s.Shapes.Title.TextFrame.TextRange.Text);
          if (t.Length > 0) return t;
        }
      } catch { }
      try {
        int n = 0;
        foreach (dynamic sh in s.Shapes) {
          if (++n > 20) break;
          try {
            if ((int)sh.HasTextFrame == -1) {
              string t = Clean((string)sh.TextFrame.TextRange.Text);
              if (t.Length > 0) return t;
            }
          } catch { }
        }
      } catch { }
      return "";
    }

    // A fingerprint of what the slide looks like: when someone edits the slide (here or as a
    // co-author), the fingerprint changes and the slide's image is made again.
    // Every property read is a cross-process call into PowerPoint, which a slide change may have
    // to wait behind, so this reads what was measured to be cheap and what live edits usually
    // touch: the slide's background and layout; for every shape (in stacking order) its identity,
    // type, position, size and rotation; text with its font, size, weight and colour; picture
    // cropping; table cells; group members. Fill and outline colours, flips and alignment cost
    // as much again and are left out: a slide edited that way is corrected from the projector as
    // soon as it is shown, or by "Reload all". Same for an image swapped for another of the same
    // shape, chart data and SmartArt.
    public const string SigVersion = "4";
    static string Sig(dynamic s) {
      StringBuilder sb = new StringBuilder(SigVersion);
      try {
        int follow = (int)s.FollowMasterBackground;
        sb.Append("|bg").Append(follow);
        if (follow == 0) {
          dynamic fill = s.Background.Fill;
          sb.Append(',').Append((object)fill.Type).Append(',').Append((object)fill.ForeColor.RGB);
        }
      } catch { }
      try { sb.Append("|lay").Append((object)s.CustomLayout.Name); } catch { }
      sb.Append('\n');
      foreach (dynamic sh in s.Shapes) AddShape(sb, sh);
      byte[] h = Md5.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString()));
      return BitConverter.ToString(h, 0, 6).Replace("-", "").ToLowerInvariant();
    }

    static void AddShape(StringBuilder sb, dynamic sh) {
      int type = 0;
      try {
        type = (int)sh.Type;
        sb.Append((object)sh.Id).Append(':').Append(type).Append(':')
          .Append((object)sh.Left).Append(',').Append((object)sh.Top).Append(',')
          .Append((object)sh.Width).Append(',').Append((object)sh.Height).Append(',')
          .Append((object)sh.Rotation);
      } catch { }
      if (type == 6) {           // group: its members carry the look
        try { foreach (dynamic g in sh.GroupItems) AddShape(sb, g); } catch { }
        sb.Append('\n');
        return;
      }
      if (type == 13 || type == 11) {           // picture (embedded or linked)
        try {
          dynamic pf = sh.PictureFormat;
          sb.Append("|p").Append((object)pf.CropLeft).Append(',').Append((object)pf.CropTop);
          dynamic crop = pf.Crop;
          sb.Append(',').Append((object)crop.PictureWidth).Append(',').Append((object)crop.PictureHeight);
        } catch { }
      }
      try {
        if ((int)sh.HasTextFrame == -1) {
          dynamic tr = sh.TextFrame.TextRange;
          string text = (string)tr.Text;
          sb.Append("|t").Append(text);
          if (text.Length > 0) {
            // Whole-text formatting (a mix reads as "mixed").
            dynamic ft = tr.Font;
            sb.Append("|r").Append((object)ft.Name).Append(',').Append((object)ft.Size).Append(',')
              .Append((object)ft.Bold).Append(',').Append((object)ft.Color.RGB);
          }
        }
      } catch { }
      try {
        if ((int)sh.HasTable == -1) {
          foreach (dynamic row in sh.Table.Rows)
            foreach (dynamic cell in row.Cells) sb.Append("|c").Append((object)cell.Shape.TextFrame.TextRange.Text);
        }
      } catch { }
      sb.Append('\n');
    }

  }
}
'@
Add-CachedType 'scan' $scanSource @('Microsoft.CSharp', 'System.Core')

function PPT-Slides($a) {
  $app = Require-PPT
  $p = Find-Presentation $app $a.path
  $want = if ($a.want) { [int[]]$a.want } else { [int[]]@() }
  $known = if ($a.known) { [int[]]$a.known } else { [int[]]@() }
  $listAll = if ($null -eq $a.listAll) { $true } else { [bool]$a.listAll }
  $budget = if ($null -ne $a.budget) { [int]$a.budget } else { 800 }
  $r = [Stagio.PptScan]::Scan($p.FullName, $want, $known, $budget, $listAll)
  $ids = $null
  if ($null -ne $r.ids) { $ids = [object[]]$r.ids.ToArray() }
  return @{
    path   = $p.FullName
    ratio  = [double]($p.PageSetup.SlideWidth / $p.PageSetup.SlideHeight)
    ids    = $ids
    slides = @($r.slides)
  }
}

# Renders one slide. `out` is a path without extension; the result is two JPEGs:
#   <out>.jpg   640 px wide, for the program/preview monitors
#   <out>.s.jpg 256 px wide, for the slide strip (about 10 KB instead of 100-300 KB)
# PowerPoint exports a PNG once; the two JPEGs are made here, outside PowerPoint.
function PPT-Thumb($a) {
  $app = Require-PPT
  $p = Find-Presentation $app $a.path
  $width = 640
  $height = [int]($width * $p.PageSetup.SlideHeight / $p.PageSetup.SlideWidth)
  if ($a.id) { $slide = $p.Slides.FindBySlideID([int]$a.id) } else { $slide = $p.Slides.Item([int]$a.slide) }
  $base = [string]$a.out
  $png = "$base.png"
  $slide.Export($png, 'PNG', $width, $height)
  [Stagio.Thumbs]::Convert($png, "$base.jpg", "$base.s.jpg", 256)
  return $true
}

# ---------------- presentations that carry their own fonts ----------------
# Slide.Export draws text only with fonts this PC has (installed, or Office cloud fonts such as
# Aptos that Office has downloaded). Fonts embedded in the file itself are ignored: Canva exports
# bring their own (Bebas Neue Bold, Beckett, Helvetica Now…), and in the image they turn into a
# default font, the text reflows and overlaps, and the thumbnail no longer matches the projector.
# PowerPoint's PDF export does use embedded fonts. For such presentations the slides are exported
# as a PDF, and Windows' own PDF renderer (Windows.Data.Pdf) turns each page into the image.

$script:fontNames = $null
$script:fontNamesAt = [DateTime]::MinValue
function Get-AvailableFonts {
  if ($script:fontNames -and ((Get-Date) - $script:fontNamesAt).TotalMinutes -lt 10) { return $script:fontNames }
  Add-Type -AssemblyName System.Drawing
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $ifc = New-Object System.Drawing.Text.InstalledFontCollection
  try { foreach ($fam in $ifc.Families) { [void]$set.Add($fam.Name) } } finally { $ifc.Dispose() }
  $cloud = Join-Path $env:LOCALAPPDATA 'Microsoft\FontCache\4\CloudFonts'
  if (Test-Path -LiteralPath $cloud) {
    foreach ($d in Get-ChildItem -LiteralPath $cloud -Directory -ErrorAction SilentlyContinue) { [void]$set.Add($d.Name) }
  }
  $script:fontNames = $set
  $script:fontNamesAt = Get-Date
  return $set
}

# Fonts the presentation uses that this PC doesn't have. `embedded`: those of them stored in the
# file, which PowerPoint shows but Slide.Export can't (the others PowerPoint can't show either).
function PPT-Fonts($a) {
  $p = Find-Presentation (Require-PPT) $a.path
  $have = Get-AvailableFonts
  $missing = New-Object System.Collections.Generic.List[string]
  $embedded = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($font in $p.Fonts) {
      $n = [string]$font.Name
      if (-not $n -or $have.Contains($n) -or $missing.Contains($n)) { continue }
      $missing.Add($n)
      if ([int]$font.Embedded -ne 0) { $embedded.Add($n) }
    }
  } catch { }
  return @{ missing = [object[]]$missing.ToArray(); embedded = [object[]]$embedded.ToArray() }
}

$script:pdfTypes = $false
function Release-Com($o) {
  if ($null -ne $o) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } catch { } }
}
function Wait-Task($task, [int]$ms, [string]$what) {
  $ok = $false
  try { $ok = $task.Wait($ms) } catch { throw "$what failed: $($task.Exception.InnerException.Message)" }
  if (-not $ok) { throw "$what did not finish in time" }
}

function Init-PdfTypes {
  if ($script:pdfTypes) { return }
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $script:asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  $script:pdfTypes = $true
}

# Exports slides $from..$to of presentation $p as a PDF file.
# The page range is one of the presentation's print settings. They are put back afterwards and
# the "modified" flag restored, so the file itself is left exactly as it was.
# Ranges.ClearAll() frees PowerPoint's range objects. If this process still holds a reference to
# one, releasing it later (the clean-up after every command) corrupts PowerPoint's memory and
# PowerPoint crashes. So every range object is let go of explicitly before each ClearAll.
function Export-PdfRange($p, [int]$from, [int]$to, [string]$pdf) {
  $ranges = $p.PrintOptions.Ranges
  $wasSaved = $p.Saved
  $oldRanges = @()
  for ($i = 1; $i -le $ranges.Count; $i++) {
    $r = $ranges.Item($i)
    $oldRanges += ,@([int]$r.Start, [int]$r.End)
    Release-Com $r
  }
  $r = $null
  $ranges.ClearAll()
  $range = $ranges.Add($from, $to)
  try {
    # PDF, screen quality, hidden slides included, fonts that may not be embedded drawn as pictures.
    $p.ExportAsFixedFormat($pdf, 2, 1, 0, 1, 1, -1, $range, 4, '', $false, $true, $false, $true, $false)
  } finally {
    Release-Com $range
    $range = $null
    try {
      $ranges.ClearAll()
      foreach ($o in $oldRanges) { Release-Com ($ranges.Add($o[0], $o[1])) }
    } catch { }
    Release-Com $ranges
    $ranges = $null
    try { if ($p.Saved -ne $wasSaved) { $p.Saved = $wasSaved } } catch { }
  }
}

# Loads an exported PDF with Windows' own PDF renderer (read into memory, the file is deleted).
function Open-Pdf([string]$pdf) {
  Init-PdfTypes
  $bytes = [IO.File]::ReadAllBytes($pdf)
  Remove-Item -LiteralPath $pdf -Force -ErrorAction SilentlyContinue
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream((New-Object IO.MemoryStream (, $bytes)))
  $load = $script:asTask.MakeGenericMethod([Windows.Data.Pdf.PdfDocument]).Invoke($null, @([Windows.Data.Pdf.PdfDocument]::LoadFromStreamAsync($ras)))
  Wait-Task $load 30000 'Reading the exported PDF'
  return @{ doc = $load.Result; stream = $ras }
}

# Draws page $n (0-based) of a loaded PDF into a PNG of the given size.
function Save-PdfPage($doc, [int]$n, [string]$png, [int]$width, [int]$height) {
  $page = $doc.GetPage([uint32]$n)
  $ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  try {
    $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opt.DestinationWidth = [uint32]$width
    $opt.DestinationHeight = [uint32]$height
    Wait-Task ($script:asTaskAction.Invoke($null, @($page.RenderToStreamAsync($ms, $opt)))) 30000 'Drawing the slide image'
    $src = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ms.GetInputStreamAt(0))
    $fs = [IO.File]::Create($png)
    try { $src.CopyTo($fs) } finally { $fs.Close(); $src.Dispose() }
  } finally { $ms.Dispose(); $page.Dispose() }
}

# One slide, rendered the way PowerPoint prints (embedded fonts included), as a PNG.
function Render-SlidePdf($p, [int]$index, [string]$png, [int]$width) {
  $height = [int]($width * $p.PageSetup.SlideHeight / $p.PageSetup.SlideWidth)
  $pdf = [IO.Path]::ChangeExtension($png, '.pdf')
  Export-PdfRange $p $index $index $pdf
  $loaded = Open-Pdf $pdf
  try { Save-PdfPage $loaded.doc 0 $png $width $height } finally { $loaded.stream.Dispose() }
}

# Renders slides next to each other (args.items: [{ id, out }]) through one PDF export; writes
# the same two JPEGs per slide as PPT-Thumb. Returns the IDs that were rendered.
function PPT-ThumbsPdf($a) {
  $app = Require-PPT
  $p = Find-Presentation $app $a.path
  $width = 640
  $height = [int]($width * $p.PageSetup.SlideHeight / $p.PageSetup.SlideWidth)
  $items = @()
  foreach ($it in @($a.items)) {
    try { $idx = [int]$p.Slides.FindBySlideID([int]$it.id).SlideIndex } catch { continue } # deleted meanwhile
    $items += [pscustomobject]@{ id = [int]$it.id; out = [string]$it.out; idx = $idx }
  }
  if (-not $items.Count) { return @{ done = @() } }
  $from = [int]($items | Measure-Object -Property idx -Minimum).Minimum
  $to = [int]($items | Measure-Object -Property idx -Maximum).Maximum
  if ($to - $from + 1 -gt 2 * $items.Count) {
    # Slides were moved since they were picked: don't export everything in between.
    $to = $from
    $items = @($items | Where-Object { $_.idx -eq $from })
  }
  Export-PdfRange $p $from $to ([string]$a.pdf)
  $loaded = Open-Pdf ([string]$a.pdf)
  $done = @()
  try {
    foreach ($it in $items) {
      $n = $it.idx - $from
      if ($n -ge $loaded.doc.PageCount) { continue }
      $png = "$($it.out).png"
      Save-PdfPage $loaded.doc $n $png $width $height
      [Stagio.Thumbs]::Convert($png, "$($it.out).jpg", "$($it.out).s.jpg", 256)
      $done += $it.id
    }
  } finally { $loaded.stream.Dispose() }
  return @{ done = [object[]]$done; from = $from; to = $to }
}

# ---------------- text that makes Windows PowerPoint slow ----------------
# Letters of a script such as Hebrew or Arabic, set in a font that doesn't contain them (Canva
# exports set decorative Hebrew in Helvetica Now): every time PowerPoint for Windows draws the
# slide it has to look for a substitute font, letter by letter. Measured on such a deck: 2-6 s per
# slide image and 3-7 s per slide change, against 0.3-0.6 s without that text. The Mac's text
# engine doesn't have this problem. Naming the substitute font directly made slide images faster
# but not the show itself; turned into a picture, the same slides change in ~30 ms. So the
# "faster copy" (PPT-FastCopy*) does that, in a copy, leaving the original as it is.

$script:complexScript = '[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u097F\u0E00-\u0E7F]'
function Script-Name([string]$text) {
  if ($text -match '[\u0590-\u05FF\uFB1D-\uFB4F]') { return 'Hebrew' }
  if ($text -match '[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]') { return 'Arabic' }
  if ($text -match '[\u0900-\u097F]') { return 'Devanagari' }
  if ($text -match '[\u0E00-\u0E7F]') { return 'Thai' }
  return ''
}

# Read straight from the saved file (no PowerPoint involved, well under a second for a 37 MB deck):
# how much such text there is, on how many slides, in which fonts.
function Deck-SlowText($a) {
  $path = [string]$a.path
  if ($path -match '^https?://' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $have = Get-AvailableFonts
  $fonts = New-Object 'System.Collections.Generic.HashSet[string]'
  $scripts = New-Object 'System.Collections.Generic.HashSet[string]'
  $slides = 0; $total = 0; $chars = 0
  $zip = [IO.Compression.ZipFile]::OpenRead($path)
  try {
    foreach ($e in $zip.Entries) {
      if ($e.FullName -notmatch '^ppt/slides/slide\d+\.xml$') { continue }
      $total++
      $reader = New-Object IO.StreamReader($e.Open(), [Text.Encoding]::UTF8)
      $xml = $reader.ReadToEnd(); $reader.Close()
      if ($xml -notmatch $script:complexScript) { continue }
      $here = 0
      foreach ($run in [regex]::Matches($xml, '<a:r>(.*?)</a:r>', 'Singleline')) {
        $text = -join ([regex]::Matches($run.Value, '<a:t>([^<]*)</a:t>') | ForEach-Object { $_.Groups[1].Value })
        $n = ([regex]::Matches($text, $script:complexScript)).Count
        if (-not $n) { continue }
        $cs = [regex]::Match($run.Value, '<a:cs typeface="([^"]*)"').Groups[1].Value
        if (-not $cs -or $cs.StartsWith('+') -or $have.Contains($cs)) { continue }
        $here += $n
        [void]$fonts.Add($cs)
        [void]$scripts.Add((Script-Name $text))
      }
      if ($here) { $slides++; $chars += $here }
    }
  } finally { $zip.Dispose() }
  return @{ slides = $slides; total = $total; chars = $chars; fonts = [object[]]@($fonts); scripts = [object[]]@($scripts) }
}

# True if a shape (or a member of a group) has such letters in a font this PC lacks.
function Has-SlowText($sh, $have) {
  try {
    if ([int]$sh.Type -eq 6) { foreach ($g in $sh.GroupItems) { if (Has-SlowText $g $have) { return $true } }; return $false }
    if ([int]$sh.HasTextFrame -ne -1 -or [int]$sh.TextFrame.HasText -ne -1) { return $false }
    $tr = $sh.TextFrame.TextRange
    if ([string]$tr.Text -notmatch $script:complexScript) { return $false }
    $cs = [string]$tr.Font.NameComplexScript
    return [bool]($cs -and -not $have.Contains($cs))
  } catch { return $false }
}

# Shapes that must stay as they are: animated, or linked/clickable (a picture would lose that).
function Is-Interactive($s, $sh) {
  try { if ([int]$sh.ActionSettings.Item(1).Action -ne 0 -or [int]$sh.ActionSettings.Item(2).Action -ne 0) { return $true } } catch { }
  try { foreach ($e in $s.TimeLine.MainSequence) { if ($e.Shape.Name -eq $sh.Name) { return $true } } } catch { }
  return $false
}

# The slow text on a slide, as runs of shapes next to each other in the stacking order (each run
# becomes one picture at the same depth, so nothing else ends up above or below it).
function Slow-Runs($s, $have) {
  $runs = New-Object System.Collections.ArrayList
  $cur = $null
  foreach ($sh in $s.Shapes) {
    if ((Has-SlowText $sh $have) -and -not (Is-Interactive $s $sh)) {
      if (-not $cur) { $cur = New-Object System.Collections.ArrayList; [void]$runs.Add($cur) }
      [void]$cur.Add($sh.Name)
    } else { $cur = $null }
  }
  return ,$runs
}

function Find-Open($app, [string]$path) {
  foreach ($x in $app.Presentations) { if ($x.FullName -eq $path) { return $x } }
  throw "The copy is no longer open in PowerPoint: $path"
}

# 1. Copy the presentation (the original stays open, unchanged and unmarked) and open the copy
#    without a window. Returns the slides that have slow text, and how long the slowest one takes
#    to draw now. args: path, out.
function PPT-FastCopyBegin($a) {
  $app = Require-PPT
  $p = Find-Presentation $app $a.path
  $out = [string]$a.out
  if (Test-Path -LiteralPath $out) { throw "A file named $([IO.Path]::GetFileName($out)) already exists" }
  $wasSaved = $p.Saved
  $p.SaveCopyAs($out, 11, -1)            # same format, fonts stay embedded
  try { if ($p.Saved -ne $wasSaved) { $p.Saved = $wasSaved } } catch { }
  $q = $app.Presentations.Open($out, 0, 0, 0)
  try {
    $have = Get-AvailableFonts
    $slides = @(); $ids = @(); $most = 0; $heaviest = 0
    foreach ($s in $q.Slides) {
      $n = 0; foreach ($run in (Slow-Runs $s $have)) { $n += $run.Count }
      if ($n) { $slides += [int]$s.SlideIndex; $ids += [int]$s.SlideID; if ($n -gt $most) { $most = $n; $heaviest = [int]$s.SlideIndex } }
    }
    if (-not $slides.Count) { throw 'This presentation has no text that slows PowerPoint down; no copy is needed.' }
    $png = Join-Path ([IO.Path]::GetTempPath()) 'stagio-fastcopy-probe.png'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $q.Slides.Item($heaviest).Export($png, 'PNG', 640, 360)
    $ms = $sw.ElapsedMilliseconds
    Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
    return @{ out = $out; slides = [object[]]$slides; ids = [object[]]$ids; probe = $heaviest; probeId = [int]$q.Slides.Item($heaviest).SlideID; beforeMs = [int]$ms }
  } catch {
    try { $q.Close() } catch { }
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    throw
  }
}

# 2. One slide of the copy: each run of slow text becomes one transparent picture, exactly where
#    the text was. PowerPoint exports a group of shapes as a picture of their outline, which
#    depends on how far the text spills out; an invisible frame larger than the slide is exported
#    with them, so the picture is exactly that frame (96 dpi) and the slide area is cut out of it.
#    With verify, the slide is drawn before and after and must look the same (else: error).
#    args: out, slide, verify.
function PPT-FastCopySlide($a) {
  $app = Require-PPT
  $q = Find-Open $app ([string]$a.out)
  $s = $q.Slides.Item([int]$a.slide)
  $have = Get-AvailableFonts
  $W = [double]$q.PageSetup.SlideWidth; $H = [double]$q.PageSetup.SlideHeight
  $M = 300
  $dir = Join-Path ([IO.Path]::GetTempPath()) 'stagio-fastcopy'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $before = Join-Path $dir 'before.png'
  if ($a.verify) { $s.Export($before, 'PNG', 960, [int](960 * $H / $W)) }
  $pictures = 0
  $made = @()
  foreach ($run in (Slow-Runs $s $have)) {
    $key = Run-Key $s @($run)
    $depth = [int]$s.Shapes.Item($run[0]).ZOrderPosition
    $frame = $s.Shapes.AddShape(1, -$M, -$M, $W + 2 * $M, $H + 2 * $M)
    $frame.Fill.Visible = 0
    $frame.Line.Visible = 0
    $raw = Join-Path $dir 'raw.png'
    $png = Join-Path $dir ("slide{0}-{1}.png" -f $a.slide, $pictures)
    try {
      $s.Shapes.Range([object[]](@($run) + $frame.Name)).Export($raw, 2)
    } finally { $frame.Delete() }
    [Stagio.Thumbs]::CutSlide($raw, $png, $M, $W, $H)
    $pic = $s.Shapes.AddPicture($png, 0, -1, 0, 0, $W, $H)
    $pic.Name = 'Stagio: text as picture'
    $pic.AlternativeText = 'Decorative text, turned into a picture by Stagio so the slide shows quickly in PowerPoint for Windows.'
    while ([int]$pic.ZOrderPosition -gt $depth) { $pic.ZOrder(3) }   # send backward to where the text was
    $s.Shapes.Range([object[]]@($run)).Delete()
    Remove-Item -LiteralPath $raw -Force -ErrorAction SilentlyContinue
    if ($a.keep) {
      $kept = Join-Path ([string]$a.keep) ("{0}-{1}.png" -f [int]$s.SlideID, $pictures)
      Move-Item -LiteralPath $png -Destination $kept -Force
      $made += @{ names = [object[]]@($run); key = $key; png = $kept }
    } else { Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue }
    $pictures++
  }
  $result = @{ slide = [int]$a.slide; id = [int]$s.SlideID; pictures = $pictures; runs = [object[]]$made }
  if ($a.verify) {
    $after = Join-Path $dir 'after.png'
    $s.Export($after, 'PNG', 960, [int](960 * $H / $W))
    $changed = [Stagio.ImageCompare]::ChangedShare($before, $after, 40)
    Remove-Item -LiteralPath $before, $after -Force -ErrorAction SilentlyContinue
    $result.changed = [Math]::Round($changed, 5)
    if ($changed -gt 0.002) { throw ("Slide {0} would not look the same as a picture ({1:P2} of it changes). The copy was not kept." -f $a.slide, $changed) }
  }
  return $result
}

# 3. Save the copy (keep) or throw it away, and close it. With keep, also reports how long the
#    slide that was slowest takes to draw now. args: out, keep, probe.
function PPT-FastCopyEnd($a) {
  $app = Require-PPT
  $out = [string]$a.out
  $q = $null
  foreach ($x in $app.Presentations) { if ($x.FullName -eq $out) { $q = $x } }
  $ms = $null
  try {
    if ($q -and $a.keep) {
      if ($a.probe) {
        $png = Join-Path ([IO.Path]::GetTempPath()) 'stagio-fastcopy-probe.png'
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $q.Slides.Item([int]$a.probe).Export($png, 'PNG', 640, 360)
        $ms = [int]$sw.ElapsedMilliseconds
        Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
      }
      $q.Save()
    }
  } finally {
    if ($q) { if (-not $a.keep) { $q.Saved = -1 }; $q.Close() }
    if (-not $a.keep) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
  }
  return @{ out = $out; kept = [bool]$a.keep; afterMs = $ms; size = $(if ($a.keep -and (Test-Path -LiteralPath $out)) { (Get-Item -LiteralPath $out).Length } else { 0 }) }
}

# What a run of shapes says and where it is, as a short key: if a co-author changes or moves that
# text while the pictures are being made, the key no longer matches and that slide is left alone.
function Text-Of($sh) {
  try {
    if ([int]$sh.Type -eq 6) { return -join (@($sh.GroupItems) | ForEach-Object { Text-Of $_ }) }
    $where = '{0:N1},{1:N1},{2:N1},{3:N1}|' -f $sh.Left, $sh.Top, $sh.Width, $sh.Height
    if ([int]$sh.HasTextFrame -eq -1) { return $where + [string]$sh.TextFrame.TextRange.Text }
    return $where
  } catch { return '' }
}
function Run-Key($s, $names) {
  $text = -join (@($names) | ForEach-Object { Text-Of $s.Shapes.Item([string]$_) })
  $sha = [Security.Cryptography.SHA1]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').Substring(0, 16) }
  finally { $sha.Dispose() }
}

# A copy of the presentation as it is now (the open presentation is not changed or marked).
# A file on this PC with nothing unsaved is copied byte for byte; otherwise (unsaved edits, or a
# file opened from OneDrive/SharePoint) PowerPoint saves a copy of what is open. Refuses a
# presentation opened read-only: it couldn't be saved afterwards. args: path, out.
function PPT-BackupCopy($a) {
  $p = Find-Presentation (Require-PPT) $a.path
  if ([int]$p.ReadOnly -eq -1) { throw 'This presentation is open read-only, so it cannot be changed. Make a faster copy instead.' }
  $out = [string]$a.out
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($out)) | Out-Null
  $how = 'saved by PowerPoint'
  $file = [string]$p.FullName
  if ([int]$p.Saved -eq -1 -and $file -notmatch '^https?://' -and (Test-Path -LiteralPath $file)) {
    try { [IO.File]::Copy($file, $out, $false); $how = 'exact copy' } catch { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
  }
  if ($how -ne 'exact copy') {
    $wasSaved = $p.Saved
    $p.SaveCopyAs($out, 11, -1)
    try { if ($p.Saved -ne $wasSaved) { $p.Saved = $wasSaved } } catch { }
  }
  return @{ out = $out; how = $how; size = (Get-Item -LiteralPath $out).Length }
}

# Puts an earlier version (a backup kept on this PC) back in place of an open presentation. The
# caller has just saved the current version as a backup too, so closing it loses nothing.
#   - a file on this PC: closed, the earlier version copied over it, opened again;
#   - a shared file (web address): closed, the earlier version opened and saved over it.
# args: path, from. Returns the presentation's FullName afterwards.
function PPT-RestoreFile($a) {
  $app = Require-PPT
  $p = Find-Presentation $app $a.path
  $from = [string]$a.from
  if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw 'That earlier version is no longer on this PC' }
  foreach ($w in $app.SlideShowWindows) { if ($w.Presentation.FullName -eq $p.FullName) { throw 'Not during a slide show. End the show first.' } }
  if ([int]$p.ReadOnly -eq -1) { throw 'This presentation is open read-only, so it cannot be replaced.' }
  $file = [string]$p.FullName
  $p.Saved = -1
  $p.Close()
  Release-Com $p
  if ($file -notmatch '^https?://') {
    try { [IO.File]::Copy($from, $file, $true) }
    catch {
      $null = $app.Presentations.Open($file)
      throw "The file could not be replaced ($($_.Exception.Message)). It is open again as it was."
    }
    # A copied file keeps the backup's date; mark it as changed now.
    try { (Get-Item -LiteralPath $file).LastWriteTime = Get-Date } catch { }
    $q = $app.Presentations.Open($file)
    return [string]$q.FullName
  }
  $q = $app.Presentations.Open($from)
  try { $q.SaveAs($file) }
  catch { throw "The earlier version is open in PowerPoint, but it could not be saved over the shared file ($($_.Exception.Message)). Use File > Save As in PowerPoint to put it back." }
  return [string]$q.FullName
}

# Puts the pictures made on a copy (PPT-FastCopySlide with keep) into the original presentation:
# for each slide (found by its ID, wherever it is now) and each run of text, only if that text is
# still exactly what the picture was made from. Then saves it (with AutoSave on OneDrive or
# SharePoint, that reaches everyone sharing the file). args: path, slides [{ id, runs }], save.
function PPT-SpeedUpApply($a) {
  $p = Find-Presentation (Require-PPT) $a.path
  if ([int]$p.ReadOnly -eq -1) { throw 'This presentation is open read-only, so it cannot be changed.' }
  $W = [double]$p.PageSetup.SlideWidth; $H = [double]$p.PageSetup.SlideHeight
  $applied = 0; $pictures = 0; $skipped = @()
  foreach ($sl in @($a.slides)) {
    $s = $null
    try { $s = $p.Slides.FindBySlideID([int]$sl.id) } catch { }
    if (-not $s) { $skipped += [int]$sl.id; continue }              # deleted meanwhile
    $runs = @($sl.runs)
    $ok = $true
    foreach ($run in $runs) {
      try {
        foreach ($n in @($run.names)) { $null = $s.Shapes.Item([string]$n) }
        if ((Run-Key $s @($run.names)) -ne [string]$run.key) { $ok = $false }
      } catch { $ok = $false }
      if (-not (Test-Path -LiteralPath ([string]$run.png))) { $ok = $false }
    }
    if (-not $ok) { $skipped += [int]$s.SlideIndex; continue }       # someone changed that text meanwhile
    foreach ($run in $runs) {
      $names = [object[]]@($run.names)
      $depth = [int]$s.Shapes.Item([string]$names[0]).ZOrderPosition
      $pic = $s.Shapes.AddPicture([string]$run.png, 0, -1, 0, 0, $W, $H)
      $pic.Name = 'Stagio: text as picture'
      $pic.AlternativeText = 'Decorative text, turned into a picture by Stagio so the slide shows quickly in PowerPoint for Windows.'
      while ([int]$pic.ZOrderPosition -gt $depth) { $pic.ZOrder(3) }
      $s.Shapes.Range($names).Delete()
      $pictures++
    }
    $applied++
  }
  $saved = $false
  if ($a.save -and $applied) { $p.Save(); $saved = $true }
  return @{ applied = $applied; pictures = $pictures; skipped = [object[]]$skipped; saved = $saved }
}

# Slow text in an open presentation, read through PowerPoint: for files opened from OneDrive or
# SharePoint, whose path is a web address and can't be read from disk (see Deck-SlowText).
function PPT-SlowTextLive($a) {
  $p = Find-Presentation (Require-PPT) $a.path
  $have = Get-AvailableFonts
  $fonts = New-Object 'System.Collections.Generic.HashSet[string]'
  $scripts = New-Object 'System.Collections.Generic.HashSet[string]'
  $slides = 0; $chars = 0
  function Count-Slow($sh) {
    try {
      if ([int]$sh.Type -eq 6) { $n = 0; foreach ($g in $sh.GroupItems) { $n += Count-Slow $g }; return $n }
      if ([int]$sh.HasTextFrame -ne -1 -or [int]$sh.TextFrame.HasText -ne -1) { return 0 }
      $tr = $sh.TextFrame.TextRange
      $text = [string]$tr.Text
      $n = ([regex]::Matches($text, $script:complexScript)).Count
      if (-not $n) { return 0 }
      $cs = [string]$tr.Font.NameComplexScript
      if (-not $cs -or $have.Contains($cs)) { return 0 }
      [void]$fonts.Add($cs); [void]$scripts.Add((Script-Name $text))
      return $n
    } catch { return 0 }
  }
  foreach ($s in $p.Slides) {
    $here = 0
    foreach ($sh in $s.Shapes) { $here += Count-Slow $sh }
    if ($here) { $slides++; $chars += $here }
  }
  return @{ slides = $slides; total = [int]$p.Slides.Count; chars = $chars; fonts = [object[]]@($fonts); scripts = [object[]]@($scripts) }
}

function PPT-Open($a) {
  $path = [string]$a.path
  if ($path -notmatch '^https?://' -and -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "File not found: $path" }
  $app = Get-PPT
  if (-not $app) { $app = New-Object -ComObject PowerPoint.Application }
  $app.Visible = -1
  foreach ($p in $app.Presentations) {
    if ($p.FullName -eq $path) {
      # Opened ahead by the run of show (no window): opening it by hand gives it its window.
      if (-not $a.background -and $p.Windows.Count -eq 0) { [void]$p.NewWindow() }
      return $p.FullName
    }
  }
  # background: the run of show opens the next part's file while the current one is on the
  # projector. Without a window, PowerPoint doesn't come up over Stagio on this screen; its
  # slide show still starts as usual. Only while PowerPoint shows something else (a window or a
  # slide show): a PowerPoint started just for this, with nothing in a window, closes itself again
  # as soon as this helper lets go of it, taking the file with it.
  $shown = $app.SlideShowWindows.Count -gt 0
  if (-not $shown) { foreach ($x in $app.Presentations) { if ($x.Windows.Count -gt 0) { $shown = $true; break } } }
  if ($a.background -and $shown) { $p = $app.Presentations.Open($path, 0, 0, 0) } else { $p = $app.Presentations.Open($path) }
  return $p.FullName
}

# Run of show: the shows of other files end; the one of this file (just started) keeps running.
function PPT-EndOthers($a) {
  $app = Require-PPT
  $others = @()
  foreach ($w in $app.SlideShowWindows) { if ($w.Presentation.FullName -ne [string]$a.path) { $others += $w } }
  foreach ($w in $others) { try { $w.View.Exit() } catch { } }
  return $others.Count
}

function PPT-Start($a) {
  $app = Require-PPT
  $p = Find-Presentation $app $a.path
  if ($a.id) { $a.slide = $p.Slides.FindBySlideID([int]$a.id).SlideIndex }
  # PowerPoint keeps its "Slide Show > Monitor" choice in two values: UseMonMgr = 1 means
  # Automatic; UseMonMgr = 0 uses the display named in DisplayMonitor.
  $key = 'HKCU:\Software\Microsoft\Office\16.0\PowerPoint\Options'
  if ($a.monitor) {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'DisplayMonitor' -Value ([string]$a.monitor)
    Set-ItemProperty -Path $key -Name 'UseMonMgr' -Value 0 -Type DWord
  } elseif ($a.monitorAuto) {
    # The operator went back to "Automatic" after Stagio had picked a display.
    if (Test-Path $key) { Set-ItemProperty -Path $key -Name 'UseMonMgr' -Value 1 -Type DWord }
  }
  # With two screens PowerPoint puts its Presenter View on the operator's screen, on top of
  # Stagio. Stagio is the operator's view, so by default that is switched off ('off'); the
  # option under Output turns it back on ('on'). Setting it does not mark the deck as changed;
  # the Saved flag is restored anyway in case a PowerPoint version does.
  if ($a.presenterView -eq 'off' -or $a.presenterView -eq 'on') {
    try {
      $wasSaved = $p.Saved
      $p.SlideShowSettings.ShowPresenterView = $(if ($a.presenterView -eq 'off') { 0 } else { -1 })
      $p.Saved = $wasSaved
    } catch { }
  }
  # If a show of this presentation is already running, just jump.
  foreach ($w in $app.SlideShowWindows) {
    if ($w.Presentation.FullName -eq $p.FullName) {
      if ($a.slide) { $w.View.GotoSlide([int]$a.slide) }
      return $true
    }
  }
  $win = $p.SlideShowSettings.Run()
  if ($a.slide -and [int]$a.slide -gt 1) { $win.View.GotoSlide([int]$a.slide) }
  return $true
}

# Black/white screens are lifted before moving. "Paused" (2) is left alone: PowerPoint reports it
# whenever the show window isn't focused, and forcing it back to running re-renders the whole
# slide (about 2 s extra per slide change on heavy decks).
function Clear-BlackWhite($v) {
  $s = [int]$v.State
  if ($s -eq 3 -or $s -eq 4) { $v.State = 1 }
}

function PPT-SetState($name) {
  $v = Get-ShowView
  $map = @{ running = 1; black = 3; white = 4 }
  $target = $map[$name]
  if ($name -ne 'running' -and [int]$v.State -eq $target) { $target = 1 }  # toggle back
  $v.State = $target
  return $ppSlideShowStates[[int]$target]
}

# ---------------- Local music (Spotify app, no Premium needed) ----------------
# Uses Windows' media controls (the same ones the volume flyout uses) to read the track
# and play/pause/skip, and the app's own Volume Mixer slider for fades.

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $t = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  # Reading .Result of an unfinished task would block this helper for good.
  if (-not $t.Wait(5000)) { throw 'Windows media controls did not respond' }
  return $t.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$script:mediaMgr = $null
$script:artKey = ''
$script:art = $null
$script:artCount = 0
$script:asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

function Get-SpotifySession {
  if (-not $script:mediaMgr) {
    $script:mediaMgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  }
  foreach ($s in $script:mediaMgr.GetSessions()) { if ($s.SourceAppUserModelId -match 'spotify') { return $s } }
  return $null
}

function Music-State {
  $running = [bool](Get-Process -Name Spotify -ErrorAction SilentlyContinue)
  $s = $null
  if ($running) { $s = Get-SpotifySession }
  if (-not $s) { return @{ running = $running; session = $false; volume = [Stagio.AppVolume]::Get('Spotify') } }
  $status = [string]$s.GetPlaybackInfo().PlaybackStatus
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl = $s.GetTimelineProperties()
  $pos = $tl.Position.TotalMilliseconds
  if ($status -eq 'Playing') { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds }
  # Album art is written to a file once per track; the console loads it from /api/music/art.
  $key = "$($props.Title)|$($props.Artist)"
  if ($key -ne $script:artKey) {
    $script:artKey = $key
    $script:art = $null
    try {
      if ($props.Thumbnail) {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        # Called through reflection: PowerShell 5.1 can't convert the WinRT stream itself.
        $net = $script:asStream.Invoke($null, @($stream))
        $ms = New-Object IO.MemoryStream
        $net.CopyTo($ms)
        $script:artCount++
        $file = Join-Path $env:TEMP "stagio-art-$PID-$($script:artCount).img"
        [IO.File]::WriteAllBytes($file, $ms.ToArray())
        $old = Join-Path $env:TEMP "stagio-art-$PID-$($script:artCount - 1).img"
        Remove-Item $old -ErrorAction SilentlyContinue
        $script:art = $file
      }
    } catch { }
  }
  return @{
    running    = $true
    session    = $true
    isPlaying  = ($status -eq 'Playing')
    status     = $status
    title      = $props.Title
    artist     = $props.Artist
    album      = $props.AlbumTitle
    art        = $script:art
    positionMs = [int64][Math]::Max(0, $pos)
    durationMs = [int64]$tl.EndTime.TotalMilliseconds
    volume     = [Stagio.AppVolume]::Get('Spotify')
  }
}

function Music-Do($action) {
  $s = Get-SpotifySession
  if (-not $s) { throw 'Spotify is not available yet: play any track in the Spotify app once (pausing afterwards is fine)' }
  switch ($action) {
    'play'     { $op = $s.TryPlayAsync() }
    'pause'    { $op = $s.TryPauseAsync() }
    'toggle'   { $op = $s.TryTogglePlayPauseAsync() }
    'next'     { $op = $s.TrySkipNextAsync() }
    'previous' { $op = $s.TrySkipPreviousAsync() }
    default    { throw "Unknown action: $action" }
  }
  return (Await $op ([bool]))
}

function Music-Launch {
  if (Get-Process -Name Spotify -ErrorAction SilentlyContinue) { return 'running' }
  $exe = Join-Path $env:APPDATA 'Spotify\Spotify.exe'
  if (Test-Path $exe) { Start-Process $exe; return 'started' }
  $pkg = Get-AppxPackage -Name '*Spotify*' | Select-Object -First 1
  if ($pkg) { Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!Spotify"; return 'started' }
  throw 'Spotify is not installed on this PC'
}

# ---------------- Program feed (screen capture of the show window) ----------------
# Copies the slide-show window's pixels from the screen. It never calls into PowerPoint,
# so it costs the running show nothing, and it shows exactly what the audience sees.

$captureSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Stagio {
  static class Jpeg {
    static ImageCodecInfo codec;

    /// Saves through a temporary file, so a reader never sees a half-written image.
    public static void Save(Image img, string path, long quality) {
      if (codec == null) foreach (ImageCodecInfo ci in ImageCodecInfo.GetImageEncoders()) if (ci.MimeType == "image/jpeg") codec = ci;
      string tmp = path + ".tmp";
      using (EncoderParameters ep = new EncoderParameters(1)) {
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        img.Save(tmp, codec, ep);
      }
      if (File.Exists(path)) File.Delete(path);
      File.Move(tmp, path);
    }

    public static Bitmap Resize(Image src, int width, int height, InterpolationMode mode) {
      Bitmap b = new Bitmap(width, height, PixelFormat.Format24bppRgb);
      using (Graphics g = Graphics.FromImage(b)) {
        g.Clear(Color.White);
        g.InterpolationMode = mode;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        using (ImageAttributes wrap = new ImageAttributes()) {
          wrap.SetWrapMode(WrapMode.TileFlipXY); // no dark fringe at the edges
          g.DrawImage(src, new Rectangle(0, 0, width, height), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, wrap);
        }
      }
      return b;
    }
  }

  /// Turns the PNG PowerPoint exported into the two JPEGs the console uses, then deletes the PNG.
  public static class Thumbs {
    /// From a shape export framed by an invisible rectangle `margin` points outside the slide on
    /// every side, cuts out the slide area (keeping transparency) as a PNG.
    public static void CutSlide(string raw, string png, double margin, double slideW, double slideH) {
      using (Bitmap src = new Bitmap(raw)) {
        double sx = src.Width / (slideW + 2 * margin), sy = src.Height / (slideH + 2 * margin);
        int w = (int)Math.Round(slideW * sx), h = (int)Math.Round(slideH * sy);
        using (Bitmap cut = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
          using (Graphics g = Graphics.FromImage(cut)) {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(src, new Rectangle(0, 0, w, h), (float)(margin * sx), (float)(margin * sy), w, h, GraphicsUnit.Pixel);
          }
          cut.Save(png, ImageFormat.Png);
        }
      }
    }

    public static void Convert(string png, string large, string small, int smallWidth) {
      using (Image src = Image.FromFile(png)) {
        // The small file is written first: once the large one exists, both are complete.
        int h = Math.Max(1, smallWidth * src.Height / src.Width);
        using (Bitmap sm = Jpeg.Resize(src, smallWidth, h, InterpolationMode.HighQualityBicubic)) Jpeg.Save(sm, small, 80L);
        int lw = Math.Min(src.Width, 640), lh = Math.Max(1, lw * src.Height / src.Width);
        InterpolationMode mode = lw == src.Width ? InterpolationMode.NearestNeighbor : InterpolationMode.HighQualityBicubic;
        using (Bitmap lg = Jpeg.Resize(src, lw, lh, mode)) Jpeg.Save(lg, large, 85L);
      }
      File.Delete(png);
    }
  }

  public static class ImageCompare {
    static byte[] Gray(Bitmap b) {
      Rectangle r = new Rectangle(0, 0, b.Width, b.Height);
      using (Bitmap c = b.Clone(r, PixelFormat.Format24bppRgb)) {
        BitmapData d = c.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        byte[] row = new byte[d.Stride];
        byte[] g = new byte[b.Width * b.Height];
        for (int y = 0; y < b.Height; y++) {
          Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, d.Stride);
          for (int x = 0; x < b.Width; x++) g[y * b.Width + x] = (byte)((row[x * 3] + row[x * 3 + 1] + row[x * 3 + 2]) / 3);
        }
        c.UnlockBits(d);
        return g;
      }
    }

    /// Share of pixels whose brightness differs by more than `threshold` (0-255) between two
    /// images of the same size (1 if the sizes differ).
    public static double ChangedShare(string a, string b, int threshold) {
      using (Bitmap A = new Bitmap(a)) using (Bitmap B = new Bitmap(b)) {
        if (A.Width != B.Width || A.Height != B.Height) return 1;
        byte[] ga = Gray(A), gb = Gray(B);
        long diff = 0;
        for (int i = 0; i < ga.Length; i++) if (Math.Abs(ga[i] - gb[i]) > threshold) diff++;
        return ga.Length == 0 ? 0 : (double)diff / ga.Length;
      }
    }
  }

  public static class ShowCapture {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO lii);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

    static long IdleMs() {
      LASTINPUTINFO li = new LASTINPUTINFO();
      li.cbSize = (uint)Marshal.SizeOf(li);
      return GetLastInputInfo(ref li) ? (long)(uint)(Environment.TickCount - (int)li.dwTime) : 0;
    }

    /// "<process name of the foreground window>|<ms since the last keyboard/mouse input>".
    public static string Activity() {
      string name = "";
      try {
        IntPtr fg = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(fg, out pid);
        using (Process p = Process.GetProcessById((int)pid)) name = p.ProcessName;
      } catch { }
      return name + "|" + IdleMs();
    }

    static Bitmap Grab(RECT r) {
      Bitmap b = new Bitmap(r.R - r.L, r.B - r.T);
      using (Graphics g = Graphics.FromImage(b)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(r.R - r.L, r.B - r.T));
      return b;
    }

    /// Average brightness difference (0-255) between two frames, compared at 48x27.
    static double Difference(Bitmap a, Bitmap b) {
      using (Bitmap sa = Jpeg.Resize(a, 48, 27, InterpolationMode.HighQualityBilinear))
      using (Bitmap sb = Jpeg.Resize(b, 48, 27, InterpolationMode.HighQualityBilinear)) {
        double sum = 0;
        for (int y = 0; y < 27; y++) for (int x = 0; x < 48; x++) {
          Color ca = sa.GetPixel(x, y), cb = sb.GetPixel(x, y);
          sum += Math.Abs((ca.R + ca.G + ca.B) - (cb.R + cb.G + cb.B)) / 3.0;
        }
        return sum / (48 * 27);
      }
    }

    // A copy this different (0-255, see Difference) from PowerPoint's own image of the same slide
    // is not the slide: cut off, shifted, or something else on top. It is never kept.
    const double MISMATCH = 12;

    /// The slide's area inside a picture area w x h (a 4:3 slide on a 16:9 screen has black bars).
    static Rectangle SlideIn(int w, int h, double ratio) {
      int cw = w, ch = h;
      if (ratio > 0) { if ((double)w / h > ratio) cw = (int)Math.Round(h * ratio); else ch = (int)Math.Round(w / ratio); }
      cw = Math.Max(1, Math.Min(w, cw)); ch = Math.Max(1, Math.Min(h, ch));
      return new Rectangle((w - cw) / 2, (h - ch) / 2, cw, ch);
    }

    /// Difference between a copy and an image file of the same slide; -1 when there is no file.
    static double DifferenceFromFile(Bitmap slide, string path) {
      if (string.IsNullOrEmpty(path) || !File.Exists(path)) return -1;
      try { using (Bitmap r = new Bitmap(path)) return Difference(slide, r); } catch { return -1; }
    }

    static bool PerMonitorNow() {
      try { return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) == 2; } catch { return false; }
    }

    /// True if the screens don't all use the same scaling (or it can't be told).
    static bool MixedScaling() {
      uint first = 0; bool mixed = false;
      try {
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hm, IntPtr dc, ref RECT rc, IntPtr d) {
          uint dx = 96, dy = 96;
          GetDpiForMonitor(hm, 0, out dx, out dy);
          if (first == 0) first = dx; else if (dx != first) mixed = true;
          return true;
        }, IntPtr.Zero);
      } catch { return true; }
      return mixed;
    }

    /// Where the show's picture is, in real pixels of the screen it is on, and whether a copy of
    /// it can be trusted: "ok", "none" (no show window), "hidden" (minimised), "covered" (another
    /// window on top), or "geometry" (its position doesn't add up: rather no copy than a cut one).
    static string ShowArea(IntPtr h, out RECT area) {
      area = new RECT();
      if (h == IntPtr.Zero) return "none";
      if (IsIconic(h)) return "hidden";
      RECT cr;
      POINT o = new POINT();
      if (!GetClientRect(h, out cr) || !ClientToScreen(h, ref o)) return "none";
      if (cr.R < 64 || cr.B < 36) return "none";
      area.L = o.X; area.T = o.Y; area.R = o.X + cr.R; area.B = o.Y + cr.B;
      // With screens at different scaling, positions are only right in per-monitor mode.
      if (!PerMonitorNow() && MixedScaling()) return "geometry";
      // The picture must lie on the screen the window is on, as that screen reports itself.
      IntPtr m = MonitorFromWindow(h, 0);
      MONITORINFOEX mi = new MONITORINFOEX();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      if (m == IntPtr.Zero || !GetMonitorInfo(m, ref mi)) return "geometry";
      RECT s = mi.rcMonitor;
      if (area.L < s.L - 2 || area.T < s.T - 2 || area.R > s.R + 2 || area.B > s.B + 2) return "geometry";
      POINT c = new POINT(); c.X = (area.L + area.R) / 2; c.Y = (area.T + area.B) / 2;
      if (GetAncestor(WindowFromPoint(c), 2) != h) return "covered";
      return "ok";
    }

    static IntPtr ShowWindowOr(long hwnd) { return hwnd != 0 ? new IntPtr(hwnd) : FindShowWindow(); }

    /// Saves what the projector shows as a slide image (the same two JPEGs PowerPoint renders
    /// are turned into: <out>.s.jpg 256 px, <out>.jpg 640 px), cut to the slide's proportions.
    /// Two frames 400 ms apart must match, so a transition, a video or an animation still playing
    /// is never stored; and when PowerPoint's own image of the slide (refPath) exists, the copy
    /// must look like it. hwnd: a window to use instead of the show's (tests only).
    /// Returns "ok", "unstable", "pointer", "mismatch", or what ShowArea says.
    public static string CaptureSlide(string outBase, double ratio, string refPath, long hwnd) {
      IntPtr old = Physical();
      try { return CaptureSlideNow(outBase, ratio, refPath, ShowWindowOr(hwnd)); } finally { Restore(old); }
    }
    static string CaptureSlideNow(string outBase, double ratio, string refPath, IntPtr h) {
      RECT a;
      string why = ShowArea(h, out a);
      if (why != "ok") return why;
      // A moving pointer over the show brings up PowerPoint's show toolbar (and the pointer may
      // be a laser dot): wait until it is elsewhere or has been still for a few seconds.
      POINT cur;
      if (GetCursorPos(out cur) && cur.X >= a.L && cur.X < a.R && cur.Y >= a.T && cur.Y < a.B && IdleMs() < 4000) return "pointer";
      using (Bitmap first = Grab(a)) {
        System.Threading.Thread.Sleep(400);
        RECT a2;
        why = ShowArea(h, out a2);
        if (why != "ok") return why;
        if (a2.L != a.L || a2.T != a.T || a2.R != a.R || a2.B != a.B) return "unstable";
        using (Bitmap second = Grab(a)) {
          if (Difference(first, second) > 1.5) return "unstable";
          Rectangle s = SlideIn(a.R - a.L, a.B - a.T, ratio);
          using (Bitmap slide = second.Clone(s, second.PixelFormat)) {
            if (DifferenceFromFile(slide, refPath) > MISMATCH) return "mismatch";
            int lw = 640, lh = Math.Max(1, (int)Math.Round(640.0 * s.Height / s.Width));
            int sw = 256, sh = Math.Max(1, (int)Math.Round(256.0 * s.Height / s.Width));
            using (Bitmap sm = Jpeg.Resize(slide, sw, sh, InterpolationMode.HighQualityBicubic)) Jpeg.Save(sm, outBase + ".s.jpg", 80L);
            using (Bitmap lg = Jpeg.Resize(slide, lw, lh, InterpolationMode.HighQualityBicubic)) Jpeg.Save(lg, outBase + ".jpg", 85L);
          }
        }
      }
      return "ok";
    }

    /// For tests: how different the slide part of a window is from an image file (0-255), or a
    /// reason it couldn't be copied.
    public static string CompareWindow(long hwnd, double ratio, string refPath) {
      IntPtr old = Physical();
      try {
        RECT a;
        string why = ShowArea(new IntPtr(hwnd), out a);
        if (why != "ok") return why;
        using (Bitmap full = Grab(a))
        using (Bitmap slide = full.Clone(SlideIn(a.R - a.L, a.B - a.T, ratio), full.PixelFormat))
          return DifferenceFromFile(slide, refPath).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture);
      } finally { Restore(old); }
    }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);

    static bool dpiAware;

    // Captures work in real pixels of whichever screen the show is on. With two screens at
    // different scaling (e.g. a 125% laptop and a 100% projector), a program that is only
    // "system DPI aware" is given the show window's position and size scaled for the other
    // screen, so the copy came out shifted and cut off. Per-monitor awareness is switched on for
    // this thread only, for the length of one capture.
    static IntPtr Physical() {
      try {
        IntPtr old = SetThreadDpiAwarenessContext(new IntPtr(-4));           // per monitor v2 (Windows 10 1703+)
        if (old == IntPtr.Zero) old = SetThreadDpiAwarenessContext(new IntPtr(-3)); // per monitor
        if (old != IntPtr.Zero) return old;
      } catch (EntryPointNotFoundException) { }
      if (!dpiAware) { SetProcessDPIAware(); dpiAware = true; } // older Windows: the best there is
      return IntPtr.Zero;
    }
    static void Restore(IntPtr old) {
      if (old == IntPtr.Zero) return;
      try { SetThreadDpiAwarenessContext(old); } catch { }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    delegate bool MonitorProc(IntPtr h, IntPtr dc, ref RECT r, IntPtr d);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc f, IntPtr d);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFOEX mi);
    [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr h, int type, out uint x, out uint y);

    /// The screens in real pixels, one "device|x|y|width|height|scale %|primary(1/0)" per screen.
    public static string[] Monitors() {
      IntPtr old = Physical();
      try {
        List<string> list = new List<string>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr h, IntPtr dc, ref RECT rc, IntPtr d) {
          MONITORINFOEX mi = new MONITORINFOEX();
          mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
          if (!GetMonitorInfo(h, ref mi)) return true;
          uint dx = 96, dy = 96;
          try { GetDpiForMonitor(h, 0, out dx, out dy); } catch { }
          list.Add(string.Join("|", new string[] {
            mi.szDevice, mi.rcMonitor.L.ToString(), mi.rcMonitor.T.ToString(),
            (mi.rcMonitor.R - mi.rcMonitor.L).ToString(), (mi.rcMonitor.B - mi.rcMonitor.T).ToString(),
            ((int)Math.Round(dx * 100.0 / 96)).ToString(), (mi.dwFlags & 1) != 0 ? "1" : "0" }));
          return true;
        }, IntPtr.Zero);
        return list.ToArray();
      } finally { Restore(old); }
    }

    static IntPtr FindShowWindow() {
      HashSet<uint> pptPids = new HashSet<uint>();
      foreach (Process p in Process.GetProcessesByName("POWERPNT")) { pptPids.Add((uint)p.Id); p.Dispose(); }
      if (pptPids.Count == 0) return IntPtr.Zero;
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (!pptPids.Contains(pid) || !IsWindowVisible(h)) return true;
        StringBuilder sb = new StringBuilder(64);
        GetClassName(h, sb, 64);
        if (sb.ToString() == "screenClass") { found = h; return false; }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    /// The live PROGRAM picture: the show's slide (without the black bars a screen of another
    /// shape adds), at most `width` pixels wide. Returns "ok" or what ShowArea says.
    /// hwnd: a window to use instead of the show's (tests only).
    public static string Capture(string outPath, int width, double ratio, long hwnd) {
      IntPtr old = Physical();
      try { return CaptureNow(outPath, width, ratio, ShowWindowOr(hwnd)); } finally { Restore(old); }
    }
    static string CaptureNow(string outPath, int width, double ratio, IntPtr h) {
      RECT a;
      string why = ShowArea(h, out a);
      if (why != "ok") return why;
      using (Bitmap full = Grab(a)) {
        Rectangle s = SlideIn(a.R - a.L, a.B - a.T, ratio);
        using (Bitmap slide = full.Clone(s, full.PixelFormat)) {
          int ow = Math.Min(width, s.Width);
          int oh = Math.Max(1, (int)Math.Round((double)ow * s.Height / s.Width));
          using (Bitmap small = Jpeg.Resize(slide, ow, oh, InterpolationMode.HighQualityBilinear)) Jpeg.Save(small, outPath, 80L);
        }
      }
      return "ok";
    }
  }
}
'@
Add-CachedType 'capture' $captureSource @('System.Drawing')

# ---------------- Displays ----------------

function Display-List {
  $out = @()
  # Real resolution and scaling of each screen. (Screen.AllScreens in this process reports a
  # screen with other scaling than the main one at a made-up size.)
  try {
    foreach ($m in [Stagio.ShowCapture]::Monitors()) {
      $f = $m -split '\|'
      $out += @{ device = $f[0]; x = [int]$f[1]; y = [int]$f[2]; width = [int]$f[3]; height = [int]$f[4]; scale = [int]$f[5]; primary = ($f[6] -eq '1') }
    }
  } catch { $out = @() }
  if (-not $out.Count) {
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      $out += @{ device = $s.DeviceName; primary = $s.Primary; width = $s.Bounds.Width; height = $s.Bounds.Height; x = $s.Bounds.X; y = $s.Bounds.Y }
    }
  }
  $current = $null
  try { $current = (Get-ItemProperty 'HKCU:\Software\Microsoft\Office\16.0\PowerPoint\Options' -Name DisplayMonitor -ErrorAction Stop).DisplayMonitor } catch { }
  return @{ screens = $out; pptMonitor = $current }
}

# ---------------- Stagio's own Wi-Fi ----------------
# When phones can't reach this PC over the venue's Wi-Fi (no Wi-Fi, a guest network, or "AP
# isolation" keeping devices apart), Stagio opens a small Wi-Fi network of its own: Wi-Fi Direct
# in "legacy" mode, an ordinary network any phone can join with a password. It lasts while this
# helper runs it. The PC keeps its normal connection too where the Wi-Fi card allows both.

$script:wifiPub = $null

function OwnWifi-Ip {
  foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($ni.Description -notmatch 'Wi-?Fi Direct' -or [string]$ni.OperationalStatus -ne 'Up') { continue }
    foreach ($u in $ni.GetIPProperties().UnicastAddresses) {
      $ip = $u.Address.ToString()
      if ($u.Address.AddressFamily -eq 'InterNetwork' -and -not $ip.StartsWith('169.254.')) { return $ip }
    }
  }
  return $null
}

function OwnWifi-Stop {
  if ($script:wifiPub) { try { $script:wifiPub.Stop() } catch { }; $script:wifiPub = $null }
  return $true
}

function OwnWifi-State {
  $on = [bool]($script:wifiPub -and [string]$script:wifiPub.Status -eq 'Started')
  return @{ on = $on; ip = $(if ($on) { OwnWifi-Ip } else { $null }) }
}

function OwnWifi-Start($a) {
  $null = [Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher, Windows.Devices.WiFiDirect, ContentType = WindowsRuntime]
  $null = [Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]
  OwnWifi-Stop | Out-Null
  $pub = New-Object Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher
  $pub.Advertisement.IsAutonomousGroupOwnerEnabled = $true
  $leg = $pub.Advertisement.LegacySettings
  $leg.IsEnabled = $true
  $leg.Ssid = [string]$a.ssid
  $cred = New-Object Windows.Security.Credentials.PasswordCredential
  $cred.Password = [string]$a.pass
  $leg.Passphrase = $cred
  $pub.Start()
  $script:wifiPub = $pub
  # Up within a few seconds, with its own address (usually 192.168.137.1).
  for ($i = 0; $i -lt 48; $i++) {
    Start-Sleep -Milliseconds 250
    if ([string]$pub.Status -eq 'Aborted') {
      $script:wifiPub = $null
      throw 'Windows could not open the network. Check that Wi-Fi is switched on; some Wi-Fi cards cannot host a network.'
    }
    $ip = OwnWifi-Ip
    if ([string]$pub.Status -eq 'Started' -and $ip) { return @{ on = $true; ip = $ip } }
  }
  return OwnWifi-State
}

# ---------------- Bluetooth remote ----------------
# For Android phones when no Wi-Fi works at all: the phone opens Stagio's remote page (https, so
# Chrome allows Bluetooth; it works offline once visited) and talks to this PC over Bluetooth Low
# Energy. This PC is the "peripheral": a GATT service with
#   command (phone writes): {"pin":"123456","c":"next"}            -> queued for Stagio (ble.take)
#   state   (phone reads, notified on change): small JSON           <- set by Stagio (ble.publish)
#   cues    (phone reads): JSON list of cue names                   <- set by Stagio (ble.publish)
# Compiled with the .NET compiler against Windows' metadata (Add-Type can't reference .winmd files),
# and without System.Runtime.WindowsRuntime (it needs a metadata file only the Windows SDK has):
# async calls are awaited by polling their status.

$bleSource = @'
using System;
using System.Collections.Generic;
using System.Text;
using Windows.Foundation;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

namespace StagioBle {
  public static class Server {
    public static readonly Guid ServiceId = new Guid("6f6e6564-6573-6b00-0000-000000000001");
    static readonly Guid CommandId = new Guid("6f6e6564-6573-6b00-0000-000000000002");
    static readonly Guid StateId = new Guid("6f6e6564-6573-6b00-0000-000000000003");
    static readonly Guid CuesId = new Guid("6f6e6564-6573-6b00-0000-000000000004");

    static readonly object gate = new object();
    static GattServiceProvider provider;
    static GattLocalCharacteristic stateChar;
    static byte[] state = new byte[0], cues = Encoding.UTF8.GetBytes("[]");
    static readonly Queue<string> inbox = new Queue<string>();
    public static string LastError = "";

    static T Wait<T>(IAsyncOperation<T> op) {
      System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
      while (op.Status == AsyncStatus.Started) {
        if (sw.ElapsedMilliseconds > 10000) throw new TimeoutException("Bluetooth did not answer");
        System.Threading.Thread.Sleep(5);
      }
      if (op.Status != AsyncStatus.Completed) throw new Exception("Bluetooth: " + (op.ErrorCode != null ? op.ErrorCode.Message : op.Status.ToString()));
      return op.GetResults();
    }
    static IBuffer Buffer(byte[] b) { DataWriter w = new DataWriter(); w.WriteBytes(b); return w.DetachBuffer(); }
    static byte[] Bytes(IBuffer buf) { byte[] b = new byte[buf.Length]; DataReader.FromBuffer(buf).ReadBytes(b); return b; }

    static GattLocalCharacteristic Characteristic(Guid id, GattCharacteristicProperties props, string description) {
      GattLocalCharacteristicParameters p = new GattLocalCharacteristicParameters();
      p.CharacteristicProperties = props;
      p.ReadProtectionLevel = GattProtectionLevel.Plain;
      p.WriteProtectionLevel = GattProtectionLevel.Plain;
      p.UserDescription = description;
      GattLocalCharacteristicResult r = Wait(provider.Service.CreateCharacteristicAsync(id, p));
      if (r.Error != BluetoothError.Success) throw new Exception("Bluetooth: " + r.Error);
      return r.Characteristic;
    }

    /// Starts the service and advertising; returns the advertising status.
    public static string Start() {
      lock (gate) {
        if (provider != null) return provider.AdvertisementStatus.ToString();
        BluetoothAdapter a = Wait(BluetoothAdapter.GetDefaultAsync());
        if (a == null) throw new Exception("This PC has no Bluetooth (or it is switched off)");
        if (!a.IsPeripheralRoleSupported) throw new Exception("This PC's Bluetooth can't accept connections from phones");
        GattServiceProviderResult pr = Wait(GattServiceProvider.CreateAsync(ServiceId));
        if (pr.Error != BluetoothError.Success) throw new Exception("Bluetooth: " + pr.Error + " (is Bluetooth switched on?)");
        provider = pr.ServiceProvider;
        GattLocalCharacteristic cmd = Characteristic(CommandId, GattCharacteristicProperties.Write | GattCharacteristicProperties.WriteWithoutResponse, "command");
        stateChar = Characteristic(StateId, GattCharacteristicProperties.Read | GattCharacteristicProperties.Notify, "state");
        GattLocalCharacteristic cueChar = Characteristic(CuesId, GattCharacteristicProperties.Read, "cues");
        cmd.WriteRequested += OnWrite;
        stateChar.ReadRequested += (s, e) => Respond(e, () => state);
        cueChar.ReadRequested += (s, e) => Respond(e, () => cues);
        GattServiceProviderAdvertisingParameters ap = new GattServiceProviderAdvertisingParameters();
        ap.IsConnectable = true;
        ap.IsDiscoverable = true;
        provider.StartAdvertising(ap);
        // It reports "Aborted" for a moment before "Started".
        for (int i = 0; i < 40 && provider.AdvertisementStatus != GattServiceProviderAdvertisementStatus.Started; i++) System.Threading.Thread.Sleep(100);
        return provider.AdvertisementStatus.ToString();
      }
    }

    public static void Stop() {
      lock (gate) {
        if (provider == null) return;
        try { provider.StopAdvertising(); } catch { }
        provider = null; stateChar = null;
        inbox.Clear();
      }
    }

    /// "off" or "<advertising status>|<phones subscribed to the state>".
    public static string Status() {
      lock (gate) {
        if (provider == null) return "off";
        int n = 0; try { n = stateChar.SubscribedClients.Count; } catch { }
        return provider.AdvertisementStatus + "|" + n;
      }
    }

    static void OnWrite(GattLocalCharacteristic sender, GattWriteRequestedEventArgs e) {
      Deferral d = e.GetDeferral();
      try {
        GattWriteRequest req = Wait(e.GetRequestAsync());
        string text = Encoding.UTF8.GetString(Bytes(req.Value));
        lock (gate) { if (inbox.Count < 200) inbox.Enqueue(e.Session.DeviceId.Id + "\t" + text); }
        if (req.Option == GattWriteOption.WriteWithResponse) req.Respond();
      } catch (Exception ex) { LastError = ex.Message; } finally { d.Complete(); }
    }

    static void Respond(GattReadRequestedEventArgs e, Func<byte[]> value) {
      Deferral d = e.GetDeferral();
      try {
        GattReadRequest req = Wait(e.GetRequestAsync());
        byte[] all; lock (gate) all = value();
        int off = (int)Math.Min(req.Offset, (uint)all.Length);            // long reads come in pieces
        byte[] part = new byte[all.Length - off];
        Array.Copy(all, off, part, 0, part.Length);
        req.RespondWithValue(Buffer(part));
      } catch (Exception ex) { LastError = ex.Message; } finally { d.Complete(); }
    }

    /// Commands written by phones since the last call: "<phone id>\t<json>" each.
    public static string[] Take() { lock (gate) { string[] a = inbox.ToArray(); inbox.Clear(); return a; } }

    /// New state for the phones (notified to those listening), and the cue names.
    public static int Publish(string stateJson, string cuesJson) {
      GattLocalCharacteristic c;
      byte[] b = Encoding.UTF8.GetBytes(stateJson ?? "");
      lock (gate) {
        state = b;
        if (cuesJson != null) cues = Encoding.UTF8.GetBytes(cuesJson);
        c = stateChar;
      }
      if (c == null) return 0;
      try { c.NotifyValueAsync(Buffer(b)); return c.SubscribedClients.Count; } catch (Exception ex) { LastError = ex.Message; return 0; }
    }
  }
}
'@

# Compiles $bleSource on first use with the .NET compiler (cached like Add-CachedType).
function Load-Ble {
  if ($script:bleLoaded) { return }
  $fw = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $wm = Join-Path $env:SystemRoot 'System32\WinMetadata'
  $dir = Join-Path $env:LOCALAPPDATA 'Stagio\types'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($bleSource))) -replace '-', '').Substring(0, 16)
  $dll = Join-Path $dir "ble-$hash.dll"
  if (-not (Test-Path $dll)) {
    $src = Join-Path $dir "ble-$hash.$PID.cs"
    $tmp = Join-Path $dir "ble-$hash.$PID.dll"
    [IO.File]::WriteAllText($src, $bleSource, (New-Object Text.UTF8Encoding $false))
    $refs = @('Windows.Foundation.winmd', 'Windows.Devices.winmd', 'Windows.Storage.winmd') | ForEach-Object { "/r:$(Join-Path $wm $_)" }
    $refs += @('System.Runtime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll', 'System.Threading.Tasks.dll') | ForEach-Object { "/r:$(Join-Path $fw $_)" }
    $out = & (Join-Path $fw 'csc.exe') /nologo /target:library "/out:$tmp" @refs $src 2>&1
    Remove-Item -LiteralPath $src -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE) { throw "Bluetooth part could not be compiled: $($out | Select-Object -First 3)" }
    try { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop } catch { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
  Add-Type -Path $dll
  $script:bleLoaded = $true
}

# ---------------- Dispatcher ----------------

function Invoke-Command2($cmd, $a) {
  switch ($cmd) {
    'ping'          { return 'pong' }
    # Used by test/checks.js to prove that commands stuck behind a slow one are dropped, not run late.
    'debug.sleep'   { Start-Sleep -Milliseconds ([int]$a.ms); return $true }
    'debug.mark'    { $script:marks++; return $script:marks }
    'ppt.state'     { return PPT-State }
    'ppt.enableEditing' { return PPT-EnableEditing }
    'ppt.slides'    { return PPT-Slides $a }
    'ppt.thumb'     { return PPT-Thumb $a }
    'ppt.thumbsPdf' { return PPT-ThumbsPdf $a }
    'ppt.fastCopyBegin' { return PPT-FastCopyBegin $a }
    'ppt.fastCopySlide' { return PPT-FastCopySlide $a }
    'ppt.fastCopyEnd'   { return PPT-FastCopyEnd $a }
    'ppt.backupCopy'    { return PPT-BackupCopy $a }
    'ppt.restoreFile'   { return PPT-RestoreFile $a }
    'ppt.speedUpApply'  { return PPT-SpeedUpApply $a }
    'ppt.slowTextLive'  { return PPT-SlowTextLive $a }
    'ppt.closeQuiet'    { $q = Find-Presentation (Require-PPT) $a.path; $q.Saved = -1; $q.Close(); return $true }   # a leftover work copy
    'deck.slowText' { return Deck-SlowText $a }
    'ppt.fonts'     { return PPT-Fonts $a }
    'ppt.open'      { return PPT-Open $a }
    'ppt.start'     { return PPT-Start $a }
    'ppt.end'       { (Get-ShowView).Exit(); return $true }
    'ppt.endOthers' { return PPT-EndOthers $a }
    'ppt.next'      {
      $v = Get-ShowView
      # Past the last slide PowerPoint shows its black "end of show" screen, and one more Next
      # would exit the show and put the desktop on the projector. Stay on the end screen instead.
      if ([int]$v.State -eq 5) { return 'end' }
      Clear-BlackWhite $v
      $v.Next()
      return $true
    }
    'ppt.prev'      { $v = Get-ShowView; Clear-BlackWhite $v; $v.Previous(); return $true }
    'ppt.goto'      {
      $v = Get-ShowView; Clear-BlackWhite $v
      # By slide ID when given: the number the console knows may be stale if slides were just
      # added or removed, the ID is not.
      $n = [int]$a.slide
      if ($a.id) { $n = (Require-PPT).SlideShowWindows.Item(1).Presentation.Slides.FindBySlideID([int]$a.id).SlideIndex }
      $v.GotoSlide($n)
      return $n
    }
    'ppt.setState'  { return PPT-SetState $a.state }
    'audio.state'   {
      $devs = @([Stagio.Audio]::List() | ForEach-Object { @{ id = $_.Id; name = $_.Name; isDefault = $_.IsDefault } })
      $vol = $null; $mute = $null
      try { $vol = [Stagio.Audio]::GetVolume(); $mute = [Stagio.Audio]::GetMute() } catch { }
      return @{ devices = $devs; volume = $vol; mute = $mute }
    }
    'audio.setDefault' { [Stagio.Audio]::SetDefault([string]$a.id); return $true }
    'audio.volume'  {
      if ($a.glideMs) { [Stagio.Audio]::GlideVolume([int]$a.value, [int]$a.glideMs) } else { [Stagio.Audio]::SetVolume([int]$a.value) }
      return $true
    }
    'audio.mute'    { [Stagio.Audio]::SetMute([bool]$a.mute); return $true }
    'display.list'  { return Display-List }
    'wifi.start'    { return OwnWifi-Start $a }
    'wifi.stop'     { return OwnWifi-Stop }
    'wifi.state'    { return OwnWifi-State }
    'ble.start'     { Load-Ble; return [StagioBle.Server]::Start() }
    'ble.stop'      { if ($script:bleLoaded) { [StagioBle.Server]::Stop() }; return $true }
    'ble.status'    { if (-not $script:bleLoaded) { return 'off' }; return [StagioBle.Server]::Status() }
    'ble.take'      { if (-not $script:bleLoaded) { return @() }; return [object[]][StagioBle.Server]::Take() }
    'ble.publish'   { if (-not $script:bleLoaded) { return 0 }; return [StagioBle.Server]::Publish([string]$a.state, $(if ($null -ne $a.cues) { [string]$a.cues } else { $null })) }
    'show.capture'  { return [Stagio.ShowCapture]::Capture([string]$a.out, [int]$(if ($a.width) { $a.width } else { 960 }), [double]$a.ratio, [long]$a.hwnd) }
    'show.captureSlide' { return [Stagio.ShowCapture]::CaptureSlide([string]$a.out, [double]$a.ratio, [string]$a.ref, [long]$a.hwnd) }
    'show.compareWindow' { return [Stagio.ShowCapture]::CompareWindow([long]$a.hwnd, [double]$a.ratio, [string]$a.ref) }   # tests
    'sys.activity'  { $x = [Stagio.ShowCapture]::Activity() -split '\|'; return @{ app = $x[0]; idleMs = [long]$x[1] } }
    'music.state'   { return Music-State }
    'music.do'      { return Music-Do $a.action }
    'music.launch'  { return Music-Launch }
    'music.volume'  {
      # glideMs: a short glide instead of a jump (a jump of the level clicks while music plays)
      if ($a.glideMs) {
        $id = [Stagio.AppVolume]::StartFade('Spotify', -1, [int]$a.value, [int]$a.glideMs)
        if ($id) { return 1 }
      }
      return [Stagio.AppVolume]::Set('Spotify', [int]$a.value)
    }
    'music.fade'        { return [Stagio.AppVolume]::StartFade('Spotify', [int]$(if ($null -ne $a.from) { $a.from } else { -1 }), [int]$a.to, [int]$a.ms) }
    'music.fadeStop'    { [Stagio.AppVolume]::StopFade([int]$a.id); return $true }
    'music.fadeStatus'  { $x = [Stagio.AppVolume]::FadeStatus([int]$a.id) -split '\|'; return @{ state = $x[0]; level = [int]$x[1] } }
    'music.silenceWhenReady' { return [Stagio.AppVolume]::SilenceWhenReady('Spotify', [int]$a.ms) }
    default         { throw "Unknown command: $cmd" }
  }
}

$script:marks = 0
$gcClock = [Diagnostics.Stopwatch]::StartNew()

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim([char]0xFEFF, ' ', "`t")
  if (-not $line) { continue }
  $id = $null
  $cmd = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $cmd = [string]$req.cmd
    # Commands wait in line while PowerPoint is busy. One that waited past its deadline has already
    # been reported to the operator as timed out, so it is dropped: running it late would, for
    # example, skip several slides at once when PowerPoint wakes up.
    if ($req.exp -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [int64]$req.exp) {
      throw 'Skipped: it waited too long behind a busy PowerPoint'
    }
    $data = Invoke-Command2 $cmd $req.args
    $resp = @{ id = $id; ok = $true; data = $data }
  } catch {
    $resp = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $resp -Compress -Depth 8))
  [Console]::Out.Flush()
  # PowerPoint objects are released right after every PowerPoint command, so PowerPoint can quit
  # normally when the user closes it. A full collection costs about 25 ms, so the frequent
  # non-PowerPoint commands (volume steps of a fade, screen capture) only get one now and then.
  if ($cmd.StartsWith('ppt.') -or $gcClock.ElapsedMilliseconds -gt 10000) {
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    $gcClock.Restart()
  }
}
