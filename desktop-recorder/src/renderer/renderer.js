const api = window.meetSumCapture

const state = {
  mediaRecorder: null,
  chunks: [],
  startedAt: null,
  timer: null,
  mixedStream: null,
  micStream: null,
  systemStream: null,
}

const elements = {
  meetSumUrl: document.querySelector("#meetSumUrl"),
  apiKey: document.querySelector("#apiKey"),
  language: document.querySelector("#language"),
  saveConfig: document.querySelector("#saveConfig"),
  title: document.querySelector("#title"),
  microphone: document.querySelector("#microphone"),
  systemSource: document.querySelector("#systemSource"),
  status: document.querySelector("#status"),
  timer: document.querySelector("#timer"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  spool: document.querySelector("#spool"),
  openSpool: document.querySelector("#openSpool"),
}

function setStatus(message) {
  elements.status.textContent = message
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop())
}

async function refreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const microphones = devices.filter((device) => device.kind === "audioinput")
  elements.microphone.replaceChildren(
    ...microphones.map((device) => {
      const option = document.createElement("option")
      option.value = device.deviceId
      option.textContent = device.label || "Microphone"
      return option
    })
  )

  const sources = await api.listSources()
  elements.systemSource.replaceChildren(
    ...sources.map((source) => {
      const option = document.createElement("option")
      option.value = source.id
      option.textContent = source.name
      return option
    })
  )
}

async function refreshConfig() {
  const config = await api.readConfig()
  if (!config) return
  elements.meetSumUrl.value = config.meetSumUrl || ""
  elements.apiKey.value = config.apiKey || ""
  elements.language.value = config.defaultLanguage || "mixed"
}

async function refreshSpool() {
  const captures = await api.listSpool()
  if (!captures.length) {
    elements.spool.textContent = "No pending captures."
    return
  }

  elements.spool.replaceChildren(
    ...captures.map((capture) => {
      const row = document.createElement("div")
      const label = document.createElement("span")
      const button = document.createElement("button")

      row.className = "spool-row"
      label.textContent = `${capture.meeting.title} · ${capture.status}`
      button.textContent = "Upload"
      button.addEventListener("click", async () => {
        button.disabled = true
        setStatus(`Uploading ${capture.meeting.title}`)
        try {
          await api.uploadCapture(capture.id)
          setStatus("Upload complete")
        } catch (error) {
          setStatus(error.message || "Upload failed")
        }
        await refreshSpool()
        button.disabled = false
      })
      row.append(label, button)
      return row
    })
  )
}

async function createMixedStream() {
  const selectedMic = elements.microphone.selectedOptions[0]
  const selectedSystem = elements.systemSource.selectedOptions[0]
  const systemStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: elements.systemSource.value,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: elements.systemSource.value,
      },
    },
  })
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: elements.microphone.value
      ? { deviceId: { exact: elements.microphone.value } }
      : true,
    video: false,
  })
  const context = new AudioContext({ sampleRate: 48000 })
  const destination = context.createMediaStreamDestination()
  const compressor = context.createDynamicsCompressor()
  const micGain = context.createGain()
  const systemGain = context.createGain()

  micGain.gain.value = 0.9
  systemGain.gain.value = 0.8
  compressor.threshold.value = -18
  compressor.knee.value = 18
  compressor.ratio.value = 6
  compressor.attack.value = 0.01
  compressor.release.value = 0.18

  context.createMediaStreamSource(micStream).connect(micGain).connect(compressor)
  context
    .createMediaStreamSource(systemStream)
    .connect(systemGain)
    .connect(compressor)
  compressor.connect(destination)

  state.micStream = micStream
  state.systemStream = systemStream
  state.mixedStream = destination.stream
  state.sampleRate = context.sampleRate
  state.microphoneName = selectedMic?.textContent || undefined
  state.systemAudioName = selectedSystem?.textContent || undefined

  return destination.stream
}

async function startRecording() {
  state.chunks = []
  state.startedAt = new Date()
  const stream = await createMixedStream()
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm"

  state.mediaRecorder = new MediaRecorder(stream, { mimeType })
  state.mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) state.chunks.push(event.data)
  })
  state.mediaRecorder.start(1000)
  state.timer = setInterval(() => {
    elements.timer.textContent = formatDuration(Date.now() - state.startedAt)
  }, 500)
  elements.start.disabled = true
  elements.stop.disabled = false
  setStatus("Recording")
}

async function stopRecording() {
  const recorder = state.mediaRecorder
  if (!recorder) return

  const endedAt = new Date()
  const stopped = new Promise((resolve) =>
    recorder.addEventListener("stop", resolve, { once: true })
  )

  recorder.stop()
  await stopped
  clearInterval(state.timer)
  stopStream(state.mixedStream)
  stopStream(state.micStream)
  stopStream(state.systemStream)

  const blob = new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" })
  const manifest = await api.saveCapture({
    title: elements.title.value || "Desktop recording",
    startedAt: state.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    language: elements.language.value,
    microphoneName: state.microphoneName,
    systemAudioName: state.systemAudioName,
    sampleRate: state.sampleRate,
    durationMs: endedAt.getTime() - state.startedAt.getTime(),
    media: {
      bytes: await blob.arrayBuffer(),
      contentType: blob.type || "audio/webm",
    },
  })

  elements.start.disabled = false
  elements.stop.disabled = true
  elements.timer.textContent = "00:00"
  setStatus(`Spooled ${manifest.meeting.title}`)
  await refreshSpool()
}

elements.saveConfig.addEventListener("click", async () => {
  await api.saveConfig({
    meetSumUrl: elements.meetSumUrl.value,
    apiKey: elements.apiKey.value,
    defaultLanguage: elements.language.value,
  })
  setStatus("Connection saved")
})
elements.start.addEventListener("click", () =>
  startRecording().catch((error) => setStatus(error.message || "Capture failed"))
)
elements.stop.addEventListener("click", () =>
  stopRecording().catch((error) => setStatus(error.message || "Stop failed"))
)
elements.openSpool.addEventListener("click", () => api.openSpoolFolder())

void refreshConfig()
void refreshDevices()
void refreshSpool()
