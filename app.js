const face = document.getElementById("face");
const bodyLayer = document.getElementById("bodyLayer");
const mouth = document.getElementById("mouth");
const statusEl = document.getElementById("status");
const speechEl = document.getElementById("speech");
const userTextEl = document.getElementById("userText");
const talkBtn = document.getElementById("talkBtn");
const modelIntellectualBtn = document.getElementById("modelIntellectual");
const modelLightBtn = document.getElementById("modelLight");
const modelAdultBtn = document.getElementById("modelAdult");

let stream = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let micReady = false;
let replyCooldown = false;
let currentAudio = null;
let requestInFlight = false;
let smoothedFrame = 0;
let modelSwitchInFlight = false;
let currentModelKey = "intellectual";
let blinkHandle = null;
let blinkEnabled = true;
let adultIdleTimer = null;
let latestImageBase64 = "";
let imageCaptureHandle = null;

/* CONVERSATION MODE */

let conversationMode = false;
let audioContext = null;
let analyser = null;
let dataArray = null;
let monitorHandle = null;
let speechFrames = 0;
let silenceFrames = 0;
let recordingStartedAt = 0;

/* BODY SWAY */

let bodyFrameIndex = 0;
let bodyDirection = 1;
let bodyAnimationHandle = null;
let bodySpeed = 180;

/* AVATAR FRAMES */

const idleFaceFrame = "/static/frames/talk.png";
const idleBodyFrame = "/static/frames/body.png";

const cameraVideo = document.getElementById("cameraVideo");

const talkFrames = [
  "/static/frames/talk01.png",
  "/static/frames/talk02.png",
  "/static/frames/talk03.png",
  "/static/frames/talk04.png",
  "/static/frames/talk05.png",
  "/static/frames/talk06.png",
  "/static/frames/talk07.png",
  "/static/frames/talk08.png",
  "/static/frames/talk09.png",
  "/static/frames/talk10.png"
];

const bodyFrames = [
  "/static/frames/body01.png",
  "/static/frames/body02.png",
  "/static/frames/body03.png",
  "/static/frames/body04.png",
  "/static/frames/body05.png",
  "/static/frames/body06.png",
  "/static/frames/body07.png",
  "/static/frames/body08.png",
  "/static/frames/body09.png",
  "/static/frames/body10.png",
  "/static/frames/body11.png",
  "/static/frames/body12.png",
  "/static/frames/body13.png",
  "/static/frames/body14.png",
  "/static/frames/body15.png",
  "/static/frames/body16.png",
  "/static/frames/body17.png",
  "/static/frames/body18.png",
  "/static/frames/body19.png",
];

let avatarFramesReady = false;

/* PLAYBACK LIP SYNC */

let lipSyncHandle = null;
let playbackAudioContext = null;
let playbackAnalyser = null;
let playbackDataArray = null;
let playbackSource = null;

function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => reject(src);
    img.src = src;
  });
}

async function preloadAvatarFrames() {
  const allFrames = [idleFaceFrame, idleBodyFrame, ...talkFrames, ...bodyFrames];

  try {
    await Promise.all(allFrames.map(preloadImage));
    avatarFramesReady = true;
    console.log("All avatar frames loaded");
  } catch (src) {
    console.error("Failed to load avatar frame:", src);
  }
}

function setFaceFrame(src) {
  face.style.backgroundImage = `url(${src})`;
}

function setBodyFrame(src) {
  bodyLayer.style.backgroundImage = `url(${src})`;
}

function clearAdultIdleTimer() {
  if (adultIdleTimer) {
    clearTimeout(adultIdleTimer);
    adultIdleTimer = null;
  }
}

function resetAdultIdleTimer() {
  clearAdultIdleTimer();

  if (!conversationMode) return;
  if (currentModelKey !== "adult") return;

  adultIdleTimer = setTimeout(async () => {
    if (requestInFlight || currentAudio || !conversationMode) return;

    try {
      requestInFlight = true;

      const response = await fetch("/nudge", { method: "POST" });
      const data = await response.json();

      if (data.audio) {
        await playAudio(data.audio);
      }
    } catch (err) {
      console.error("Adult idle nudge failed:", err);
    } finally {
      requestInFlight = false;
      resetAdultIdleTimer();
    }
  }, 10000);
}

