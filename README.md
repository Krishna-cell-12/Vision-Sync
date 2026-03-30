# Vision-Sync

Vision-Sync is a real-time, distributed AI assistive system that maps a live visual scene into a 2D spatial audio field for visually impaired users. It combines low-latency video streaming, on-device/backend inference, and directional audio feedback so users can hear *where* a detected person is and roughly *how far away* they are.

## Project Overview

Vision-Sync is engineered as a production-style, real-time perception pipeline rather than a single-script demo:

- Captures live camera frames on a client device.
- Streams frames to a backend for computer vision inference.
- Returns processed video plus metadata (distance + horizontal position).
- Converts metadata into spatialized audio cues and spoken alerts.

The core product goal is to transform visual context into actionable auditory signals in under human-noticeable latency thresholds.

## System Architecture

Vision-Sync follows a Client-Server architecture with clear separation of concerns.

### Edge (Phone / Browser Client)

- **Stack:** React + Vite + WebRTC + Web Audio API
- Captures camera stream with constrained resolution/FPS for low-latency transport.
- Sends video to backend over WebRTC.
- Receives processed video track and metadata over a negotiated WebRTC Data Channel.
- Renders spatial cues using `StereoPannerNode` and proximity beeps via `OscillatorNode`.

### Brain (WSL2/Ubuntu Backend)

- **Stack:** FastAPI + Uvicorn + aiortc + Ultralytics YOLOv8n
- Accepts SDP offers at `/offer` and establishes peer connection.
- Runs real-time person detection and monocular distance estimation:
  - `Distance = (Real Width * Focal Length) / Pixel Width`
- Streams annotated video back to the client.
- Publishes low-latency metadata payloads (`distance`, `pan`, `label`) over Data Channel.

## Engineering Challenges & Solutions

### 1) Challenge: 25-Second Latency (Buffer Bloat)

**Problem:** Early implementations processed every incoming frame sequentially. Inference time exceeded frame arrival time, causing queue growth and multi-second lag.

**Solution:** Re-architected to an asynchronous "leaky bucket" model:

- Dedicated frame reader always pulls newest frame.
- Old frames are dropped instead of queued.
- Inference runs every Nth frame (frame skipping).
- Output queue is bounded (`maxsize=1`) to discard stale processed frames.
- Reuses last known detections between inference frames for visual continuity.

**Result:** Reduced end-to-end latency from ~20-25s to sub-second class performance, targeting **<500ms** interactive behavior.

### 2) Challenge: Secure Contexts on Local Networks

**Problem:** Mobile camera/WebRTC capabilities require secure context (`https`) and trusted certificates; plain local HTTP blocks critical APIs on many devices.

**Solution:** Established local PKI with `mkcert`:

- Generated locally trusted SSL/TLS certificates.
- Served frontend/backend over HTTPS in local Wi-Fi testing setups.
- Enabled cross-device mobile camera access without disabling browser security.

**Result:** Reliable camera + WebRTC functionality from phone to WSL2 backend across local network.

### 3) Challenge: WebRTC Data Channel Synchronization

**Problem:** Dynamic Data Channel discovery (`ondatachannel`) was intermittently silent in the target environment, resulting in "empty console" and no audio metadata updates.

**Solution:** Switched to pre-negotiated Data Channels:

- Explicit channel creation on both peers with:
  - `label: "vision-data"`
  - `negotiated: true`
  - `id: 0`
- Added connection-state gating so metadata sends begin only when transport is ready.
- Added handshake telemetry logs for deterministic debugging.

**Result:** Stable metadata delivery with deterministic channel setup and sub-millisecond channel overhead behavior in normal LAN conditions.

## Technical Stack

- **Vision:** YOLOv8n (Ultralytics), OpenCV
- **Networking/Realtime:** WebRTC (`aiortc`), FastAPI, Uvicorn
- **Frontend:** React, Vite, Web Audio API (`StereoPannerNode`, `OscillatorNode`)
- **Security:** SSL/TLS, local PKI via `mkcert`
- **Runtime Environment:** Python backend on WSL2/Ubuntu, browser client on desktop/mobile

## Features

- **Spatial Audio Mapping**
  - Maps detected person X-coordinate to stereo pan range `[-1.0, 1.0]`.
  - Enables left/right directional localization with headphones.

- **Proximity Audio Feedback**
  - Computes distance from bounding box geometry in real time.
  - Modulates beep pitch and interval by distance (closer = higher/faster).

- **Speech Announcements**
  - Announces distance changes with thresholding to avoid audio clutter.

- **Low-Latency Streaming Pipeline**
  - Frame dropping + inference throttling to prevent queue backlog.
  - Optimized camera constraints for realtime perception.

## Example Metadata Payload

```json
{
  "distance": 1.2,
  "pan": -0.5,
  "label": "person"
}
```

## Why This Project Matters

Vision-Sync demonstrates engineering depth across distributed systems, realtime media, CV inference optimization, and human-centered assistive UX. It is intentionally built to highlight practical system design tradeoffs (latency vs. quality, determinism vs. dynamic negotiation, security vs. developer speed) and production-minded debugging methodology.

