//! Office Speaker engine.
//!
//! Advertises this computer as a Spotify Connect speaker on the local network
//! (the same way Music Assistant / raspotify do, via librespot) and plays audio
//! through the computer's sound output. Anyone on the same network can pick it
//! in their Spotify app; nobody signs in on this computer.
//!
//! The Electron app runs this as a child process:
//! - stdout: one JSON object per line describing what is happening
//! - stdin: one command per line (play, pause, next, prev, disconnect, volume <0-100>)
//! - stdin closing means the app went away, so the engine shuts down.
//!
//! Credentials handed over by a phone are kept in memory only.

use std::{process::exit, time::Duration};

use cpal::traits::{DeviceTrait, HostTrait};
use futures_util::StreamExt;
use librespot::{
    connect::{ConnectConfig, Spirc},
    core::{
        authentication::Credentials,
        config::{DeviceType, SessionConfig},
        session::Session,
    },
    discovery::Discovery,
    metadata::audio::UniqueFields,
    playback::{
        audio_backend,
        config::{AudioFormat, Bitrate, PlayerConfig},
        mixer::{self, MixerConfig},
        player::{Player, PlayerEvent},
    },
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

const DISCOVERY_RETRY: Duration = Duration::from_secs(10);

struct Options {
    name: String,
    device_id: String,
    output: Option<String>,
    bitrate: Bitrate,
    volume_percent: u16,
    normalize: bool,
}

fn emit(value: Value) {
    // stdout is line buffered, so every event reaches the app immediately.
    println!("{value}");
}

fn usage_error(message: &str) -> ! {
    emit(json!({ "type": "fatal", "message": message }));
    exit(2);
}

fn parse_args() -> Options {
    let mut options = Options {
        name: "Office Speaker".into(),
        device_id: String::new(),
        output: None,
        bitrate: Bitrate::Bitrate320,
        volume_percent: 50,
        normalize: true,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .unwrap_or_else(|| usage_error(&format!("{arg} needs a value")))
        };
        match arg.as_str() {
            "--list-outputs" => {
                list_outputs();
                exit(0);
            }
            "--name" => options.name = value(),
            "--device-id" => options.device_id = value(),
            "--output" => {
                let output = value();
                options.output = (!output.is_empty()).then_some(output);
            }
            "--bitrate" => {
                options.bitrate = match value().as_str() {
                    "96" => Bitrate::Bitrate96,
                    "160" => Bitrate::Bitrate160,
                    "320" => Bitrate::Bitrate320,
                    other => usage_error(&format!("unsupported bitrate {other}")),
                }
            }
            "--volume" => {
                options.volume_percent = value()
                    .parse::<u16>()
                    .ok()
                    .filter(|v| *v <= 100)
                    .unwrap_or_else(|| usage_error("--volume must be 0-100"))
            }
            "--no-normalize" => options.normalize = false,
            other => usage_error(&format!("unknown argument {other}")),
        }
    }
    if options.name.trim().is_empty() {
        usage_error("--name cannot be empty");
    }
    if options.device_id.is_empty() {
        usage_error("--device-id is required");
    }
    options
}