function startBodyAnimation() {
  if (bodyAnimationHandle) return;
  
  const bodyLoop = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];
  let loopIndex = 0;

  setBodyFrame(bodyFrames[bodyLoop[loopIndex]]);

  function loop() {
    loopIndex = (loopIndex + 1) % bodyLoop.length;
    setBodyFrame(bodyFrames[bodyLoop[loopIndex]]);

    const delay = bodySpeed + Math.random() * 10;
    bodyAnimationHandle = setTimeout(loop, delay);
  }

  loop();
}

function stopBodyAnimation() {
  if (bodyAnimationHandle) {
    clearTimeout(bodyAnimationHandle);
    bodyAnimationHandle = null;
  }

  setBodyFrame(idleBodyFrame);
}

function scheduleBlink() {
  if (blinkHandle) return;
  
  const nextBlink = 2000 + Math.random() * 5000; // more natural spacing
  
  blinkHandle = setTimeout(() => {
    if (!currentAudio && blinkEnabled) {
      setFaceFrame("/static/frames/talk_blink.png");

      const closeTime = 80 + Math.random() * 40;   // fast close
      const openTime = 100 + Math.random() * 80;   // slower open

      setTimeout(() => {
        if (!currentAudio) {  
          setFaceFrame(idleFaceFrame);
        }

        setTimeout(() => {
          blinkHandle = null;
          scheduleBlink();
        }, openTime);

      }, closeTime);

    } else {
      blinkHandle = null;
      scheduleBlink();
    }
  }, nextBlink);
}

function stopBlinking() {
  if (blinkHandle) {
    clearTimeout(blinkHandle);
    blinkHandle = null;
  }
}

function stopLipSyncAnimation() {
  if (lipSyncHandle) {
    cancelAnimationFrame(lipSyncHandle);
    lipSyncHandle = null;
  }

  if (playbackSource) {
    try {
      playbackSource.disconnect();
    } catch (e) {}
    playbackSource = null;
  }

  if (playbackAnalyser) {
    try {
      playbackAnalyser.disconnect();
    } catch (e) {}
    playbackAnalyser = null;
  }

  if (playbackAudioContext) {
    try {
      playbackAudioContext.close();
    } catch (e) {}
    playbackAudioContext = null;
  }

  playbackDataArray = null;
  setFaceFrame(idleFaceFrame);
}

async function startLipSyncAnimation(audioElement) {
  if (!avatarFramesReady) return;

  smoothedFrame = 0;

  playbackAudioContext = new AudioContext();
  playbackAnalyser = playbackAudioContext.createAnalyser();
  playbackAnalyser.fftSize = 1024;
  playbackAnalyser.smoothingTimeConstant = 0.88;

  playbackSource = playbackAudioContext.createMediaElementSource(audioElement);
  playbackSource.connect(playbackAnalyser);
  playbackAnalyser.connect(playbackAudioContext.destination);

  playbackDataArray = new Uint8Array(playbackAnalyser.fftSize);

  if (playbackAudioContext.state === "suspended") {
    await playbackAudioContext.resume();
  }

  function loop() {
    if (!currentAudio || !playbackAnalyser || !playbackDataArray) {
      lipSyncHandle = null;
      return;
    }

    playbackAnalyser.getByteTimeDomainData(playbackDataArray);

    let sum = 0;
    for (let i = 0; i < playbackDataArray.length; i++) {
      const v = (playbackDataArray[i] - 128) / 128;
      sum += v * v;
    }

    const rms = Math.sqrt(sum / playbackDataArray.length);

    const targetFrame = Math.min(
      talkFrames.length - 1,
      Math.floor(Math.pow(rms * 12, 1.6))
    );

    const diff = targetFrame - smoothedFrame;

    if (diff > 0.8) smoothedFrame += 1.2;
    else if (diff < -1.2) smoothedFrame -= 1.2;
    else smoothedFrame = targetFrame;

    const frameIndex = Math.max(
      0,
      Math.min(talkFrames.length - 1, Math.floor(smoothedFrame))
    );

    setFaceFrame(talkFrames[frameIndex]);
    lipSyncHandle = requestAnimationFrame(loop);
  }

  setFaceFrame(talkFrames[0]);
  lipSyncHandle = requestAnimationFrame(loop);
}

