import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  Copy01Icon,
  Key01Icon,
  Loading03Icon,
  MusicNote03Icon,
  NextIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  Playlist01Icon,
  PreviousIcon,
  Refresh01Icon,
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { EngineStatus, SpeakerState } from "./speaker";

const STATUS: Record<EngineStatus, { label: string; tone: string }> = {
  unsupported: { label: "Not supported", tone: "bg-destructive" },
  setup: { label: "Needs setup", tone: "bg-amber-500" },
  installing: { label: "Installing", tone: "bg-amber-500" },
  starting: { label: "Starting", tone: "bg-amber-500" },
  ready: { label: "Ready", tone: "bg-primary" },
  connected: { label: "Playing", tone: "bg-primary" },
  expired: { label: "Updating", tone: "bg-amber-500" },
  error: { label: "Problem", tone: "bg-destructive" },
};

const DASHBOARD_URL = "https://developer.spotify.com/dashboard";
const TERMS_URL = "https://www.spotify.com/legal/end-user-agreement/";
const SOLOIST_URL = "https://developer.spotify.com/documentation/soloist";
const RENAME_EVENT = "office-speaker:rename";

function Icon({ icon, className }: { icon: IconSvgElement; className?: string }) {
  return <HugeiconsIcon icon={icon} strokeWidth={2} className={className} />;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline">
      {children}
      <Icon icon={ArrowUpRight01Icon} className="size-3" />
    </a>
  );
}

