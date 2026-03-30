import asyncio
from dataclasses import dataclass
import json
from typing import Optional, Set

import cv2
import uvicorn
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import VideoStreamTrack
from av import VideoFrame
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO


# ----------------------------
# Distance estimation constants
# ----------------------------
REAL_WIDTH_METERS = 0.5
FOCAL_LENGTH = 600.0
PERSON_CLASS_ID = 0  # COCO "person"


def estimate_distance(pixel_width: float) -> float:
    """Distance = (Real Width * Focal Length) / Pixel Width."""
    if pixel_width <= 0:
        return float("inf")
    return (REAL_WIDTH_METERS * FOCAL_LENGTH) / pixel_width


async def to_thread(func, /, *args, **kwargs):
    """Compatibility wrapper around asyncio.to_thread (keeps code tidy)."""
    return await asyncio.to_thread(func, *args, **kwargs)


@dataclass(frozen=True)
class PersonBox:
    x1: int
    y1: int
    x2: int
    y2: int
    distance_m: float


class VideoTransformTrack(VideoStreamTrack):
    """
    Receives frames from the browser, runs YOLOv8n inference (person only),
    draws bounding boxes + distance labels, and returns the modified frames.
    """

    kind = "video"

    def __init__(
        self,
        track: VideoStreamTrack,
        model: YOLO,
        *,
        inference_every_n_frames: int = 6,
        imgsz: int = 320,
        spatial_data_channel=None,
        is_pc_connected=None,
    ):
        super().__init__()  # VideoStreamTrack init
        self.track = track
        self.model = model
        self.inference_every_n_frames = max(1, int(inference_every_n_frames))
        self.imgsz = int(imgsz)
        self.spatial_data_channel = spatial_data_channel
        self.is_pc_connected = is_pc_connected

        # Low-latency strategy:
        # - Reader pulls frames ASAP and overwrites the latest frame (drops backlog).
        # - Processor consumes only the most recent frame.
        # - Output queue maxsize=1 drops old processed frames if the client can't keep up.
        self._latest_frame: Optional[VideoFrame] = None
        self._latest_event = asyncio.Event()
        self._stopped = asyncio.Event()
        self._out_queue: asyncio.Queue[VideoFrame] = asyncio.Queue(maxsize=1)

        self._frame_index = 0
        self._last_boxes: list[PersonBox] = []
        self._last_logged_frame = -10**9

        self._reader_task = asyncio.create_task(self._reader_loop())
        self._processor_task = asyncio.create_task(self._processor_loop())

    async def _reader_loop(self) -> None:
        try:
            while not self._stopped.is_set():
                frame = await self.track.recv()
                self._latest_frame = frame  # overwrite old frames
                self._latest_event.set()
        except Exception:
            self._stopped.set()
            self._latest_event.set()

    async def _processor_loop(self) -> None:
        try:
            while not self._stopped.is_set():
                await self._latest_event.wait()
                self._latest_event.clear()

                frame = self._latest_frame
                if frame is None:
                    continue

                self._frame_index += 1
                img = frame.to_ndarray(format="bgr24")

                run_inference = (self._frame_index % self.inference_every_n_frames) == 0
                if run_inference:
                    results = await to_thread(
                        self.model.predict,
                        img,
                        classes=[PERSON_CLASS_ID],
                        imgsz=self.imgsz,
                        verbose=False,
                    )

                    boxes: list[PersonBox] = []
                    img_width = img.shape[1] if img is not None and len(img.shape) >= 2 else 1
                    for result in results:
                        if result.boxes is None:
                            continue
                        for box in result.boxes:
                            cls_id = int(box.cls[0].item())
                            if cls_id != PERSON_CLASS_ID:
                                continue
                            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                            pixel_width = max(x2 - x1, 1)
                            distance_m = estimate_distance(pixel_width)
                            boxes.append(
                                PersonBox(
                                    x1=x1,
                                    y1=y1,
                                    x2=x2,
                                    y2=y2,
                                    distance_m=distance_m,
                                )
                            )
                    self._last_boxes = boxes

                    # Reduce console spam; logging can become a bottleneck too.
                    if self._last_boxes and (
                        self._frame_index - self._last_logged_frame
                    ) >= self.inference_every_n_frames:
                        closest = min(self._last_boxes, key=lambda b: b.distance_m)
                        print(
                            f"Person detected at {closest.distance_m:.1f} meters",
                            flush=True,
                        )
                        self._last_logged_frame = self._frame_index

                    # Send spatial audio + UI hints for the closest person
                    if self._last_boxes:
                        closest = min(self._last_boxes, key=lambda b: b.distance_m)
                        center_x = (closest.x1 + closest.x2) / 2.0
                        normalized_center = max(0.0, min(1.0, center_x / max(img_width, 1)))
                        pan = (normalized_center * 2.0) - 1.0  # 0..1 => -1..1
                        payload = {
                            "distance": round(float(closest.distance_m), 2),
                            "pan": round(float(pan), 2),
                            "label": "person",
                        }
                        dc = self.spatial_data_channel
                        try:
                            # Safety: send only when channel is open.
                            pc_ready = bool(self.is_pc_connected()) if callable(self.is_pc_connected) else True
                            if pc_ready and dc is not None and dc.readyState == "open":
                                dc.send(json.dumps(payload))
                        except Exception:
                            # Don't break the video pipeline if datachannel send fails
                            pass

                # Draw last known detections on every frame for fluid video
                for b in self._last_boxes:
                    cv2.rectangle(img, (b.x1, b.y1), (b.x2, b.y2), (0, 255, 0), 2)
                    cv2.putText(
                        img,
                        f"Person: {b.distance_m:.1f} m",
                        (b.x1, max(b.y1 - 10, 20)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 255, 0),
                        2,
                    )

                out = VideoFrame.from_ndarray(img, format="bgr24")
                out.pts = frame.pts
                out.time_base = frame.time_base

                # Drop-frame strategy: keep only the newest processed frame.
                if self._out_queue.full():
                    try:
                        self._out_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                try:
                    self._out_queue.put_nowait(out)
                except asyncio.QueueFull:
                    pass
        except Exception:
            self._stopped.set()

    async def recv(self) -> VideoFrame:
        return await self._out_queue.get()

    def stop(self) -> None:
        if not self._stopped.is_set():
            self._stopped.set()
            self._latest_event.set()
        for task in (getattr(self, "_reader_task", None), getattr(self, "_processor_task", None)):
            if task is not None:
                task.cancel()
        super().stop()


