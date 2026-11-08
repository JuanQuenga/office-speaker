import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  Copy01Icon,
  MusicNote03Icon,
  NextIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  PreviousIcon,
  SmartPhone01Icon,
  Speaker01Icon,
  Unlink04Icon,
  VolumeHighIcon,
  VolumeLowIcon,
  Wifi01Icon,
} from "@hugeicons/core-free-icons";

import appIcon from "./app-icon.png";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { EngineStatus, Outputs, SpeakerSettings, SpeakerState } from "./speaker";

type Form = Omit<SpeakerSettings, "volume">;

const STATUS: Record<EngineStatus, { label: string; tone: string }> = {
  starting: { label: "Starting", tone: "bg-amber-500" },
  ready: { label: "Ready", tone: "bg-primary" },
  connecting: { label: "Connecting", tone: "bg-amber-500" },
  connected: { label: "Playing", tone: "bg-primary" },
  offline: { label: "No network", tone: "bg-amber-500" },
  error: { label: "Problem", tone: "bg-destructive" },
};

// Base UI Select values can't be empty strings, so "system default" gets a sentinel.
const DEFAULT_OUTPUT = "__system_default__";

const QUALITY = [
  { value: "320", label: "High · 320 kbps" },
  { value: "160", label: "Normal · 160 kbps" },
  { value: "96", label: "Low · 96 kbps" },
];

const RENAME_EVENT = "office-speaker:rename";

function Icon({ icon, className }: { icon: IconSvgElement; className?: string }) {
  return <HugeiconsIcon icon={icon} strokeWidth={2} className={className} />;
}

export function App() {
  const [state, setState] = useState<SpeakerState | null>(null);

  useEffect(() => {
    const off = window.speaker.onState(setState);
    window.speaker.getState().then(setState);
    return off;
  }, []);

  if (!state) return null;
  const connected = state.status === "connected" || (state.status === "connecting" && !!state.track);

  return (
    <div className="flex h-screen flex-col">
      <TopBar state={state} />
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] gap-4 p-4">
        <section className="flex min-h-0 flex-col gap-3">
          {state.message && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <Icon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
              <p>{state.message}</p>
            </div>
          )}
          {connected ? <NowPlaying state={state} /> : <Waiting state={state} />}
        </section>
        <Settings state={state} />
      </main>
    </div>
  );
}

function TopBar({ state }: { state: SpeakerState }) {
  const status = STATUS[state.status];
  const label = state.status === "connected" && !state.playing ? "Paused" : status.label;
  const [copied, setCopied] = useState(false);
  return (
    <header className="flex items-center gap-3 border-b bg-background px-4 py-2.5">
      <img src={appIcon} alt="" className="size-8" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="font-heading text-sm font-semibold">Office Speaker</h1>
        <span className="truncate text-xs text-muted-foreground">Spotify Connect speaker · v{state.version}</span>
      </div>
      <Badge variant="outline" className="gap-1.5">
        <span className={cn("size-1.5 rounded-full", status.tone)} />
        {label}
      </Badge>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          await window.speaker.copyLogs();
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon icon={Copy01Icon} />
        {copied ? "Copied" : "Copy logs"}
      </Button>
    </header>
  );
}

function Step({ icon, title, children }: { icon: IconSvgElement; title: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border bg-muted/30 p-3">
      <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon icon={icon} className="size-4" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
    </li>
  );
}

function Waiting({ state }: { state: SpeakerState }) {
  const name = state.settings.name;
  return (
    <Card className="flex-1 justify-between">
      <CardContent className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="relative grid size-20 place-items-center rounded-2xl bg-primary/10 text-primary">
          {state.status === "ready" && (
            <span className="absolute inset-0 animate-ping rounded-2xl bg-primary/10 [animation-duration:2.5s]" />
          )}
          <Icon icon={Speaker01Icon} className="size-9" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Visible in Spotify as</p>
          <p className="font-heading text-3xl font-semibold tracking-tight break-words">{name}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event(RENAME_EVENT))}>
          <Icon icon={PencilEdit02Icon} />
          Rename
        </Button>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <ol className="grid grid-cols-3 gap-3">
          <Step icon={Wifi01Icon} title="Same Wi-Fi">
            Your phone needs to be on this computer's network.
          </Step>
          <Step icon={SmartPhone01Icon} title="Open Spotify">
            Tap the devices icon below what's playing.
          </Step>
          <Step icon={Speaker01Icon} title={`Pick “${name}”`}>
            Music plays here. Nobody signs in on this computer.
          </Step>
        </ol>
        <p className="text-center text-xs text-muted-foreground">
          Needs Spotify Premium. Whoever picks the speaker last takes over.
        </p>
      </CardFooter>
    </Card>
  );
}