/* UI STATE */

function setState(state, text = "") {
  face.classList.remove("listening", "speaking");
  mouth.className = "mouth";

  if (state === "idle") {
    statusEl.textContent = "IDLE";
    mouth.classList.add("idle-mouth");
  } else if (state === "listening") {
    statusEl.textContent = "LISTENING";
    face.classList.add("listening");
    mouth.classList.add("listening-mouth");
  } else if (state === "speaking") {
    statusEl.textContent = "SPEAKING";
    face.classList.add("speaking");
    mouth.classList.add("speaking-mouth");
  } else if (state === "thinking") {
    statusEl.textContent = "THINKING";
    mouth.classList.add("idle-mouth");
  } else if (state === "waiting") {
    statusEl.textContent = "WAITING";
    mouth.classList.add("idle-mouth");
  } else if (state === "error") {
    statusEl.textContent = "ERROR";
    mouth.classList.add("idle-mouth");
  }

  if (speechEl && text) {
    speechEl.textContent = text;
  }
}

function setConversationButtonState() {
  if (!micReady) {
    talkBtn.textContent = "Enable Microphone";
    return;
  }

  talkBtn.textContent = conversationMode ? "Stop Conversation" : "Start Conversation";
  talkBtn.title =
    'Say "I want a conversation with you" to start, or "I have now finished my conversation with you" to stop.';
}

function captureCurrentFrameBase64() {
  if (!cameraVideo || !cameraVideo.videoWidth || !cameraVideo.videoHeight) {
    return "";
  }

  const canvas = document.createElement("canvas");
  const maxWidth = 1280;

  const videoWidth = cameraVideo.videoWidth;
  const videoHeight = cameraVideo.videoHeight;

  const scale = Math.min(1, maxWidth / videoWidth );
  canvas.width = Math.round(videoWidth * scale);
  canvas.height = Math.round(videoHeight * scale);

  const ctx = canvas.getContext("2d");
  ctx.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
}

function startImageCaptureLoop() {
  stopImageCaptureLoop();

  imageCaptureHandle = setInterval(() => {
    if (!cameraVideo || !cameraVideo.srcObject) return;

    const img = captureCurrentFrameBase64();
    if (img && img.length > 1000) {
      latestImageBase64 = img;
    }
  }, 1000);
}

function stopImageCaptureLoop() {
  if (imageCaptureHandle) {
    clearInterval(imageCaptureHandle);
    imageCaptureHandle = null;
  }
}

async function ensureCamera() {
  if (cameraVideo && cameraVideo.srcObject) {
    return cameraVideo.srcObject;
  }

  const cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  cameraVideo.srcObject = cameraStream;
  await cameraVideo.play();
  cameraVideo.style.display = "block";
  cameraVideo.style.visibility = "visible";
  cameraVideo.style.opacity = "1";
  cameraVideo.style.background = "transparent";
  console.log("VIDEO SIZE:", cameraVideo.videoWidth, cameraVideo.videoHeight);
  startImageCaptureLoop();

  return cameraStream;
}



/* MIC CONTROL */