fn list_outputs() {
    let host = cpal::default_host();
    let default = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    let outputs: Vec<String> = host
        .output_devices()
        .map(|devices| devices.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    emit(json!({ "type": "outputs", "default": default, "outputs": outputs }));
}

fn player_event_json(event: PlayerEvent) -> Option<Value> {
    Some(match event {
        PlayerEvent::TrackChanged { audio_item } => {
            let cover = audio_item
                .covers
                .iter()
                .max_by_key(|cover| cover.width)
                .map(|cover| cover.url.clone());
            let (artist, album) = match &audio_item.unique_fields {
                UniqueFields::Track { artists, album, .. } => (
                    artists
                        .0
                        .iter()
                        .map(|a| a.name.clone())
                        .collect::<Vec<_>>()
                        .join(", "),
                    album.clone(),
                ),
                UniqueFields::Local {
                    artists, album, ..
                } => (
                    artists.clone().unwrap_or_default(),
                    album.clone().unwrap_or_default(),
                ),
                UniqueFields::Episode { show_name, .. } => (show_name.clone(), String::new()),
            };
            json!({
                "type": "track",
                "title": audio_item.name,
                "artist": artist,
                "album": album,
                "cover": cover,
                "durationMs": audio_item.duration_ms,
                "uri": audio_item.uri,
            })
        }
        PlayerEvent::Playing { position_ms, .. } => {
            json!({ "type": "playing", "positionMs": position_ms })
        }
        PlayerEvent::Paused { position_ms, .. } => {
            json!({ "type": "paused", "positionMs": position_ms })
        }
        PlayerEvent::Stopped { .. } => json!({ "type": "stopped" }),
        PlayerEvent::Seeked { position_ms, .. } => {
            json!({ "type": "seeked", "positionMs": position_ms })
        }
        PlayerEvent::VolumeChanged { volume } => json!({
            "type": "volume",
            "percent": (u32::from(volume) * 100 + u32::from(u16::MAX) / 2) / u32::from(u16::MAX),
        }),
        PlayerEvent::SessionConnected { user_name, .. } => {
            json!({ "type": "session", "user": user_name })
        }
        PlayerEvent::SessionDisconnected { .. } => json!({ "type": "session_ended" }),
        PlayerEvent::SessionClientChanged {
            client_name,
            client_brand_name,
            client_model_name,
            ..
        } => json!({
            "type": "client",
            "name": client_name,
            "brand": client_brand_name,
            "model": client_model_name,
        }),
        PlayerEvent::Unavailable { .. } => json!({ "type": "unavailable" }),
        _ => return None,
    })
}

fn launch_discovery(options: &Options, session_config: &SessionConfig) -> Option<Discovery> {
    #[cfg(target_os = "macos")]
    let backend = librespot::discovery::find(Some("dns-sd"));
    #[cfg(not(target_os = "macos"))]
    let backend = librespot::discovery::find(Some("libmdns"));

    let backend = match backend {
        Ok(backend) => backend,
        Err(e) => usage_error(&format!("no zeroconf backend: {e}")),
    };

    match Discovery::builder(
        session_config.device_id.clone(),
        session_config.client_id.clone(),
    )
    .name(options.name.clone())
    .device_type(DeviceType::Speaker)
    .zeroconf_backend(backend)
    .launch()
    {
        Ok(discovery) => Some(discovery),
        Err(e) => {
            emit(json!({ "type": "discovery_error", "message": e.to_string() }));
            None
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    env_logger::Builder::new()
        .filter_level(log::LevelFilter::Warn)
        .filter_module("librespot", log::LevelFilter::Info)
        .parse_default_env()
        .target(env_logger::Target::Stderr)
        .init();

    let options = parse_args();

    let session_config = SessionConfig {
        device_id: options.device_id.clone(),
        ..SessionConfig::default()
    };
    let connect_config = ConnectConfig {
        name: options.name.clone(),
        device_type: DeviceType::Speaker,
        initial_volume: ((u32::from(options.volume_percent) * u32::from(u16::MAX)) / 100) as u16,
        ..ConnectConfig::default()
    };
    let player_config = PlayerConfig {
        bitrate: options.bitrate,
        normalisation: options.normalize,
        ..PlayerConfig::default()
    };

    let Some(sink_builder) = audio_backend::find(None) else {
        usage_error("no audio backend compiled in");
    };
    let Some(mixer_builder) = mixer::find(None) else {
        usage_error("no mixer compiled in");
    };
    let mixer = match mixer_builder(MixerConfig::default()) {
        Ok(mixer) => mixer,
        Err(e) => usage_error(&format!("could not open mixer: {e}")),
    };

    let mut session = Session::new(session_config.clone(), None);
    let output = options.output.clone();
    let player = Player::new(
        player_config,
        session.clone(),
        mixer.get_soft_volume(),
        move || sink_builder(output, AudioFormat::default()),
    );

    let mut player_events = player.get_player_event_channel();
    tokio::spawn(async move {
        while let Some(event) = player_events.recv().await {
            if let Some(value) = player_event_json(event) {
                emit(value);
            }
        }
    });

    let mut discovery = launch_discovery(&options, &session_config);
    if discovery.is_some() {
        emit(json!({ "type": "ready", "name": options.name }));
    }

    let mut commands = BufReader::new(tokio::io::stdin()).lines();
    let mut last_credentials: Option<Credentials> = None;
    let mut spirc: Option<Spirc> = None;
    let mut spirc_task: Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>> = None;
    let mut connecting = false;
    let mut reconnects: Vec<tokio::time::Instant> = Vec::new();

    loop {
        tokio::select! {
            // Someone picked this speaker in their Spotify app.
            credentials = async { discovery.as_mut().unwrap().next().await }, if discovery.is_some() => {
                let Some(credentials) = credentials else {
                    emit(json!({ "type": "fatal", "message": "Network discovery stopped" }));
                    exit(1);
                };
                if let Some(spirc) = spirc.take() {
                    let _ = spirc.shutdown();
                }
                if let Some(task) = spirc_task.take() {
                    tokio::spawn(async move { let _ = tokio::time::timeout(Duration::from_secs(5), task).await; });
                }
                if !session.is_invalid() {
                    session.shutdown();
                }
                last_credentials = Some(credentials);
                reconnects.clear();
                connecting = true;
                emit(json!({ "type": "connecting" }));
            },

            // Retry discovery if the network wasn't ready (e.g. launched at login before Wi-Fi).
            _ = tokio::time::sleep(DISCOVERY_RETRY), if discovery.is_none() => {
                discovery = launch_discovery(&options, &session_config);
                if discovery.is_some() {
                    emit(json!({ "type": "ready", "name": options.name }));
                }
            },

            _ = async {}, if connecting && last_credentials.is_some() => {
                connecting = false;
                if session.is_invalid() {
                    session = Session::new(session_config.clone(), None);
                    player.set_session(session.clone());
                }
                match Spirc::new(
                    connect_config.clone(),
                    session.clone(),
                    last_credentials.clone().unwrap(),
                    player.clone(),
                    mixer.clone(),
                ).await {
                    Ok((new_spirc, task)) => {
                        spirc = Some(new_spirc);
                        spirc_task = Some(Box::pin(task));
                    }
                    Err(e) => {
                        emit(json!({ "type": "error", "message": format!("Could not connect to Spotify: {e}") }));
                        last_credentials = None;
                        if !session.is_invalid() {
                            session.shutdown();
                        }
                        emit(json!({ "type": "idle" }));
                    }
                }
            },

            _ = async { spirc_task.as_mut().unwrap().await }, if spirc_task.is_some() && !connecting => {
                spirc_task = None;
                spirc = None;
                reconnects.retain(|t| t.elapsed() < Duration::from_secs(600));
                if last_credentials.is_some() && reconnects.len() < 5 {
                    reconnects.push(tokio::time::Instant::now());
                    if !session.is_invalid() {
                        session.shutdown();
                    }
                    connecting = true;
                    emit(json!({ "type": "connecting" }));
                } else {
                    last_credentials = None;
                    emit(json!({ "type": "error", "message": "Lost the Spotify connection. Pick the speaker again in Spotify." }));
                    emit(json!({ "type": "idle" }));
                }
            },

            _ = async {}, if player.is_invalid() => {
                emit(json!({ "type": "fatal", "message": "Audio player stopped unexpectedly" }));
                exit(1);
            },

            line = commands.next_line() => {
                let command = match line {
                    Ok(Some(line)) => line.trim().to_owned(),
                    // The app closed our stdin: it quit or crashed.
                    _ => break,
                };
                let result = match (command.as_str(), spirc.as_ref()) {
                    ("play", Some(s)) => s.play(),
                    ("pause", Some(s)) => s.pause(),
                    ("next", Some(s)) => s.next(),
                    ("prev", Some(s)) => s.prev(),
                    ("disconnect", _) => {
                        // Drop whoever is connected; the speaker stays visible for the next person.
                        if let Some(s) = spirc.take() {
                            let _ = s.pause();
                            let _ = s.shutdown();
                        }
                        if let Some(task) = spirc_task.take() {
                            tokio::spawn(async move { let _ = tokio::time::timeout(Duration::from_secs(5), task).await; });
                        }
                        if !session.is_invalid() {
                            session.shutdown();
                        }
                        last_credentials = None;
                        connecting = false;
                        emit(json!({ "type": "idle" }));
                        Ok(())
                    }
                    ("quit", _) => break,
                    (volume, Some(s)) if volume.starts_with("volume ") => {
                        match volume["volume ".len()..].trim().parse::<u32>() {
                            Ok(percent) if percent <= 100 => {
                                s.set_volume(((percent * u32::from(u16::MAX)) / 100) as u16)
                            }
                            _ => Ok(()),
                        }
                    }
                    (_, None) => Ok(()),
                    (other, _) => {
                        emit(json!({ "type": "error", "message": format!("Unknown command {other}") }));
                        Ok(())
                    }
                };
                if let Err(e) = result {
                    emit(json!({ "type": "error", "message": e.to_string() }));
                }
            },
        }
    }

    // Graceful shutdown: tell Spotify we're leaving and withdraw the network announcement.
    if let Some(spirc) = spirc.take() {
        let _ = spirc.shutdown();
    }
    if let Some(task) = spirc_task.take() {
        let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
    }
    if let Some(discovery) = discovery.take() {
        let _ = tokio::time::timeout(Duration::from_secs(2), discovery.shutdown()).await;
    }
    exit(0);
}
