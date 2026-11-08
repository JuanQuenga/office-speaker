import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Loading03Icon,
  MusicNote03Icon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  QrCodeIcon,
  Radio01Icon,
  Refresh01Icon,
  Search01Icon,
  Settings02Icon,
  SmartPhone01Icon,
  Speaker01Icon,
  StarIcon,
  StopIcon,
  Unlink04Icon,
  UserMultipleIcon,
  VolumeHighIcon,
  VolumeLowIcon,
} from "@hugeicons/core-free-icons";

import appIcon from "./app-icon.png";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { EngineStatus, SpeakerState, Station } from "./speaker";

type Page = "player" | "radio" | "settings";

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

function statusLabel(state: SpeakerState) {
  return state.status === "connected" && !state.playing ? "Paused" : STATUS[state.status].label;
}

export function App() {
  const [state, setState] = useState<SpeakerState | null>(null);
  const [page, setPage] = useState<Page>("player");

  useEffect(() => {
    const off = window.speaker.onState(setState);
    window.speaker.getState().then(setState);
    return off;
  }, []);

  useEffect(() => {
    if (state) document.documentElement.dataset.platform = state.platform;
  }, [state?.platform]);

  if (!state) return null;

  if (state.status === "unsupported") {
    return (
      <div className="drag-region grid h-screen place-items-center bg-background p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-destructive/10 text-destructive">
            <Icon icon={Alert02Icon} className="size-6" />
          </div>
          <h2 className="font-heading text-xl font-semibold">This computer can't run Office Speaker</h2>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  if (state.status === "setup" || state.status === "installing") {
    return <Setup state={state} />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar state={state} page={page} onNavigate={setPage} />
      <main className="flex min-w-0 flex-1 flex-col border-l bg-background">
        {page === "player" ? (
          <Player state={state} onNavigate={setPage} />
        ) : page === "radio" ? (
          <RadioPage state={state} />
        ) : (
          <Settings state={state} />
        )}
      </main>
    </div>
  );
}

/** Title-bar strip for the main pane: draggable, clear of Windows' caption buttons. */
function PaneHeader({ state, title }: { state: SpeakerState; title?: string }) {
  return (
    <header
      className={cn(
        "drag-region relative z-10 flex h-13 shrink-0 items-center px-6",
        state.platform === "win32" && "pr-38",
      )}
    >
      {title && <h1 className="font-heading text-[15px] font-semibold tracking-tight">{title}</h1>}
    </header>
  );
}

/* ------------------------------------------------------------------ sidebar */

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: IconSvgElement;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active ? "bg-foreground/8 text-foreground" : "text-foreground/70 hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <Icon icon={icon} className={cn("size-4", active ? "text-primary" : "text-foreground/50")} />
      {label}
    </button>
  );
}

