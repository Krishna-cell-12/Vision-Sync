import { useEffect, useMemo, useRef, useState } from 'react'

const DEFAULT_API_BASE = 'http://localhost:8000'

function App() {
  const apiBaseUrl = useMemo(() => {
    // Set this in your environment if the backend isn't on localhost for your phone.
    // Example: VITE_API_BASE_URL=http://192.168.1.50:8000
    return import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE
  }, [])

  const processedVideoRef = useRef(null)
  const pcRef = useRef(null)
  const localStreamRef = useRef(null)
  const processedStreamRef = useRef(null)

  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState('')

  useEffect(() => {
    return () => {
      // Cleanup when React unmounts
      stopStream()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const waitForIceGatheringComplete = async (pc) => {
    if (pc.iceGatheringState === 'complete') return
    await new Promise((resolve) => {
      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', checkState)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', checkState)
    })
  }

  const stopStream = () => {
    const pc = pcRef.current
    if (pc) {
      try {
        pc.ontrack = null
        pc.oniceconnectionstatechange = null
        pc.close()
      } catch {
        // Ignore cleanup errors
      }
    }
    pcRef.current = null

    const localStream = localStreamRef.current
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop())
    }
    localStreamRef.current = null

    if (processedVideoRef.current) {
      processedVideoRef.current.srcObject = null
    }

    processedStreamRef.current = null
    setRunning(false)
    setStatus('Stopped')
  }

  const startStream = async () => {
    setError('')
    setStatus('Requesting webcam...')

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 480 },
        height: { ideal: 360 },
        frameRate: { ideal: 15, max: 15 },
      },
    })
    localStreamRef.current = stream

    processedStreamRef.current = new MediaStream()

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    })
    pcRef.current = pc

    // Explicitly request a processed video stream back from the backend.
    pc.addTransceiver('video', { direction: 'recvonly' })

    pc.oniceconnectionstatechange = () => {
      setStatus(`ICE: ${pc.iceConnectionState}`)
    }

    pc.ontrack = (event) => {
      // Some browsers provide event.streams; others require manually collecting tracks.
      if (!processedStreamRef.current) processedStreamRef.current = new MediaStream()

      const [stream0] = event.streams || []
      if (stream0) {
        processedVideoRef.current.srcObject = stream0
        return
      }

      processedStreamRef.current.addTrack(event.track)
      processedVideoRef.current.srcObject = processedStreamRef.current
    }

    // Send local stream to backend
    stream.getTracks().forEach((track) => pc.addTrack(track, stream))

    // Low-latency sender hints (best-effort; browser may clamp).
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue
      const params = sender.getParameters()
      params.degradationPreference = 'maintain-framerate'
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}]
      }
      params.encodings[0] = {
        ...params.encodings[0],
        maxFramerate: 15,
        maxBitrate: 350_000,
      }
      try {
        // setParameters must be called after addTrack.
        // Some browsers throw if they don't support certain fields.
        // eslint-disable-next-line no-await-in-loop
        await sender.setParameters(params)
      } catch {
        // ignore
      }
    }

    setStatus('Creating WebRTC offer...')
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIceGatheringComplete(pc)

    const response = await fetch(`${apiBaseUrl}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Backend error ${response.status}: ${text}`)
    }

    const answer = await response.json()
    setStatus('Setting remote description...')
    await pc.setRemoteDescription(answer)

    setRunning(true)
    setStatus('Streaming (processed)')
  }

  const onStart = async () => {
    try {
      await startStream()
    } catch (e) {
      stopStream()
      setError(e?.message || String(e))
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Vision-Sync Client-Server Stream</h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button onClick={onStart} disabled={running}>
          Start Stream
        </button>
        <button onClick={stopStream} disabled={!running}>
          Stop Stream
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>Status:</strong> {status}
      </div>
      {error ? (
        <div style={{ color: 'crimson', marginBottom: 12 }}>
          <strong>Error:</strong> {error}
        </div>
      ) : null}

      <div>
        <video
          ref={processedVideoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: 640,
            maxWidth: '100%',
            borderRadius: 8,
            background: '#111',
          }}
        />
      </div>
    </div>
  )
}


export default App