function setMicEnabled(enabled) {
  if (!stream) return;

  stream.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

function setActiveModelButton(modelKey) {
  [modelIntellectualBtn, modelLightBtn, modelAdultBtn].forEach((btn) => {
    if (btn) btn.classList.remove("active");
  });

  if (modelKey === "intellectual" && modelIntellectualBtn) {
    modelIntellectualBtn.classList.add("active");
  } else if (modelKey === "light" && modelLightBtn) {
    modelLightBtn.classList.add("active");
  } else if (modelKey === "adult" && modelAdultBtn) {
    modelAdultBtn.classList.add("active");
  }
}

function setModelButtonsDisabled(disabled) {
  [modelIntellectualBtn, modelLightBtn, modelAdultBtn].forEach((btn) => {
    if (btn) btn.disabled = disabled;
  });
}

async function loadCurrentModel() {
  try {
    const response = await fetch("/models");
    const data = await response.json();

    if (data.current_model_key) {
      currentModelKey = data.current_model_key;
      setActiveModelButton(data.current_model_key);
    }
  } catch (err) {
    console.error("Failed to load current model:", err);
  }
}

async function switchModel(modelKey) {
  if (modelSwitchInFlight || requestInFlight || replyCooldown) return;

  modelSwitchInFlight = true;
  setModelButtonsDisabled(true);

  try {
    stopConversationMode(false);

    setState("waiting", "Switching model...");
    if (userTextEl) {
      userTextEl.textContent = "Switching model and clearing conversation...";
    }

    const response = await fetch("/set_model", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: modelKey })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Model switch failed");
    }

    setActiveModelButton(modelKey);
    currentModelKey = modelKey;
    
    if (modelKey === "light" || modelKey === "adult") {
      await ensureCamera();
    } else {

      stopImageCaptureLoop();
      latestImageBase64 = "";

      if (cameraVideo && cameraVideo.srcObject) {
        cameraVideo.srcObject.getTracks().forEach(track => track.stop());
        cameraVideo.srcObject = null;
      }
    }
    
    setState("idle", "Ready.");


    if (userTextEl) {
      userTextEl.textContent = "Model switched. Click Start Conversation.";
    }
  } catch (err) {
    console.error("Failed to switch model:", err);
    setState("error", "Model switch failed.");
    if (userTextEl) {
      userTextEl.textContent = "Model switch failed.";
    }
  } finally {
    modelSwitchInFlight = false;
    setModelButtonsDisabled(false);
  }
}

/* RECORDING */

function getRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm",
    ""
  ];

  for (const type of candidates) {
    if (!type) return "";
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return "";
}

function getFileExtensionFromMimeType(mimeType) {
  if (!mimeType) return ".webm";
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("ogg")) return ".ogg";
  return ".webm";
}

async function ensureMic() {
  if (stream) {
    micReady = true;
    return stream;
  }

  setState("waiting", "Please allow microphone access...");
  if (userTextEl) {
    userTextEl.textContent = "Waiting for microphone permission...";
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.85;
  source.connect(analyser);

  dataArray = new Uint8Array(analyser.fftSize);

  micReady = true;
  setState("idle", "Microphone ready.");
  if (userTextEl) {
    userTextEl.textContent = "Click Start Conversation.";
  }
  setConversationButtonState();
  return stream;
}

function currentVolume() {
  if (!analyser || !dataArray) return 0;

  analyser.getByteTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sum += v * v;
  }

  return Math.sqrt(sum / dataArray.length);
}

