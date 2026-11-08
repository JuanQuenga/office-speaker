export type EngineStatus =
  | "unsupported"
  | "setup"
  | "installing"
  | "starting"
  | "ready"
  | "connected"
  | "expired"
  | "error";

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
      saveSettings(settings: { name: string; openAtLogin: boolean; apiKey?: string }): Promise<Result>;
      checkUpdates(): Promise<string>;
      copyLogs(): Promise<void>;
    };
  }
}
