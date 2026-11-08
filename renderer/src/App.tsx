import { useEffect, useRef, useState, type FormEvent } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  Copy01Icon,
  MusicNote03Icon,
  NextIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  PreviousIcon,
  Settings02Icon,
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
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
    <main className="flex min-h-screen flex-col gap-3 p-4">
      <Header state={state} />
      {state.message && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <Icon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
          <p>{state.message}</p>
        </div>
      )}
      {connected ? <NowPlaying state={state} /> : <Waiting state={state} />}
      <Settings state={state} />
      <Footer version={state.version} />
    </main>
  );
}

function Header({ state }: { state: SpeakerState }) {
  const status = STATUS[state.status];
  const label = state.status === "connected" && !state.playing ? "Paused" : status.label;
  return (
    <header className="flex items-center gap-3 px-1">
      <img src={appIcon} alt="" className="size-10" />
      <div className="min-w-0 flex-1">
        <h1 className="font-heading text-base font-semibold leading-tight">Office Speaker</h1>
        <p className="truncate text-xs text-muted-foreground">Spotify Connect speaker</p>
      </div>
      <Badge variant="outline" className="gap-1.5">
        <span className={cn("size-1.5 rounded-full", status.tone)} />
        {label}
      </Badge>
    </header>
  );
}

function Waiting({ state }: { state: SpeakerState }) {
  const name = state.settings.name;
  const steps = [
    { icon: Wifi01Icon, text: <>Join the same Wi-Fi as this computer.</> },
    { icon: SmartPhone01Icon, text: <>Open Spotify and tap the devices icon.</> },
    {
      icon: Speaker01Icon,
      text: (
        <>
          Pick <span className="font-medium text-foreground">{name}</span>. Nobody signs in here.
        </>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardDescription>Visible in Spotify as</CardDescription>
        <CardTitle className="text-xl break-words">{name}</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.dispatchEvent(new Event("office-speaker:rename"))}
          >
            <Icon icon={PencilEdit02Icon} />
            Rename
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2.5">
          {steps.map((step, index) => (
            <li key={index} className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Icon icon={step.icon} className="size-4" />
              </span>
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground">
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
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {track?.cover ? (
            <img src={track.cover} alt="" className="size-20 shrink-0 rounded-lg object-cover shadow-sm" />
          ) : (
            <div className="grid size-20 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Icon icon={MusicNote03Icon} className="size-7" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate font-heading text-base font-semibold">
              {track?.title ?? "Nothing playing yet"}
            </p>
            {track && (
              <p className="truncate text-sm text-muted-foreground">
                {[track.artist, track.album].filter(Boolean).join(" · ")}
              </p>
            )}
            {state.client && (
              <Badge variant="secondary" className="mt-2 max-w-full">
                <Icon icon={SmartPhone01Icon} />
                <span className="truncate">From {state.client}</span>
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center gap-3">
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
      </CardContent>
      <CardFooter className="justify-center">
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
  const [open, setOpen] = useState(false);
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
      setOpen(true);
      setTimeout(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
        nameRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 50);
    };
    window.addEventListener("office-speaker:rename", rename);
    return () => window.removeEventListener("office-speaker:rename", rename);
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
    <Card className="py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <button className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
          }
        >
          <Icon icon={Settings02Icon} className="size-4 text-muted-foreground" />
          <span className="flex-1">Settings</span>
          <Icon
            icon={ArrowDown01Icon}
            className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <form onSubmit={submit} className="border-t px-4 pt-4 pb-4">
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

              <div className="flex items-center justify-end gap-3">
                {note && <span className="text-xs text-muted-foreground">{note}</span>}
                <Button type="submit" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function Footer({ version }: { version: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <footer className="mt-auto flex items-center justify-between px-1 text-xs text-muted-foreground">
      <span>Version {version}</span>
      <Button
        variant="ghost"
        size="xs"
        onClick={async () => {
          await window.speaker.copyLogs();
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon icon={Copy01Icon} />
        {copied ? "Copied" : "Copy logs"}
      </Button>
    </footer>
  );
}
