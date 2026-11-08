export type EngineStatus = "starting" | "ready" | "connecting" | "connected" | "offline" | "error";

export interface Track {
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  durationMs: number;
}

export interface SpeakerSettings {
  name: string;
  output: string;
  bitrate: "96" | "160" | "320";
  volume: number;
  normalize: boolean;
  openAtLogin: boolean;
}

export interface SpeakerState {
  status: EngineStatus;
  message: string;
  client: string;
  playing: boolean;
  track: Track | null;
  volume: number | null;
  settings: SpeakerSettings;
  packaged: boolean;
  version: string;
}

export interface Outputs {
  default: string | null;
  outputs: string[];
}

declare global {
  interface Window {
    speaker: {
      getState(): Promise<SpeakerState>;
      onState(callback: (state: SpeakerState) => void): () => void;
      listOutputs(): Promise<Outputs>;
      command(command: "play" | "pause" | "next" | "prev" | "disconnect"): Promise<void>;
      setVolume(percent: number): Promise<void>;
      saveSettings(
        settings: Omit<SpeakerSettings, "volume">,
      ): Promise<{ ok: true } | { ok: false; error: string }>;
      copyLogs(): Promise<void>;
    };
  }
}