function startRecording() {
  if (isRecording || !stream || replyCooldown || requestInFlight || currentAudio) return;

  audioChunks = [];

  const mimeType = getRecorderMimeType();

  if (mimeType) {
    mediaRecorder = new MediaRecorder(stream, { mimeType });
  } else {
    mediaRecorder = new MediaRecorder(stream);
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = processRecording;

  mediaRecorder.start();
  isRecording = true;
  recordingStartedAt = Date.now();
  silenceFrames = 0;

  setState("listening", "Listening...");
  if (userTextEl) {
    userTextEl.textContent = "Listening...";
  }
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;

  isRecording = false;
  mediaRecorder.stop();

  setState("thinking", "Processing...");
  if (userTextEl) {
    userTextEl.textContent = "Processing...";
  }
}

async function processRecording() {
  if (requestInFlight || replyCooldown || currentAudio) {
    return;
  }

  requestInFlight = true;

  const mimeType = mediaRecorder && mediaRecorder.mimeType ? mediaRecorder.mimeType : "audio/webm";
  const extension = getFileExtensionFromMimeType(mimeType);

  const blob = new Blob(audioChunks, { type: mimeType });

  if (blob.size < 2000) {
    requestInFlight = false;

    if (conversationMode && !replyCooldown) {
      setState("idle", "Conversation mode on.");
      if (userTextEl) {
        userTextEl.textContent = "Waiting for speech...";
      }
    } else {
      setState("idle", "Recording too short.");
      if (userTextEl) {
        userTextEl.textContent = "Recording too short. Try again.";
      }
    }
    return;
  }

  const formData = new FormData();
  formData.append("audio", blob, `input_audio${extension}`);

  try {
    // FIRST CALL → audio only
  let response = await fetch("/talk", {
    method: "POST",
   body: formData
  });

  let data = await response.json();

  let transcript = (data.transcript || "").trim();
  let reply = (data.reply || "").trim();
  let audio = data.audio;
  let command = data.command || "none";

  // Decide if user asked for vision
  const t = transcript.toLowerCase();
  
  const wantsVision =
    t.includes("see") ||
    t.includes("look") ||
    t.includes("read") ||
    t.includes("screen") ||
    t.includes("image") ||
    t.includes("photo") ||
    t.includes("picture") ||
    t.includes("wear") ||
    t.includes("clothes") ||
    t.includes("mood") ||
    t.includes("wearing") ||
    t.includes("holding") ||
    t.includes("this") ||
    t.includes("that");


  // SECOND CALL → only if needed
  if (
    (currentModelKey === "light" || currentModelKey === "adult") && wantsVision
  ) {
    if (!latestImageBase64 || latestImageBase64.length <= 1000) {
      statusEl.textContent = "WAITING";
      speechEl.textContent = "No stored image yet";
    } else {
      statusEl.textContent = "REQUESTING IMAGE";
      speechEl.textContent = "IMAGE CAPTURED";

      const formDataVision = new FormData();
      formDataVision.append("image_base64", latestImageBase64);
      formDataVision.append("transcript", transcript);

      response = await fetch("/talk", {
        method: "POST",
        body: formDataVision
      });

      data = await response.json();

      transcript = (data.transcript || "").trim();
      reply = (data.reply || "").trim();
      audio = data.audio;
      command = data.command || "none";
    }
  }

    if (userTextEl) {
      userTextEl.textContent = transcript || "[empty transcript]";
    }
    if (speechEl) {
      speechEl.textContent = reply || "[empty reply]";
    }

    if (!audio) {
      requestInFlight = false;

      if (conversationMode) {
        setState("idle", "Conversation mode on.");
        if (userTextEl) {
          userTextEl.textContent = "Waiting for speech...";
        }
      } else {
        setState("idle", "Ready.");
        if (userTextEl) {
          userTextEl.textContent = "Click Start Conversation.";
        }
      }
      return;
    }

    replyCooldown = true;
    stopConversationMonitoring();
    setMicEnabled(false);

    await playAudio(audio, command);
    resetAdultIdleTimer();

  } catch (err) {
    console.error("Fetch /talk failed:", err);
    requestInFlight = false;
    replyCooldown = false;
    setMicEnabled(true);
    stopLipSyncAnimation();
    setState("error", "Request failed.");
    if (userTextEl) {
      userTextEl.textContent = "Request failed.";
    }
  }
}

/* AUDIO PLAYBACK */

function stopConversationMode(showReadyText = true) {
  clearAdultIdleTimer();
  conversationMode = false;
  stopConversationMonitoring();

  if (isRecording && mediaRecorder) {
    try {
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    } catch (e) {
      console.error("Failed to stop recorder:", e);
    }
    isRecording = false;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }

  requestInFlight = false;
  replyCooldown = false;
  setMicEnabled(true);
  stopLipSyncAnimation();
  setConversationButtonState();

  if (showReadyText) {
    setState("idle", "Conversation stopped.");
    if (userTextEl) {
      userTextEl.textContent = "Click Start Conversation.";
    }
  }
  clearAdultIdleTimer();
}

function startConversationMode() {
  conversationMode = true;
  setConversationButtonState();
  setState("idle", "Conversation mode on.");
  if (userTextEl) {
    userTextEl.textContent = "Waiting for speech...";
  }
  startConversationMonitoring();
  resetAdultIdleTimer();
}

function playAudio(url, command = "none") {
  return new Promise((resolve) => {
    if (isRecording && mediaRecorder) {
      try {
        mediaRecorder.onstop = null;
        mediaRecorder.stop();
      } catch (e) {
        console.error("Failed to stop recorder before playback:", e);
      }
      isRecording = false;
    }

    currentAudio = new Audio(url);
    currentAudio.preload = "auto";

    setState("speaking");

    const finishPlayback = () => {
      requestInFlight = false;
      replyCooldown = false;
      stopLipSyncAnimation();
      setMicEnabled(true);
      bodySpeed = 180;
      blinkEnabled = true;

      if (command === "conversation_on") {
        startConversationMode();
      } else if (command === "conversation_off") {
        stopConversationMode(false);
        setState("idle", "Conversation stopped.");
        if (userTextEl) {
          userTextEl.textContent = 'Say "I want a conversation with you" after starting again.';
        }
      } else if (conversationMode) {
        setState("idle", "Conversation mode on.");
        if (userTextEl) {
          userTextEl.textContent = "Waiting for speech...";
        }
        startConversationMonitoring();
      } else {
        setState("idle", "Ready.");
        if (userTextEl) {
          userTextEl.textContent = "Click Start Conversation.";
        }
      }

      currentAudio = null;
      resolve();
    };

    currentAudio.onended = finishPlayback;

    currentAudio.onerror = () => {
      setState("error", "Audio playback failed.");
      finishPlayback();
    };

    currentAudio.onplay = async () => {
      blinkEnabled = false;
      bodySpeed = 120;    
      startBodyAnimation();
      try {
        await startLipSyncAnimation(currentAudio);
      } catch (e) {
        console.error("Lip sync start failed:", e);
      }
    };

    currentAudio.play().catch((err) => {
      console.error("Audio play failed:", err);
      currentAudio.onerror();
    });
  });
}

/* CONVERSATION MONITORING */

function stopConversationMonitoring() {
  if (monitorHandle) {
    cancelAnimationFrame(monitorHandle);
    monitorHandle = null;
  }

  speechFrames = 0;
  silenceFrames = 0;
}

function startConversationMonitoring() {
  stopConversationMonitoring();

  function loop() {
    if (!conversationMode) {
      monitorHandle = null;
      return;
    }

    if (replyCooldown || requestInFlight || currentAudio) {
      monitorHandle = requestAnimationFrame(loop);
      return;
    }

    const volume = currentVolume();

    const startThreshold = 0.030;
    const stopThreshold = 0.012;

    if (!isRecording) {
      if (volume > startThreshold) {
        speechFrames++;
      } else {
        speechFrames = 0;
      }

      if (speechFrames >= 4) {
        speechFrames = 0;
        startRecording();
      }
    } else {
      const elapsed = Date.now() - recordingStartedAt;

      if (volume < stopThreshold) {
        silenceFrames++;
      } else {
        silenceFrames = 0;
      }

      if (elapsed > 1400 && silenceFrames >= 24) {
        silenceFrames = 0;
        stopRecording();
      }
    }

    monitorHandle = requestAnimationFrame(loop);
  }

  monitorHandle = requestAnimationFrame(loop);
}

/* INIT */

preloadAvatarFrames();
setFaceFrame(idleFaceFrame);
setBodyFrame(idleBodyFrame);
startBodyAnimation();
scheduleBlink();

setState("idle", "Click to enable microphone.");
if (userTextEl) {
  userTextEl.textContent = 'First click enables the mic. Then click Start Conversation. Say "I have now finished my conversation with you" to stop.';
}
setConversationButtonState();
loadCurrentModel();

/* BUTTON */

talkBtn.addEventListener("click", async (e) => {
  e.preventDefault();

  // 1. Ensure mic is ready
  if (!micReady) {
    try {
      await ensureMic();

      if (currentModelKey === "light" || currentModelKey === "adult") {
        await ensureCamera();
      }
    } catch (err) {
      console.error("Mic error:", err);
      setState("error", "Microphone access failed.");
      if (userTextEl) {
        userTextEl.textContent = "Microphone access failed.";
      }
    }
    return;
  }

  // 2. Block if anything else is happening
  if (replyCooldown || requestInFlight || modelSwitchInFlight) {
    return;
  }

  // 3. Toggle conversation mode
  if (conversationMode) {
    stopConversationMode();
    fetch("/cleanup_tts", { method: "POST" }).catch(() => {});;
    setState("idle", "Conversation stopped.");
    if (userTextEl) {
      userTextEl.textContent = "Click Start Conversation.";
    }

  } else {
    startConversationMode();

    setState("idle", "Conversation mode on.");
    if (userTextEl) {
      userTextEl.textContent = "Waiting for speech...";
    }
  }
});

if (modelIntellectualBtn) {
  modelIntellectualBtn.addEventListener("click", async () => {
    await switchModel("intellectual");
  });
}

if (modelLightBtn) {
  modelLightBtn.addEventListener("click", async () => {
    await switchModel("light");
  });
}

if (modelAdultBtn) {
  modelAdultBtn.addEventListener("click", async () => {
    await switchModel("adult");
  });
}
