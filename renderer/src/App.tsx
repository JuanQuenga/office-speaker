import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Key01Icon,
  Loading03Icon,
  MusicNote03Icon,
  NextIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  PreviousIcon,
  Refresh01Icon,
  SmartPhone01Icon,
  Speaker01Icon,
  Unlink04Icon,
  UserMultipleIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  Wifi01Icon,
} from "@hugeicons/core-free-icons";

import appIcon from "./app-icon.png";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { EngineStatus, SpeakerState } from "./speaker";

const STATUS: Record<EngineStatus, { label: string; tone: string; live?: boolean }> = {
  unsupported: { label: "Not supported", tone: "bg-destructive" },
  setup: { label: "Needs setup", tone: "bg-amber-500" },
  installing: { label: "Installing", tone: "bg-amber-500", live: true },
  starting: { label: "Starting", tone: "bg-amber-500", live: true },
  ready: { label: "Ready", tone: "bg-primary", live: true },
  connected: { label: "Playing", tone: "bg-primary", live: true },
  expired: { label: "Updating", tone: "bg-amber-500", live: true },
  error: { label: "Problem", tone: "bg-destructive" },
};

const DASHBOARD_URL = "https://developer.spotify.com/dashboard";
const TERMS_URL = "https://www.spotify.com/legal/end-user-agreement/";
const SOLOIST_URL = "https://developer.spotify.com/documentation/soloist";
const RENAME_EVENT = "office-speaker:rename";
const BUILD_LIFETIME_DAYS = 90;

function Icon({ icon, className }: { icon: IconSvgElement; className?: string }) {
  return <HugeiconsIcon icon={icon} strokeWidth={2} className={className} />;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline"
    >
      {children}
      <Icon icon={ArrowUpRight01Icon} className="size-3" />
    </a>
  );
}