function Sidebar({
  state,
  page,
  onNavigate,
}: {
  state: SpeakerState;
  page: Page;
  onNavigate: (page: Page) => void;
}) {
  const status = STATUS[state.status];
  const live = status.live && !(state.status === "connected" && !state.playing);
  const [copied, setCopied] = useState(false);
  const track = state.status === "connected" ? state.track : null;

  return (
    <aside className="sidebar-surface flex w-56 shrink-0 flex-col">
      {/* Traffic lights live here on macOS. */}
      <div className="drag-region h-13 shrink-0" />

      <div className="px-4 pb-4">
        <div className="flex items-center gap-3">
          <img src={appIcon} alt="" className="size-10 drop-shadow-sm" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold tracking-tight">{state.settings.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="relative flex size-1.5">
                {live && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-70", status.tone)} />}
                <span className={cn("relative size-1.5 rounded-full", status.tone)} />
              </span>
              {statusLabel(state)}
            </p>
          </div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2.5">
        <NavItem icon={Speaker01Icon} label="Now Playing" active={page === "player"} onClick={() => onNavigate("player")} />
        <NavItem icon={Radio01Icon} label="Radio" active={page === "radio"} onClick={() => onNavigate("radio")} />
        <NavItem icon={Settings02Icon} label="Settings" active={page === "settings"} onClick={() => onNavigate("settings")} />
      </nav>

      <div className="flex-1" />

      {track && page !== "player" && (
        <button
          type="button"
          onClick={() => onNavigate("player")}
          className="mx-2.5 mb-2 flex items-center gap-2.5 rounded-xl p-2 text-left transition-colors hover:bg-foreground/5"
        >
          {track.cover ? (
            <img src={track.cover} alt="" className="size-9 shrink-0 rounded-md object-cover shadow-sm" />
          ) : (
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-foreground/10">
              <Icon icon={MusicNote03Icon} className="size-4 text-muted-foreground" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">{track.title}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{track.artist}</span>
          </span>
        </button>
      )}

      {(state.update.status === "ready" || state.update.status === "available") && (
        <button
          type="button"
          onClick={() => onNavigate("settings")}
          className="mx-2.5 mb-2 rounded-lg bg-primary/10 px-2.5 py-1.5 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/15"
        >
          Version {state.update.version} is ready
        </button>
      )}

      <div className="flex items-center justify-between border-t border-foreground/8 px-4 py-2.5 text-[11px] text-muted-foreground">
        <span>Version {state.version}</span>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground"
          onClick={async () => {
            await window.speaker.copyLogs();
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Icon icon={copied ? CheckmarkCircle02Icon : Copy01Icon} className="size-3" />
          {copied ? "Copied" : "Logs"}
        </button>
      </div>
    </aside>
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
    <div className="flex h-screen overflow-hidden">
      <aside className="drag-region relative flex w-[42%] shrink-0 flex-col justify-between overflow-hidden bg-linear-to-br from-[oklch(0.62_0.12_168)] to-[oklch(0.36_0.08_175)] px-10 pt-20 pb-10 text-white">
        <div className="pointer-events-none absolute -top-32 -right-32 size-96 rounded-full bg-white/10 blur-3xl" />
        <div className="relative">
          <img src={appIcon} alt="" className="size-16 drop-shadow-lg" />
          <h1 className="mt-6 font-heading text-[28px] leading-[1.15] font-semibold tracking-tight">
            Turn this computer into a speaker anyone can play to.
          </h1>
        </div>
        <ul className="relative flex flex-col gap-4">
          <Benefit icon={SmartPhone01Icon}>People play from their own Spotify app. Nobody signs in here.</Benefit>
          <Benefit icon={UserMultipleIcon}>Free and Premium accounts both work, and Jam does too.</Benefit>
          <Benefit icon={Speaker01Icon}>Runs Spotify Soloist, Spotify's official player, kept up to date.</Benefit>
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <PaneHeader state={state} />
        <form onSubmit={submit} className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-8 pb-10">
          <h2 className="font-heading text-xl font-semibold tracking-tight">Set up this speaker</h2>
          <p className="mt-1 text-sm text-muted-foreground">Takes about a minute. You only do this once.</p>

          <FieldGroup className="mt-7 gap-5">
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
                  works for 90 days, so Office Speaker keeps it updated.{" "}
                  <ExternalLink href={SOLOIST_URL}>About Soloist</ExternalLink>
                </FieldDescription>
              </FieldContent>
            </Field>
          </FieldGroup>

          <Button
            type="submit"
            size="lg"
            className="mt-7 w-full"
            disabled={installing || !consent || !apiKey.trim() || !name.trim()}
          >
            {installing && <Icon icon={Loading03Icon} className="animate-spin" />}
            {installing ? state.progress || "Setting up…" : "Set up speaker"}
          </Button>
          {problem && !installing && <p className="mt-3 text-center text-xs text-destructive">{problem}</p>}
        </form>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ player */

function Player({ state, onNavigate }: { state: SpeakerState; onNavigate: (page: Page) => void }) {
  const connected = state.status === "connected";
  const cover = connected ? state.track?.cover : null;
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {cover && (
        <>
          <img
            src={cover}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-50 blur-3xl saturate-150 dark:opacity-35"
          />
          <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-background/20 via-background/60 to-background" />
        </>
      )}
      <PaneHeader state={state} title={connected ? undefined : "Now Playing"} />
      {state.message && (
        <div className="relative z-10 mx-6 flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <Icon icon={Alert02Icon} className="mt-0.5 size-4 shrink-0" />
          <p>{state.message}</p>
        </div>
      )}
      {connected ? <NowPlaying state={state} /> : <Waiting state={state} onNavigate={onNavigate} />}
    </div>
  );
}

function Waiting({ state, onNavigate }: { state: SpeakerState; onNavigate: (page: Page) => void }) {
  const busy = state.status === "starting" || state.status === "expired";
  const picks = [...state.radio.favorites, ...state.radio.recent]
    .filter((station, index, all) => all.findIndex((s) => s.id === station.id) === index)
    .slice(0, 4);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-10 pb-10 text-center">
      <div className="grid aspect-square h-[clamp(120px,26vh,220px)] shrink-0 place-items-center rounded-2xl border bg-muted/50 text-muted-foreground/50">
        <Icon icon={busy ? Loading03Icon : Speaker01Icon} className={cn("size-12", busy && "animate-spin")} />
      </div>
      <div className="max-w-md">
        <h2 className="font-heading text-2xl leading-tight font-semibold tracking-tight">
          {busy ? "Starting…" : "Not playing"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          On a phone on this Wi-Fi, open Spotify, tap the devices icon, and pick{" "}
          <span className="font-medium text-foreground">{state.settings.name}</span>.
          {state.airplay.running && " On an iPhone you can also AirPlay to it from Apple Music or any app."}
        </p>
      </div>

      <div className="flex w-full max-w-xl items-stretch gap-3 text-left">
        <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold">No Spotify or Apple Music?</p>
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => onNavigate("radio")}>
              Browse radio
            </Button>
          </div>
          {picks.length ? (
            <div className="grid grid-cols-2 gap-2">
              {picks.map((station) => (
                <button
                  key={station.id}
                  type="button"
                  onClick={() => window.speaker.radioPlay(station)}
                  className="flex min-w-0 items-center gap-2 rounded-lg border bg-background p-1.5 text-left transition-colors hover:bg-muted"
                >
                  <StationIcon station={station} className="size-8" />
                  <span className="truncate text-xs font-medium">{station.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <Button variant="outline" className="justify-start" onClick={() => onNavigate("radio")}>
              <Icon icon={Radio01Icon} />
              Put on a radio station
            </Button>
          )}
        </div>
        {state.remote.qr && (
          <div className="flex w-44 shrink-0 flex-col items-center gap-2 rounded-2xl border bg-card p-3 text-center">
            <img src={state.remote.qr} alt="QR code for the phone page" className="size-24 rounded-md bg-white p-1" />
            <p className="text-[11px] leading-snug text-muted-foreground">Scan to pick a station from your phone</p>
          </div>
        )}
      </div>
    </div>
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
    <div className="flex w-full items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
      <span className="w-9 text-right">{formatTime(ms)}</span>
      <button
        type="button"
        aria-label="Seek"
        className="group relative h-4 flex-1 cursor-pointer"
        onClick={(event) => {
          if (!duration) return;
          const rect = event.currentTarget.getBoundingClientRect();
          window.speaker.seek(((event.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/12 transition-[height] group-hover:h-1.5">
          <span className="block h-full rounded-full bg-foreground/80" style={{ width: `${fraction * 100}%` }} />
        </span>
      </button>
      <span className="w-9">-{formatTime(Math.max(0, duration - ms))}</span>
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

  const radio = state.source === "radio";
  const station = state.radio.station;
  const favorite = Boolean(station && state.radio.favorites.some((s) => s.id === station.id));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-10 pb-12">
      {radio && track?.cover ? (
        <div className="grid aspect-square h-[clamp(160px,36vh,300px)] place-items-center rounded-2xl bg-white p-8 shadow-2xl ring-1 shadow-black/25 ring-black/10">
          <img src={track.cover} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      ) : radio ? (
        <div className="grid aspect-square h-[clamp(160px,36vh,300px)] place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Icon icon={Radio01Icon} className="size-14" />
        </div>
      ) : track?.cover ? (
        <img
          src={track.cover}
          alt=""
          className="aspect-square h-[clamp(160px,36vh,300px)] rounded-2xl object-cover shadow-2xl ring-1 shadow-black/35 ring-black/10"
        />
      ) : (
        <div className="grid aspect-square h-[clamp(160px,36vh,300px)] place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Icon icon={MusicNote03Icon} className="size-14" />
        </div>
      )}

      <div className="w-full max-w-md text-center">
        <h2 className="line-clamp-2 font-heading text-2xl leading-tight font-semibold tracking-tight">
          {track?.title ?? "Nothing playing yet"}
        </h2>
        <p className="mt-1 truncate text-sm text-foreground/75">
          {[track?.artist, track?.album].filter(Boolean).join(" — ")}
        </p>
        <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Equalizer playing={state.playing} />
          <span className="truncate">
            {radio
              ? state.radio.status === "buffering"
                ? "Tuning in…"
                : state.radio.status === "paused"
                  ? "Radio stopped"
                  : "Live radio"
              : state.source === "airplay"
              ? "Playing over AirPlay"
              : state.context && state.context !== track?.album
                ? `Playing from ${state.context} on Spotify`
                : "Playing on Spotify"}
          </span>
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col items-center gap-4">
        {radio ? (
          <span className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-destructive uppercase">
            Live
          </span>
        ) : (
          <Progress state={state} />
        )}
        {radio && station ? (
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon-lg"
              className={cn("size-11 rounded-full", favorite && "text-amber-500")}
              aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
              onClick={() => window.speaker.radioFavorite(station, !favorite)}
            >
              <Icon icon={StarIcon} className={cn("size-5", favorite && "[&_path]:fill-current")} />
            </Button>
            <Button
              size="icon-lg"
              className="size-14 rounded-full bg-foreground text-background shadow-lg hover:bg-foreground/85"
              aria-label={state.radio.status === "paused" ? "Play" : "Stop"}
              onClick={() => window.speaker.command(state.radio.status === "paused" ? "play" : "pause")}
            >
              <Icon icon={state.radio.status === "paused" ? PlayIcon : StopIcon} className="size-6" />
            </Button>
            <span className="size-11" />
          </div>
        ) : (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-lg" className="size-11 rounded-full" aria-label="Previous track" onClick={() => window.speaker.command("prev")}>
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
          <Button variant="ghost" size="icon-lg" className="size-11 rounded-full" aria-label="Next track" onClick={() => window.speaker.command("next")}>
            <Icon icon={NextIcon} className="size-5" />
          </Button>
        </div>
        )}
        <div className="flex w-full max-w-60 items-center gap-2.5 text-muted-foreground">
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

      <Button
        variant="ghost"
        size="sm"
        className="absolute right-5 bottom-4 text-muted-foreground hover:text-destructive"
        onClick={() => window.speaker.command("disconnect")}
      >
        <Icon icon={radio ? StopIcon : Unlink04Icon} />
        {radio ? "Turn off radio" : "Disconnect listener"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ radio */

const GENRES = ["Lofi", "Pop", "Hip Hop", "Rock", "Jazz", "Electronic", "Classical", "Country", "R&B", "Latin", "Indie", "Chill", "News"];

function StationIcon({ station, className }: { station: Station; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!station.favicon || broken) {
    return (
      <span className={cn("grid shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground", className)}>
        <Icon icon={Radio01Icon} className="size-1/2" />
      </span>
    );
  }
  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded-lg bg-white p-1 ring-1 ring-black/5", className)}>
      <img src={station.favicon} alt="" loading="lazy" className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />
    </span>
  );
}

function StationRow({ station, state }: { station: Station; state: SpeakerState }) {
  const current = state.radio.station?.id === station.id;
  const favorite = state.radio.favorites.some((s) => s.id === station.id);
  const details = [station.country, station.tags.slice(0, 3).join(", "), station.bitrate ? `${station.bitrate} kbps` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/60",
        current && "bg-primary/5",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none"
        onClick={() => (current ? window.speaker.radioStop() : window.speaker.radioPlay(station))}
      >
        <span className="relative">
          <StationIcon station={station} className="size-10" />
          <span
            className={cn(
              "absolute inset-0 grid place-items-center rounded-lg bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100",
              current && "opacity-100",
            )}
          >
            {current && state.radio.status === "playing" ? (
              <Equalizer playing />
            ) : (
              <Icon icon={current ? StopIcon : PlayIcon} className="size-4" />
            )}
          </span>
        </span>
        <span className="min-w-0">
          <span className={cn("block truncate text-[13px] font-medium", current && "text-primary")}>{station.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{details}</span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100",
          favorite && "text-amber-500 opacity-100",
        )}
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => window.speaker.radioFavorite(station, !favorite)}
      >
        <Icon icon={StarIcon} className={cn("size-4", favorite && "[&_path]:fill-current")} />
      </Button>
    </div>
  );
}

function StationList({ title, stations, state }: { title: string; stations: Station[]; state: SpeakerState }) {
  if (!stations.length) return null;
  return (
    <section>
      <h2 className="mb-2 px-1 text-[13px] font-semibold">{title}</h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">
        {stations.map((station) => (
          <StationRow key={station.id} station={station} state={state} />
        ))}
      </div>
    </section>
  );
}

function RadioPage({ state }: { state: SpeakerState }) {
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState<string | null>(null);
  const [results, setResults] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    const timer = setTimeout(
      async () => {
        setLoading(true);
        const result = await window.speaker.radioBrowse(q ? { q } : genre ? { tag: genre.toLowerCase() } : {});
        if (cancelled) return;
        setResults(result.stations);
        setError(result.ok ? "" : result.error ?? "");
        setLoading(false);
      },
      q ? 350 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, genre]);

  const heading = query.trim() ? `Results for “${query.trim()}”` : genre ? genre : "Popular stations";
  const browsing = !query.trim() && !genre;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader state={state} title="Radio" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 pt-1 pb-10">
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Icon icon={Search01Icon} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search 30,000+ stations"
                className="h-9 pl-9"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {GENRES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setGenre(genre === name ? null : name);
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    genre === name && !query.trim()
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card text-foreground/80 hover:bg-muted",
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {browsing && <StationList title="Favorites" stations={state.radio.favorites} state={state} />}
          {browsing && (
            <StationList
              title="Recently played"
              stations={state.radio.recent.filter((r) => !state.radio.favorites.some((f) => f.id === r.id)).slice(0, 5)}
              state={state}
            />
          )}

          <section>
            <h2 className="mb-2 px-1 text-[13px] font-semibold">{heading}</h2>
            {loading ? (
              <div className="grid place-items-center rounded-xl border bg-card py-10 text-muted-foreground">
                <Icon icon={Loading03Icon} className="size-5 animate-spin" />
              </div>
            ) : error ? (
              <p className="rounded-xl border bg-card p-4 text-sm text-destructive">{error}</p>
            ) : results.length ? (
              <div className="divide-y overflow-hidden rounded-xl border bg-card">
                {results.map((station) => (
                  <StationRow key={station.id} station={station} state={state} />
                ))}
              </div>
            ) : (
              <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">No stations found.</p>
            )}
          </section>
          <p className="px-1 text-xs text-muted-foreground">
            Stations come from <ExternalLink href="https://www.radio-browser.info">Radio Browser</ExternalLink>, a free,
            community-run directory.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function Section({ title, footer, children }: { title: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-[13px] font-semibold">{title}</h2>
      <div className="divide-y overflow-hidden rounded-xl border bg-card">{children}</div>
      {footer && <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">{footer}</p>}
    </section>
  );
}

function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-13 items-center gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium">
          {label}
        </label>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

function AppUpdateSection({ state }: { state: SpeakerState }) {
  const { update } = state;
  if (!update.supported) return null;
  const description: Record<typeof update.status, string> = {
    idle: "Checks for new versions automatically",
    checking: "Checking…",
    downloading: `Downloading version ${update.version} (${update.percent}%)`,
    ready: update.canInstall
      ? `Version ${update.version} is ready. Restarting asks for admin approval.`
      : `Version ${update.version} is ready`,
    available: `Version ${update.version} is available to download`,
    current: "You're on the latest version",
    error: update.error,
  };
  const actionable = update.status === "ready" || update.status === "available";
  return (
    <Section title="Office Speaker">
      <Row label={`Version ${state.version}`} description={description[update.status]}>
        {actionable ? (
          <Button type="button" size="sm" onClick={() => window.speaker.appUpdateInstall()}>
            {update.status === "ready" ? "Restart to update" : "Download…"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={update.status === "checking" || update.status === "downloading"}
            onClick={() => window.speaker.appUpdateCheck()}
          >
            <Icon icon={Refresh01Icon} className={cn(update.status === "checking" && "animate-spin")} />
            Check for updates
          </Button>
        )}
      </Row>
    </Section>
  );
}

function Settings({ state }: { state: SpeakerState }) {
  const [name, setName] = useState(state.settings.name);
  const [savingName, setSavingName] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyNote, setKeyNote] = useState("");
  const [updateNote, setUpdateNote] = useState("");
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const nameChanged = name.trim() !== state.settings.name && name.trim() !== "";

  useEffect(() => {
    if (!savingName) setName(state.settings.name);
  }, [state.settings.name]);

  const save = (patch: { name?: string; openAtLogin?: boolean; apiKey?: string; airplay?: boolean; remote?: boolean }) =>
    window.speaker.saveSettings({
      name: patch.name ?? state.settings.name,
      // Only send this when it's the switch being changed, so other saves can't flip it.
      openAtLogin: patch.openAtLogin,
      apiKey: patch.apiKey,
      airplay: patch.airplay,
      remote: patch.remote,
    });

  const saveName = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!nameChanged) return;
    setSavingName(true);
    await save({ name: name.trim() });
    setSavingName(false);
  };

  const saveKey = async (event: FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim()) return;
    const result = await save({ apiKey: apiKey.trim() });
    setApiKey("");
    setEditingKey(false);
    setKeyNote(result.ok ? "Key replaced. The speaker restarted with it." : result.error);
  };

  const { soloist } = state;
  const daysLeft = soloist.daysLeft === null ? null : Math.max(soloist.daysLeft, 0);
  const expiresSoon = daysLeft !== null && daysLeft <= 14;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader state={state} title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-xl flex-col gap-7 px-8 pt-2 pb-10">
          <Section title="Speaker" footer="Renaming restarts the speaker, which disconnects whoever is playing.">
            <form onSubmit={saveName}>
              <Row label="Name in Spotify" htmlFor="speaker-name">
                <Input
                  id="speaker-name"
                  ref={nameRef}
                  value={name}
                  maxLength={60}
                  spellCheck={false}
                  autoComplete="off"
                  className="h-8 w-52"
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setName(state.settings.name);
                  }}
                />
                {nameChanged && (
                  <Button type="submit" size="sm" disabled={savingName}>
                    {savingName ? "Saving…" : "Save"}
                  </Button>
                )}
              </Row>
            </form>
            <Row
              label="Start with this computer"
              htmlFor="login"
              description={state.packaged ? "Back on its own after a restart" : "Only in the installed app"}
            >
              <Switch
                id="login"
                disabled={!state.packaged}
                checked={state.settings.openAtLogin}
                onCheckedChange={(checked) => save({ openAtLogin: checked })}
              />
            </Row>
          </Section>

          <AppUpdateSection state={state} />

          <Section
            title="AirPlay"
            footer={
              state.airplay.supported
                ? "People with an iPhone, iPad or Mac can play here from Apple Music or any app. Whoever plays last takes over, whether that's AirPlay or Spotify."
                : "Macs have an AirPlay receiver built in. Turn on AirPlay Receiver and set Allow AirPlay for to Anyone on the same network. Its name is this Mac's name."
            }
          >
            {state.airplay.supported ? (
              <Row
                label="AirPlay receiver"
                htmlFor="airplay"
                description={
                  state.airplay.enabled
                    ? state.airplay.running
                      ? `Visible as ${state.settings.name}`
                      : "Starting…"
                    : "Off"
                }
              >
                <Switch
                  id="airplay"
                  checked={state.airplay.enabled}
                  onCheckedChange={(checked) => save({ airplay: checked })}
                />
              </Row>
            ) : (
              <Row label="AirPlay receiver" description="Built into macOS">
                <Button type="button" variant="outline" size="sm" onClick={() => window.speaker.openAirPlaySettings()}>
                  Open Settings…
                </Button>
              </Row>
            )}
          </Section>

          <Section
            title="Phone page"
            footer="Anyone on this Wi-Fi can open it to see what's playing and pick a radio station. No app needed."
          >
            <Row
              label="Let phones pick radio stations"
              htmlFor="remote"
              description={state.remote.enabled ? state.remote.url ?? "Starting…" : "Off"}
            >
              <Switch id="remote" checked={state.remote.enabled} onCheckedChange={(checked) => save({ remote: checked })} />
            </Row>
            {state.remote.enabled && state.remote.qr && (
              <div className="flex items-center gap-4 px-4 py-3">
                <img src={state.remote.qr} alt="QR code for the phone page" className="size-20 rounded-md bg-white p-1" />
                <p className="text-xs text-muted-foreground">
                  <Icon icon={QrCodeIcon} className="mr-1 inline size-3.5 align-[-2px]" />
                  Scan with a phone camera, or print it and stick it next to the speaker.
                </p>
              </div>
            )}
          </Section>

          <Section
            title="Spotify Soloist"
            footer={
              <>
                Spotify's official player. Each version works for 90 days, and Office Speaker installs new ones
                between songs. <ExternalLink href={SOLOIST_URL}>About Soloist</ExternalLink>
              </>
            }
          >
            <Row label="Version" description={updateNote || undefined}>
              <span className="text-[13px] text-muted-foreground tabular-nums">{soloist.version ?? "—"}</span>
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
                {checking ? "Checking…" : "Check for updates"}
              </Button>
            </Row>
            <Row label="Time left on this version">
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className={cn("h-full rounded-full", expiresSoon ? "bg-destructive" : "bg-primary")}
                  style={{ width: `${daysLeft === null ? 0 : Math.min(1, daysLeft / BUILD_LIFETIME_DAYS) * 100}%` }}
                />
              </div>
              <span className={cn("w-16 text-right text-[13px] text-muted-foreground tabular-nums", expiresSoon && "text-destructive")}>
                {daysLeft === null ? "—" : `${daysLeft} days`}
              </span>
            </Row>
            {editingKey ? (
              <form onSubmit={saveKey}>
                <Row label="API key" htmlFor="api-key">
                  <Input
                    id="api-key"
                    type="password"
                    autoFocus
                    value={apiKey}
                    placeholder="Paste the new key"
                    autoComplete="off"
                    className="h-8 w-48"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingKey(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!apiKey.trim()}>
                    Save
                  </Button>
                </Row>
              </form>
            ) : (
              <Row
                label="API key"
                description={keyNote || (state.hasApiKey ? "Saved and encrypted on this computer" : "Not set")}
              >
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingKey(true)}>
                  Replace…
                </Button>
              </Row>
            )}
          </Section>

          <Section title="Troubleshooting">
            <Row label="Logs" description="Copy what the speaker has been doing, to share when something's wrong">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await window.speaker.copyLogs();
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                <Icon icon={copied ? CheckmarkCircle02Icon : Copy01Icon} />
                {copied ? "Copied" : "Copy logs"}
              </Button>
            </Row>
          </Section>
        </div>
      </div>
    </div>
  );
}