export function App() {
  const [state, setState] = useState<SpeakerState | null>(null);

  useEffect(() => {
    const off = window.speaker.onState(setState);
    window.speaker.getState().then(setState);
    return off;
  }, []);

  if (!state) return null;
  const connected = state.status === "connected";
  const settingUp = state.status === "setup" || state.status === "installing";

  return (
    <div className="flex h-screen flex-col">
      <TopBar state={state} />
      {state.status === "unsupported" ? (
        <Centered>
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>This computer can't run Office Speaker</CardTitle>
              <CardDescription>{state.message}</CardDescription>
            </CardHeader>
          </Card>
        </Centered>
      ) : settingUp ? (
        <Centered>
          <Setup state={state} />
        </Centered>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] gap-4 p-4">
          <section className="flex min-h-0 flex-col gap-3">
            {state.message && <Notice>{state.message}</Notice>}
            {connected ? <NowPlaying state={state} /> : <Waiting state={state} />}
          </section>
          <Settings state={state} />
        </main>
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">{children}</main>;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <Icon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
      <p>{children}</p>
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

function Setup({ state }: { state: SpeakerState }) {
  const [name, setName] = useState(state.settings.name);
  const [apiKey, setApiKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const installing = state.status === "installing";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const result = await window.speaker.setup({ name, apiKey, consent });
    if (!result.ok) setError(result.error);
  };

  return (
    <Card className="w-full max-w-lg">
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle className="text-lg">Set up this speaker</CardTitle>
          <CardDescription>
            Office Speaker plays through Spotify Soloist, Spotify's official player for speakers like this one.
            Once it's set up, anyone on this Wi-Fi can play to it from their own Spotify app, Free or Premium.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-5">
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="setup-name">Speaker name</FieldLabel>
              <Input
                id="setup-name"
                value={name}
                maxLength={60}
                spellCheck={false}
                autoComplete="off"
                disabled={installing}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldDescription>What people see in their Spotify device list.</FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="setup-key">Spotify Soloist API key</FieldLabel>
              <Input
                id="setup-key"
                type="password"
                value={apiKey}
                placeholder="Paste the key"
                autoComplete="off"
                disabled={installing}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <FieldDescription>
                Someone with Spotify Premium creates it once: open the <ExternalLink href={DASHBOARD_URL}>Spotify
                developer dashboard</ExternalLink> and click <strong>Spotify Soloist API Key</strong>. It's stored
                encrypted on this computer.
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <Checkbox
                id="setup-consent"
                checked={consent}
                disabled={installing}
                onCheckedChange={(checked) => setConsent(checked === true)}
              />
              <FieldContent>
                <FieldLabel htmlFor="setup-consent">Download Spotify Soloist from Spotify</FieldLabel>
                <FieldDescription>
                  You agree to Spotify's <ExternalLink href={TERMS_URL}>Terms of Use</ExternalLink>. Each Soloist
                  version works for 90 days, so Office Speaker keeps it updated.{" "}
                  <ExternalLink href={SOLOIST_URL}>About Soloist</ExternalLink>
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between gap-3">
          <p className={cn("text-xs", error || state.message ? "text-destructive" : "text-muted-foreground")}>
            {installing ? state.progress : error || state.message}
          </p>
          <Button type="submit" disabled={installing || !consent || !apiKey.trim() || !name.trim()}>
            {installing ? (
              <>
                <Icon icon={Loading03Icon} className="animate-spin" />
                Setting up…
              </>
            ) : (
              "Set up speaker"
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
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
  const busy = state.status === "starting" || state.status === "expired";
  return (
    <Card className="flex-1 justify-between">
      <CardContent className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="relative grid size-20 place-items-center rounded-2xl bg-primary/10 text-primary">
          {state.status === "ready" && (
            <span className="absolute inset-0 animate-ping rounded-2xl bg-primary/10 [animation-duration:2.5s]" />
          )}
          <Icon icon={busy ? Loading03Icon : Speaker01Icon} className={cn("size-9", busy && "animate-spin")} />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{busy ? "Starting up as" : "Visible in Spotify as"}</p>
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
          Free and Premium accounts both work. Whoever picks the speaker last takes over, or join their Jam to
          add songs.
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
            {track?.artist && <p className="mt-0.5 truncate text-sm text-muted-foreground">{track.artist}</p>}
            {track?.album && <p className="truncate text-sm text-muted-foreground">{track.album}</p>}
            {state.context && state.context !== track?.album && (
              <Badge variant="secondary" className="mt-3 max-w-full">
                <Icon icon={Playlist01Icon} />
                <span className="truncate">From {state.context}</span>
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

function Settings({ state }: { state: SpeakerState }) {
  const saved = { name: state.settings.name, openAtLogin: state.settings.openAtLogin };
  const [form, setForm] = useState(saved);
  const [apiKey, setApiKey] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [updateNote, setUpdateNote] = useState("");
  const [checking, setChecking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const dirty = form.name !== saved.name || form.openAtLogin !== saved.openAtLogin || apiKey.trim() !== "";

  // Pick up changes saved elsewhere (e.g. the tray's start-at-login toggle) unless mid-edit.
  const savedKey = JSON.stringify(saved);
  const lastSaved = useRef(savedKey);
  useEffect(() => {
    if (savedKey !== lastSaved.current) {
      lastSaved.current = savedKey;
      if (!dirty || saving) setForm(saved);
    }
  });

  useEffect(() => {
    const rename = () => {
      nameRef.current?.focus();
      nameRef.current?.select();
    };
    window.addEventListener(RENAME_EVENT, rename);
    return () => window.removeEventListener(RENAME_EVENT, rename);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const result = await window.speaker.saveSettings({ ...form, apiKey: apiKey.trim() || undefined });
    setSaving(false);
    if (result.ok) setApiKey("");
    setNote(result.ok ? "Saved" : result.error);
  };

  const { soloist } = state;
  const expiresSoon = soloist.daysLeft !== null && soloist.daysLeft <= 14;

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
                onChange={(event) => {
                  setForm({ ...form, name: event.target.value });
                  setNote("");
                }}
              />
              <FieldDescription>What people see in their Spotify device list.</FieldDescription>
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
                onCheckedChange={(checked) => {
                  setForm({ ...form, openAtLogin: checked });
                  setNote("");
                }}
              />
            </Field>

            <FieldSeparator />

            <Field>
              <FieldLabel htmlFor="api-key">
                <Icon icon={Key01Icon} className="size-3.5 text-muted-foreground" />
                Soloist API key
              </FieldLabel>
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                placeholder={state.hasApiKey ? "Saved. Paste a new key to replace it" : "Paste the key"}
                autoComplete="off"
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setNote("");
                }}
              />
            </Field>

            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
              <div className="min-w-0 text-xs">
                <p className="font-medium">Spotify Soloist {soloist.version ?? ""}</p>
                <p className={cn("text-muted-foreground", expiresSoon && "text-destructive")}>
                  {updateNote ||
                    (soloist.daysLeft === null
                      ? "Not installed"
                      : `This version works for ${Math.max(soloist.daysLeft, 0)} more days. Updates are automatic.`)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  setUpdateNote(await window.speaker.checkUpdates());
                  setChecking(false);
                }}
              >
                <Icon icon={Refresh01Icon} className={cn(checking && "animate-spin")} />
                Check
              </Button>
            </div>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end gap-3 py-3">
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || saving}
            onClick={() => {
              setForm(saved);
              setApiKey("");
            }}
          >
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