function formatTime(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function App() {
  const [state, setState] = useState<SpeakerState | null>(null);

  useEffect(() => {
    const off = window.speaker.onState(setState);
    window.speaker.getState().then(setState);
    return off;
  }, []);

  if (!state) return null;
  const settingUp = state.status === "setup" || state.status === "installing";

  return (
    <div className="flex h-screen flex-col">
      <TitleBar state={state} />
      {state.status === "unsupported" ? (
        <Centered>
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive">
              <Icon icon={Alert02Icon} className="size-6" />
            </div>
            <h2 className="font-heading text-xl font-semibold">This computer can't run Office Speaker</h2>
            <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          </div>
        </Centered>
      ) : settingUp ? (
        <Centered>
          <Setup state={state} />
        </Centered>
      ) : (
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] gap-3 p-3">
          <Stage state={state} />
          <Settings state={state} />
        </main>
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto p-6">{children}</main>;
}

/* ------------------------------------------------------------------ title bar */

function StatusPill({ state }: { state: SpeakerState }) {
  const status = STATUS[state.status];
  const label = state.status === "connected" && !state.playing ? "Paused" : status.label;
  const live = status.live && !(state.status === "connected" && !state.playing);
  return (
    <span className="inline-flex items-center gap-2 rounded-full border bg-background/60 px-2.5 py-1 text-xs font-medium">
      <span className="relative flex size-2">
        {live && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", status.tone)} />}
        <span className={cn("relative size-2 rounded-full", status.tone)} />
      </span>
      {label}
    </span>
  );
}

function TitleBar({ state }: { state: SpeakerState }) {
  const [copied, setCopied] = useState(false);
  return (
    <header
      className={cn(
        "drag-region flex h-13 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur",
        state.platform === "darwin" && "pl-21",
        state.platform === "win32" && "pr-36",
      )}
    >
      <img src={appIcon} alt="" className="size-6" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="font-heading text-sm font-semibold tracking-tight">Office Speaker</h1>
        <span className="truncate text-xs text-muted-foreground">v{state.version}</span>
      </div>
      <StatusPill state={state} />
      <Button
        variant="ghost"
        size="sm"
        className="no-drag text-muted-foreground"
        onClick={async () => {
          await window.speaker.copyLogs();
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon icon={copied ? CheckmarkCircle02Icon : Copy01Icon} />
        {copied ? "Copied" : "Logs"}
      </Button>
    </header>
  );
}

/* ------------------------------------------------------------------ setup */

function Benefit({ icon, children }: { icon: IconSvgElement; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/15 ring-1 ring-white/20">
        <Icon icon={icon} className="size-4" />
      </span>
      <span className="pt-1.5 text-sm leading-snug text-white/90">{children}</span>
    </li>
  );
}

function Setup({ state }: { state: SpeakerState }) {
  const [name, setName] = useState(state.settings.name);
  const [apiKey, setApiKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const installing = state.status === "installing";
  const problem = error || state.message;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const result = await window.speaker.setup({ name, apiKey, consent });
    if (!result.ok) setError(result.error);
  };

  return (
    <div className="grid w-full max-w-3xl grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] overflow-hidden rounded-3xl border bg-card shadow-xl shadow-black/5">
      <aside className="relative flex flex-col justify-between gap-10 overflow-hidden bg-linear-to-br from-[oklch(0.62_0.12_168)] to-[oklch(0.38_0.08_175)] p-8 text-white">
        <div className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-white/10 blur-2xl" />
        <div className="relative">
          <img src={appIcon} alt="" className="size-14 drop-shadow-lg" />
          <h2 className="mt-5 font-heading text-2xl leading-tight font-semibold tracking-tight">
            Turn this computer into a speaker anyone can play to.
          </h2>
        </div>
        <ul className="relative flex flex-col gap-3.5">
          <Benefit icon={SmartPhone01Icon}>People play from their own Spotify app. Nobody signs in here.</Benefit>
          <Benefit icon={UserMultipleIcon}>Free and Premium accounts both work, and Jam does too.</Benefit>
          <Benefit icon={Speaker01Icon}>Runs Spotify Soloist, Spotify's official player, kept up to date.</Benefit>
        </ul>
      </aside>

      <form onSubmit={submit} className="flex flex-col p-8">
        <h2 className="font-heading text-lg font-semibold tracking-tight">Set up this speaker</h2>
        <p className="mt-1 text-sm text-muted-foreground">Takes about a minute. You only do this once.</p>

        <FieldGroup className="mt-6 gap-5">
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
              Someone with Premium creates it in the <ExternalLink href={DASHBOARD_URL}>developer dashboard</ExternalLink>{" "}
              under <span className="font-medium text-foreground">Spotify Soloist API Key</span>.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal" className="rounded-xl border bg-muted/40 p-3">
            <Checkbox
              id="setup-consent"
              checked={consent}
              disabled={installing}
              onCheckedChange={(checked) => setConsent(checked === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor="setup-consent">Download Spotify Soloist from Spotify</FieldLabel>
              <FieldDescription>
                You agree to Spotify's <ExternalLink href={TERMS_URL}>Terms of Use</ExternalLink>. Each version
                works for 90 days, so Office Speaker keeps it updated. <ExternalLink href={SOLOIST_URL}>About Soloist</ExternalLink>
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className={cn("min-w-0 text-xs", problem && !installing ? "text-destructive" : "text-muted-foreground")}>
            {installing ? state.progress : problem}
          </p>
          <Button
            type="submit"
            size="lg"
            className="shrink-0"
            disabled={installing || !consent || !apiKey.trim() || !name.trim()}
          >
            {installing && <Icon icon={Loading03Icon} className="animate-spin" />}
            {installing ? "Setting up…" : "Set up speaker"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ stage */

function Stage({ state }: { state: SpeakerState }) {
  return (
    <section className="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-card">
      {state.status === "connected" ? <NowPlaying state={state} /> : <Waiting state={state} />}
      {state.message && (
        <div className="absolute inset-x-4 top-4 flex items-start gap-2 rounded-xl border border-destructive/20 bg-background/90 px-3 py-2.5 text-sm text-destructive shadow-sm backdrop-blur">
          <Icon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
          <p>{state.message}</p>
        </div>
      )}
    </section>
  );
}

function BroadcastMark({ busy }: { busy: boolean }) {
  return (
    <div className="relative grid size-44 place-items-center">
      {!busy &&
        [0, 1.2, 2.4].map((delay) => (
          <span
            key={delay}
            className="absolute inset-0 animate-broadcast rounded-full border border-primary/40 bg-primary/5"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      <div className="relative grid size-24 place-items-center rounded-[28px] bg-linear-to-br from-[oklch(0.68_0.13_168)] to-[oklch(0.42_0.09_175)] text-white shadow-xl shadow-primary/25 ring-1 ring-white/20">
        <Icon icon={busy ? Loading03Icon : Speaker01Icon} className={cn("size-10", busy && "animate-spin")} />
      </div>
    </div>
  );
}

function Waiting({ state }: { state: SpeakerState }) {
  const name = state.settings.name;
  const busy = state.status === "starting" || state.status === "expired";
  const steps: { icon: IconSvgElement; title: string; text: string }[] = [
    { icon: Wifi01Icon, title: "Join the Wi-Fi", text: "Same network as this computer." },
    { icon: SmartPhone01Icon, title: "Open Spotify", text: "Tap the devices icon." },
    { icon: Speaker01Icon, title: `Pick “${name}”`, text: "Music plays right here." },
  ];
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-2/3 bg-radial-[at_50%_0%] from-primary/12 to-transparent to-70%" />
      <div className="relative flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <BroadcastMark busy={busy} />
        <p className="mt-2 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {busy ? "Starting up" : "Visible in Spotify as"}
        </p>
        <p className="max-w-full font-heading text-4xl font-semibold tracking-tight break-words">{name}</p>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 text-muted-foreground"
          onClick={() => window.dispatchEvent(new Event(RENAME_EVENT))}
        >
          <Icon icon={PencilEdit02Icon} />
          Rename
        </Button>
      </div>
      <div className="relative border-t bg-muted/30 px-6 pt-5 pb-4">
        <ol className="grid grid-cols-3 gap-4">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-background text-primary shadow-xs ring-1 ring-border">
                <Icon icon={step.icon} className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Step {index + 1}</p>
                <p className="line-clamp-2 text-sm font-medium break-words">{step.title}</p>
                <p className="text-xs text-muted-foreground">{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Free and Premium accounts both work. Whoever picks the speaker last takes over, or they can join the Jam.
        </p>
      </div>
    </>
  );
}

function Equalizer({ playing }: { playing: boolean }) {
  return (
    <span className="flex h-3 items-end gap-0.5" aria-hidden>
      {[0, 0.25, 0.5].map((delay) => (
        <span
          key={delay}
          className={cn("w-0.5 rounded-full bg-primary", playing ? "h-full animate-equalizer" : "h-1")}
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

/** Interpolates Soloist's last reported position while playing. */
function usePosition(state: SpeakerState) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [state.playing]);
  const position = state.position;
  const duration = state.track?.durationMs ?? 0;
  if (!position) return { ms: 0, duration };
  const elapsed = state.playing ? Math.max(0, now - position.at) * (position.speed || 1) : 0;
  return { ms: Math.min(duration || Infinity, position.ms + elapsed), duration };
}

function Progress({ state }: { state: SpeakerState }) {
  const { ms, duration } = usePosition(state);
  const fraction = duration ? Math.min(1, ms / duration) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-label="Seek"
        className="group relative h-4 w-full cursor-pointer"
        onClick={(event) => {
          if (!duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          window.speaker.seek(((event.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/10 transition-[height] group-hover:h-1.5">
          <span className="block h-full rounded-full bg-foreground" style={{ width: `${fraction * 100}%` }} />
        </span>
      </button>
      <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{formatTime(ms)}</span>
        <span>-{formatTime(Math.max(0, duration - ms))}</span>
      </div>
    </div>
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
    <>
      {track?.cover && (
        <img
          src={track.cover}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-45 blur-3xl saturate-150 dark:opacity-35"
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-card/30 via-card/70 to-card" />

      <div className="relative flex flex-1 items-center gap-8 p-8">
        {track?.cover ? (
          <img
            src={track.cover}
            alt=""
            className="aspect-square w-[44%] max-w-72 shrink-0 rounded-2xl object-cover shadow-2xl ring-1 shadow-black/30 ring-black/10"
          />
        ) : (
          <div className="grid aspect-square w-[44%] max-w-72 shrink-0 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <Icon icon={MusicNote03Icon} className="size-14" />
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
              <Equalizer playing={state.playing} />
              {state.playing ? "Now playing" : "Paused"}
              {state.context && state.context !== track?.album && (
                <span className="truncate normal-case tracking-normal">· {state.context}</span>
              )}
            </p>
            <h2 className="mt-2 line-clamp-2 font-heading text-3xl leading-tight font-semibold tracking-tight">
              {track?.title ?? "Nothing playing yet"}
            </h2>
            {track?.artist && <p className="mt-1 truncate text-base text-foreground/80">{track.artist}</p>}
            {track?.album && <p className="truncate text-sm text-muted-foreground">{track.album}</p>}
          </div>

          <Progress state={state} />

          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon-lg" className="rounded-full" aria-label="Previous track" onClick={() => window.speaker.command("prev")}>
                <Icon icon={PreviousIcon} className="size-5" />
              </Button>
              <Button
                size="icon-lg"
                className="size-14 rounded-full bg-foreground text-background shadow-lg hover:bg-foreground/85"
                aria-label={state.playing ? "Pause" : "Play"}
                onClick={() => window.speaker.command(state.playing ? "pause" : "play")}
              >
                <Icon icon={state.playing ? PauseIcon : PlayIcon} className="size-6" />
              </Button>
              <Button variant="ghost" size="icon-lg" className="rounded-full" aria-label="Next track" onClick={() => window.speaker.command("next")}>
                <Icon icon={NextIcon} className="size-5" />
              </Button>
            </div>
            <div className="flex max-w-80 items-center gap-2.5 text-muted-foreground">
              <Icon icon={VolumeLowIcon} className="size-4 shrink-0" />
              <Slider
                className="flex-1"
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
        </div>
      </div>

      <div className="relative flex items-center justify-between border-t bg-background/40 px-6 py-3 backdrop-blur">
        <p className="text-xs text-muted-foreground">Anyone who picks “{state.settings.name}” in Spotify takes over.</p>
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => window.speaker.command("disconnect")}>
          <Icon icon={Unlink04Icon} />
          Disconnect listener
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ settings */

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
  const daysLeft = soloist.daysLeft === null ? null : Math.max(soloist.daysLeft, 0);
  const expiresSoon = daysLeft !== null && daysLeft <= 14;
  const lifeFraction = daysLeft === null ? 0 : Math.min(1, daysLeft / BUILD_LIFETIME_DAYS);

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-card">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <FieldGroup className="gap-7">
          <FieldSet className="gap-4">
            <FieldLegend variant="label" className="mb-0 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">Speaker</FieldLegend>
            <Field>
              <FieldLabel htmlFor="speaker-name">Name in Spotify</FieldLabel>
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
            </Field>
            <Field orientation="horizontal" data-disabled={!state.packaged}>
              <FieldContent>
                <FieldLabel htmlFor="login">Start with this computer</FieldLabel>
                <FieldDescription>
                  {state.packaged ? "Back on its own after a restart." : "Only in the installed app."}
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
          </FieldSet>

          <FieldSet className="gap-4">
            <FieldLegend variant="label" className="mb-0 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">Spotify Soloist</FieldLegend>

            <div className="rounded-xl border bg-muted/30 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Version {soloist.version ?? "—"}</p>
                  <p className={cn("text-xs text-muted-foreground", expiresSoon && "text-destructive")}>
                    {daysLeft === null ? "Not installed" : `${daysLeft} days left · updates automatically`}
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
                  {checking ? "Checking" : "Check"}
                </Button>
              </div>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className={cn("h-full rounded-full", expiresSoon ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${lifeFraction * 100}%` }}
                />
              </div>
              {updateNote && <p className="mt-2 text-xs text-muted-foreground">{updateNote}</p>}
            </div>

            <Field>
              <FieldLabel htmlFor="api-key">
                <Icon icon={Key01Icon} className="size-3.5 text-muted-foreground" />
                API key
              </FieldLabel>
              <Input
                id="api-key"
                type="password"
                value={apiKey}
                placeholder={state.hasApiKey ? "Saved · paste a new one to replace it" : "Paste the key"}
                autoComplete="off"
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setNote("");
                }}
              />
            </Field>
          </FieldSet>
        </FieldGroup>
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        <span className="mr-auto text-xs text-muted-foreground">{note || "Saving restarts the speaker."}</span>
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
      </div>
    </form>
  );
}
