export type EngineStatus =
  | "unsupported"
  | "setup"
  | "installing"
  | "starting"
  | "ready"
  | "connected"
  | "expired"
  | "error";

export interface Station {
  id: string;
  name: string;
  url: string;
  favicon: string | null;
  homepage: string | null;
  country: string;
  countryCode: string;
  tags: string[];
  codec: string;
  bitrate: number;
}

export interface Track {
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  durationMs: number;
}

export interface SpeakerState {
  status: EngineStatus;
  message: string;
  progress: string;
  playing: boolean;
  track: Track | null;
  context: string;
  volume: number | null;
  position: { ms: number; at: number; speed: number } | null;
  settings: { name: string; volume: number; openAtLogin: boolean };
  soloist: { version: string | null; buildDate: string | null; daysLeft: number | null };
  hasApiKey: boolean;
  update: {
    supported: boolean;
    status: "idle" | "checking" | "downloading" | "ready" | "available" | "current" | "error";
    version: string | null;
    percent: number;
    error: string;
    canInstall: boolean;
  };
  source: "spotify" | "airplay" | "radio" | null;
  radio: {
    station: Station | null;
    status: "idle" | "buffering" | "playing" | "paused" | "error";
    favorites: Station[];
    recent: Station[];
  };
  remote: { enabled: boolean; url: string | null; qr: string | null };
  airplay: { supported: boolean; enabled: boolean; running: boolean };
  packaged: boolean;
  platform: string;
  version: string;
}

type Result = { ok: true } | { ok: false; error: string };

declare global {
  interface Window {
    speaker: {
      getState(): Promise<SpeakerState>;
      onState(callback: (state: SpeakerState) => void): () => void;
      command(command: "play" | "pause" | "next" | "prev" | "disconnect"): Promise<void>;
      setVolume(percent: number): Promise<void>;
      seek(ms: number): Promise<void>;
      setup(input: { apiKey: string; name: string; consent: boolean }): Promise<Result>;
      saveSettings(settings: {
        name: string;
        openAtLogin?: boolean;
        apiKey?: string;
        airplay?: boolean;
        remote?: boolean;
      }): Promise<Result>;
      radioBrowse(query: { q?: string; tag?: string }): Promise<{ ok: boolean; error?: string; stations: Station[] }>;
      radioPlay(station: Station): Promise<Result>;
      radioStop(): Promise<void>;
      radioFavorite(station: Station, on: boolean): Promise<void>;
      openAirPlaySettings(): Promise<void>;
      checkUpdates(): Promise<string>;
      appUpdateCheck(): Promise<void>;
      appUpdateInstall(): Promise<void>;
      copyLogs(): Promise<void>;
    };
  }
}