function NowPlaying({ state }: { state: SpeakerState }) {
  const track = state.track;
  const [volume, setVolume] = useState(state.volume ?? state.settings.volume);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current && typeof state.volume === "number") setVolume(state.volume);
  }, [state.volume]);

  return (
    <Card className="flex-1 justify-between">
      <CardContent className="flex flex-1 items-center gap-6">
        {track?.cover ? (
          <img src={track.cover} alt="" className="aspect-square w-[42%] max-w-64 shrink-0 rounded-xl object-cover shadow-md" />
        ) : (
          <div className="grid aspect-square w-[42%] max-w-64 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
            <Icon icon={MusicNote03Icon} className="size-12" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Now playing</p>
            <p className="mt-1 line-clamp-2 font-heading text-2xl font-semibold tracking-tight">
              {track?.title ?? "Nothing playing yet"}
            </p>
            {track && <p className="mt-0.5 truncate text-sm text-muted-foreground">{track.artist}</p>}
            {track?.album && <p className="truncate text-sm text-muted-foreground">{track.album}</p>}
            {state.client && (
              <Badge variant="secondary" className="mt-3 max-w-full">
                <Icon icon={SmartPhone01Icon} />
                <span className="truncate">From {state.client}</span>
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-lg" aria-label="Previous track" onClick={() => window.speaker.command("prev")}>
              <Icon icon={PreviousIcon} className="size-5" />
            </Button>
            <Button
              size="icon-lg"
              className="size-12 rounded-full"
              aria-label={state.playing ? "Pause" : "Play"}
              onClick={() => window.speaker.command(state.playing ? "pause" : "play")}
            >
              <Icon icon={state.playing ? PauseIcon : PlayIcon} className="size-5" />
            </Button>
            <Button variant="ghost" size="icon-lg" aria-label="Next track" onClick={() => window.speaker.command("next")}>
              <Icon icon={NextIcon} className="size-5" />
            </Button>
          </div>

          <div className="flex items-center gap-3 text-muted-foreground">
            <Icon icon={VolumeLowIcon} className="size-4 shrink-0" />
            <Slider
              aria-label="Volume"
              value={[volume]}
              min={0}
              max={100}
              onValueChange={(value) => {
                const next = Array.isArray(value) ? value[0] : value;
                dragging.current = true;
                setVolume(next);
                window.speaker.setVolume(next);
              }}
              onValueCommitted={() => {
                dragging.current = false;
              }}
            />
            <Icon icon={VolumeHighIcon} className="size-4 shrink-0" />
          </div>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <p className="text-xs text-muted-foreground">Anyone else who picks this speaker takes over.</p>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => window.speaker.command("disconnect")}>
          <Icon icon={Unlink04Icon} />
          Disconnect listener
        </Button>
      </CardFooter>
    </Card>
  );
}

function toForm(settings: SpeakerSettings): Form {
  const { volume: _volume, ...form } = settings;
  return form;
}

function Settings({ state }: { state: SpeakerState }) {
  const [form, setForm] = useState<Form>(() => toForm(state.settings));
  const [outputs, setOutputs] = useState<Outputs>({ default: null, outputs: [] });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const saved = toForm(state.settings);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  // Pick up changes saved elsewhere (e.g. the tray's start-at-login toggle) unless mid-edit.
  const savedKey = JSON.stringify(saved);
  const lastSaved = useRef(savedKey);
  useEffect(() => {
    if (savedKey !== lastSaved.current) {
      lastSaved.current = savedKey;
      if (!dirty || saving) setForm(saved);
    }
  });

  const refreshOutputs = () => window.speaker.listOutputs().then(setOutputs);
  useEffect(() => {
    refreshOutputs();
  }, []);

  useEffect(() => {
    const rename = () => {
      nameRef.current?.focus();
      nameRef.current?.select();
    };
    window.addEventListener(RENAME_EVENT, rename);
    return () => window.removeEventListener(RENAME_EVENT, rename);
  }, []);

  const defaultName = outputs.default && outputs.default !== "default" ? outputs.default : null;
  const outputItems = [
    { value: DEFAULT_OUTPUT, label: defaultName ? `System default (${defaultName})` : "System default" },
    ...outputs.outputs.filter((name) => name !== outputs.default).map((name) => ({ value: name, label: name })),
  ];
  // Keep a saved device listed while it's switched off, e.g. a Bluetooth speaker.
  if (form.output && !outputs.outputs.includes(form.output)) {
    outputItems.push({ value: form.output, label: `${form.output} (not connected)` });
  }

  const update = (patch: Partial<Form>) => {
    setForm((current) => ({ ...current, ...patch }));
    setNote("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const result = await window.speaker.saveSettings(form);
    setSaving(false);
    setNote(result.ok ? "Saved" : result.error);
  };

  return (
    <Card className="min-h-0 gap-0 py-0">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="border-b py-4">
          <CardTitle>Settings</CardTitle>
          <CardDescription>Saving restarts the speaker for a moment.</CardDescription>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto py-4">
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="speaker-name">Speaker name</FieldLabel>
              <Input
                id="speaker-name"
                ref={nameRef}
                value={form.name}
                maxLength={60}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => update({ name: event.target.value })}
              />
              <FieldDescription>What people see in their Spotify device list.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Play through</FieldLabel>
              <Select
                items={outputItems}
                value={form.output || DEFAULT_OUTPUT}
                onValueChange={(value) => update({ output: value === DEFAULT_OUTPUT ? "" : String(value) })}
                onOpenChange={(isOpen) => isOpen && refreshOutputs()}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {outputItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Pick the Bluetooth speaker to always play there.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Quality</FieldLabel>
              <Select
                items={QUALITY}
                value={form.bitrate}
                onValueChange={(value) => update({ bitrate: value as Form["bitrate"] })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUALITY.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <FieldSeparator />

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="normalize">Even out loudness</FieldLabel>
                <FieldDescription>Keeps quiet and loud songs at a similar level.</FieldDescription>
              </FieldContent>
              <Switch
                id="normalize"
                checked={form.normalize}
                onCheckedChange={(checked) => update({ normalize: checked })}
              />
            </Field>

            <Field orientation="horizontal" data-disabled={!state.packaged}>
              <FieldContent>
                <FieldLabel htmlFor="login">Start with this computer</FieldLabel>
                <FieldDescription>
                  {state.packaged
                    ? "Keeps the speaker available after a restart."
                    : "Only available in the installed app."}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="login"
                disabled={!state.packaged}
                checked={form.openAtLogin}
                onCheckedChange={(checked) => update({ openAtLogin: checked })}
              />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end gap-3 py-3">
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
          <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={() => setForm(saved)}>
            Reset
          </Button>
          <Button type="submit" disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
