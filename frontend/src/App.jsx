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
  const dataChannelRef = useRef(null)

  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('Idle')
  const [error, setError] = useState('')

  // Spatial audio / speech state
  const audioCtxRef = useRef(null)
  const pannerRef = useRef(null)
  const oscRef = useRef(null)
  const beepGainRef = useRef(null)
  const beepLoopTimerRef = useRef(null)
  const beepLoopRunningRef = useRef(false)
  const beepFreqRef = useRef(400) // Hz
  const beepIntervalRef = useRef(600) // ms
  const lastSpokenDistanceRef = useRef(null)
  const lastPersonUpdateAtRef = useRef(0)
  const silenceTimeoutRef = useRef(null)
  const audioReadyRef = useRef(false)

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
        pc.ondatachannel = null
        pc.close()
      } catch {
        // Ignore cleanup errors
      }
    }
    pcRef.current = null
    dataChannelRef.current = null

    const localStream = localStreamRef.current
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop())
    }
    localStreamRef.current = null

    if (processedVideoRef.current) {
      processedVideoRef.current.srcObject = null
    }

    processedStreamRef.current = null

    // Stop spatial audio
    if (beepLoopTimerRef.current) {
      clearTimeout(beepLoopTimerRef.current)
    }
    beepLoopTimerRef.current = null
    beepLoopRunningRef.current = false
    beepFreqRef.current = 400
    beepIntervalRef.current = 600
    if (beepGainRef.current && audioCtxRef.current) {
      // Fade out quickly
      const now = audioCtxRef.current.currentTime
      beepGainRef.current.gain.setValueAtTime(0.0001, now)
    }
    if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current)
    silenceTimeoutRef.current = null

    lastSpokenDistanceRef.current = null
    lastPersonUpdateAtRef.current = 0

    try {
      window.speechSynthesis?.cancel?.()
    } catch {
      // Ignore
    }

    setRunning(false)
    setStatus('Stopped')
  }

  const ensureAudioGraph = () => {
    if (audioReadyRef.current) return
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioContextCtor) throw new Error('Web Audio API not supported in this browser.')

    const ctx = new AudioContextCtor()
    const panner = ctx.createStereoPanner()
    const gain = ctx.createGain()
    gain.gain.value = 0.0001

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = beepFreqRef.current

    osc.connect(gain)
    gain.connect(panner)
    panner.connect(ctx.destination)

    osc.start()

    audioCtxRef.current = ctx
    pannerRef.current = panner
    oscRef.current = osc
    beepGainRef.current = gain
    audioReadyRef.current = true
  }

  const startBeepLoop = () => {
    if (beepLoopRunningRef.current) return
    beepLoopRunningRef.current = true

    const tick = () => {
      if (!beepLoopRunningRef.current) return
      if (!audioReadyRef.current || !audioCtxRef.current || !oscRef.current || !beepGainRef.current) return

      const now = audioCtxRef.current.currentTime
      const freq = beepFreqRef.current
      const intervalMs = beepIntervalRef.current

      oscRef.current.frequency.setValueAtTime(freq, now)

      // Short beep envelope
      beepGainRef.current.gain.cancelScheduledValues(now)
      beepGainRef.current.gain.setValueAtTime(0.0001, now)
      beepGainRef.current.gain.linearRampToValueAtTime(0.25, now + 0.01)
      beepGainRef.current.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)

      beepLoopTimerRef.current = setTimeout(tick, intervalMs)
    }

    tick()
  }

  const stopBeepLoop = () => {
    beepLoopRunningRef.current = false
    if (beepLoopTimerRef.current) clearTimeout(beepLoopTimerRef.current)
    beepLoopTimerRef.current = null

    if (beepGainRef.current && audioCtxRef.current) {
      const now = audioCtxRef.current.currentTime
      beepGainRef.current.gain.setValueAtTime(0.0001, now)
    }
  }

  const scheduleNoPersonTimeout = (ms = 1000) => {
    if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current)
    silenceTimeoutRef.current = setTimeout(() => {
      const elapsed = Date.now() - lastPersonUpdateAtRef.current
      if (elapsed >= ms) {
        stopBeepLoop()
        setStatus('No person detected')
      }
    }, ms + 50)
  }

  const handleMetadata = (data) => {
    const distance = Number(data.distance)
    const pan = Math.max(-1, Math.min(1, Number(data.pan)))
    const label = data.label

    if (label !== 'person') return

    lastPersonUpdateAtRef.current = Date.now()

    // Update pan immediately
    if (pannerRef.current && audioCtxRef.current) {
      pannerRef.current.pan.setValueAtTime(pan, audioCtxRef.current.currentTime)
    }

    // Proximity logic: closer => higher/faster
    const maxDist = 6.0
    const d = Number.isFinite(distance) ? Math.max(0, Math.min(maxDist, distance)) : maxDist
    const closeness = Math.max(0, Math.min(1, 1 - d / maxDist))

    // Frequency + interval mapping
    // closeness=1 => 1000Hz & 120ms, closeness=0 => 250Hz & 600ms
    beepFreqRef.current = 250 + closeness * 750
    beepIntervalRef.current = Math.round(600 - closeness * 480)
    beepIntervalRef.current = Math.max(120, Math.min(600, beepIntervalRef.current))

    startBeepLoop()
    scheduleNoPersonTimeout(1000)

    // Speech synthesis only when distance changes by > 0.5m
    if (Number.isFinite(distance)) {
      const last = lastSpokenDistanceRef.current
      const shouldSpeak = last === null || last === undefined || Math.abs(distance - last) > 0.5
      if (shouldSpeak) {
        lastSpokenDistanceRef.current = distance
        window.speechSynthesis.cancel()
        const utter = new SpeechSynthesisUtterance(
          `Person detected at ${distance.toFixed(1)} meters`
        )
        window.speechSynthesis.speak(utter)
      }
    }
  }

  const startStream = async () => {
    setError('')
    setStatus('Requesting webcam...')

    // Must start after user gesture (button click) for autoplay policy compliance.
    ensureAudioGraph()
    if (audioCtxRef.current?.state === 'suspended') {
      await audioCtxRef.current.resume()
    }

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

    // Pre-negotiated channel: both peers create the exact same label+id.
    const dc = pc.createDataChannel('vision-data', { negotiated: true, id: 0 })
    console.log('PRE-NEGOTIATED CHANNEL CREATED')
    dataChannelRef.current = dc
    dc.onopen = () => {
      console.log('Data Channel STATE: OPEN')
      setStatus('Receiving spatial data...')
    }
    dc.onmessage = (event) => {
      try {
        console.log('DATA RECEIVED:', event.data)
        handleMetadata(JSON.parse(event.data))
      } catch {
        // Ignore malformed messages
      }
    }

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