class OfferPayload(BaseModel):
    sdp: str
    type: str


app = FastAPI()

# Phone over local Wi-Fi needs CORS + reachable host.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pcs: Set[RTCPeerConnection] = set()
model: Optional[YOLO] = None
model_lock = asyncio.Lock()


async def get_model() -> YOLO:
    global model
    if model is not None:
        return model

    async with model_lock:
        if model is not None:
            return model
        # Load YOLO model once on first request
        model = await to_thread(YOLO, "yolov8n.pt")
        return model


@app.post("/offer")
async def offer(payload: OfferPayload):
    """
    Receives an SDP offer from the browser, attaches a VideoTransformTrack
    (YOLO person-only processing), and returns an SDP answer.
    """
    pc = RTCPeerConnection()
    pcs.add(pc)

    try:
        # Pre-negotiated data channel to avoid discovery-event handshake issues.
        spatial_dc = pc.createDataChannel("vision-data", negotiated=True, id=0)
        print(f"Data Channel {spatial_dc.label} created", flush=True)

        @spatial_dc.on("open")
        def on_spatial_dc_open():
            print("DATA CHANNEL IS OPEN", flush=True)

        _model = await get_model()
        processed_added = False

        @pc.on("track")
        def on_track(track):
            # Attach our processed outgoing track once the browser starts sending.
            nonlocal processed_added
            if track.kind == "video" and not processed_added:
                processed_added = True
                processed_track = VideoTransformTrack(
                    track,
                    _model,
                    spatial_data_channel=spatial_dc,
                    is_pc_connected=lambda: pc.connectionState == "connected",
                )
                pc.addTrack(processed_track)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in ("failed", "closed", "disconnected"):
                await pc.close()
                pcs.discard(pc)

        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=payload.sdp, type=payload.type)
        )

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
        }
    except Exception as e:
        await pc.close()
        pcs.discard(pc)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    # Must be reachable from LAN (phone over Wi-Fi)
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
